/**
 * ChatRuntime — owns the LIVE pi agent sessions behind the Chats UI.
 *
 * Each chat row in the DB corresponds to at most one `LiveChat` here: a cloned
 * `Workspace`, a `SessionManager` + `AgentSession`, a `StallWatcher`, and a
 * `busy` flag that gates one-in-flight-prompt-per-chat. The session is lazily
 * booted on the first prompt, then kept hot so subsequent prompts reuse it
 * (full multi-turn context, no re-clone).
 *
 * Boot is resumable: if the chat row already has `workspace_path` + `session_dir`
 * (i.e. it was used before, possibly across a server restart) we re-wrap the
 * existing clone and `SessionManager.open(...)` the JSONL — the conversation
 * picks up where it left off.
 *
 * Events from `session.subscribe()` are translated into a uniform
 * `ChatStreamEvent` shape and emitted on a per-chat `EventEmitter` so the SSE
 * route can pipe them to the browser as they happen (token deltas, tool
 * start/end, turn end, errors).
 *
 * The runtime is a process-wide singleton (instantiated once in `serve.ts`).
 * It is NOT a queue: a chat runs its prompt inline on the request that triggered
 * it, and `busy` prevents a second concurrent prompt on the same chat. That
 * matches the interactive UX — the user types, the agent answers, repeat.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  DefaultResourceLoader,
  createAgentSession,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai/compat";
import type { NoodleConfig, Profile } from "../config/schema.js";
import type { ThinkingLevelT } from "../config/schema.js";
import type { AuthProvider } from "../github/auth-provider.js";
import type { ChatRow } from "../server/chat-store.js";
import { Workspace, cloneUrlFor } from "./workspace.js";
import { installSkills } from "../util/paths.js";
import { buildSettingsManager } from "./pi-settings.js";
import { throttleForRpm, throttleExtensionFactory } from "./throttle.js";
import { StallWatcher } from "./stall.js";
import { registerCustomProviders } from "../profiles/custom-providers.js";
import { log } from "../util/log.js";

/**
 * Uniform event shape the SSE route ships to the browser. Translated from pi's
 * own event union (see `subscribeForLogging` in run.ts for the proven set) so
 * the frontend doesn't need to know pi's internals.
 */
export type ChatStreamEvent =
  | { type: "turn_start" }
  | { type: "delta"; text: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_end"; name: string; ok: boolean; text: string }
  | { type: "turn_end"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };

/** What the runtime needs from serve.ts to boot a session. */
export interface ChatRuntimeDeps {
  config: NoodleConfig;
  authProvider: AuthProvider;
  /** Inject a fake session factory in tests. */
  createAgentSessionFn?: typeof createAgentSession;
}

interface LiveChat {
  workspace: Workspace;
  sessionManager: SessionManager;
  session: AgentSession;
  watcher: StallWatcher;
  unsubStall: (() => void) | undefined;
  unsubEvents: (() => void) | undefined;
  /** True while a prompt is in flight. Enforced one-at-a-time per chat. */
  busy: boolean;
}

export class ChatRuntime {
  private readonly live = new Map<number, LiveChat>();
  private readonly deps: ChatRuntimeDeps;

  constructor(deps: ChatRuntimeDeps) {
    this.deps = deps;
  }

  /** True iff a prompt is currently running on this chat. */
  isBusy(chatId: number): boolean {
    return this.live.get(chatId)?.busy ?? false;
  }

  /** True iff the chat has a hot session booted. */
  isLive(chatId: number): boolean {
    return this.live.has(chatId);
  }

  /** Per-chat event stream. SSE route subscribes/unsubscribes around a turn. */
  events(chatId: number): EventEmitter {
    let ee = this.busByChat.get(chatId);
    if (!ee) {
      ee = new EventEmitter();
      this.busByChat.set(chatId, ee);
    }
    return ee;
  }
  private readonly busByChat = new Map<number, EventEmitter>();

  /**
   * Lazily boot the workspace + session for a chat (clone, switch branch,
   * install skills, create/open the pi session). Idempotent — a second call
   * returns the already-live session. Throws if the chat is marked busy.
   *
   * Returns the live handle. Caller is responsible for setting busy around
   * `session.prompt()` via `run()`.
   */
  async boot(chat: ChatRow): Promise<LiveChat> {
    const existing = this.live.get(chat.id);
    if (existing) return existing;

    const { config } = this.deps;

    // 1. Workspace: re-wrap an existing clone if the path is set + on disk,
    //    otherwise clone fresh and switch branch as needed.
    const { workspace, clonedFresh } = await this.bootWorkspace(chat);

    // 2. Profile + model resolution (same path as run.ts).
    const profile = this.resolveProfileFor(chat);
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const providerKeyMap = registerCustomProviders(config, modelRegistry);
    // Provider key = profile name (see custom-providers.ts). Fall back to the
    // name itself if registration somehow skipped this profile.
    const providerKey = providerKeyMap.get(profile.name) ?? profile.name;
    let model: Model<Api> | undefined;
    try {
      model = modelRegistry.find(providerKey, profile.model);
    } catch (e) {
      throw new Error(
        `Could not resolve model "${providerKey}/${profile.model}". (${(e as Error).message})`,
      );
    }
    if (!model) {
      throw new Error(`Could not resolve model "${providerKey}/${profile.model}".`);
    }

    // 3. Skills + resource loader (same as a normal run).
    if (clonedFresh) await installSkills(workspace.path);
    const settingsManager = buildSettingsManager(
      workspace.path,
      join(workspace.path, ".noodle-agent"),
      profile,
    );
    const throttle = throttleForRpm(profile.api_rpm);
    const loader = new DefaultResourceLoader({
      cwd: workspace.path,
      agentDir: join(workspace.path, ".noodle-agent"),
      settingsManager,
      ...(throttle
        ? { extensionFactories: [throttleExtensionFactory(throttle, `${profile.name}/${profile.model}`)] }
        : {}),
    });
    await loader.reload();

    // 4. SessionManager: open an existing JSONL if the chat has a session_dir,
    //    else create a fresh one.
    const sessionDir = chat.session_dir ?? sessionsDirFor(`chat-${chat.id}`);
    let sessionManager: SessionManager;
    if (chat.session_dir && existsSync(join(chat.session_dir, "session.jsonl"))) {
      sessionManager = SessionManager.open(
        join(chat.session_dir, "session.jsonl"),
        sessionDir,
        workspace.path,
      );
      log.info({ chatId: chat.id, sessionDir }, "resumed chat session from disk");
    } else {
      sessionManager = SessionManager.create(workspace.path, sessionDir);
    }

    // 5. Create the pi session. No custom tools in chat mode (no GitHub issue
    //    to comment on) — the agent uses its built-in read/edit/bash/grep set.
    //    The thinking level is the chat's per-chat override if set, else the
    //    profile's value. (Takes effect on next boot; mid-session edits don't
    //    reconfigure a live pi session.)
    const create = this.deps.createAgentSessionFn ?? createAgentSession;
    const { session } = await create({
      cwd: workspace.path,
      model,
      authStorage,
      modelRegistry,
      settingsManager,
      resourceLoader: loader,
      // Per-chat override wins; fall back to the profile's setting. The chat
      // row is validated against the enum on write, so the cast is safe.
      thinkingLevel: (chat.thinking_level as ThinkingLevelT | undefined) || profile.thinking_level,
      tools: profile.tools,
      sessionManager,
    });

    // 6. Stall watcher — same guard as a normal run, so a hung chat auto-aborts.
    // Timeouts are read from the shared `config` (live-overlayed by serve.ts
    // from the settings store), so settings changes take effect on next boot.
    const idleMs = (config.run?.stall_timeout_minutes ?? 0) * 60_000;
    const toolMs = (config.run?.tool_stall_minutes ?? 0) * 60_000;
    const watcher = new StallWatcher(session, {
      idleTimeoutMs: idleMs,
      toolTimeoutMs: toolMs,
    });
    const unsubStall = watcher.attach();

    // 7. Subscribe to pi events → translate → emit on the per-chat bus. The SSE
    //    route listens on the same bus.
    const unsubEvents = attachEventBridge(session, this.events(chat.id));

    const live: LiveChat = {
      workspace,
      sessionManager,
      session,
      watcher,
      unsubStall,
      unsubEvents,
      busy: false,
    };
    this.live.set(chat.id, live);
    log.info({ chatId: chat.id, repo: chat.repo, branch: chat.branch }, "booted chat session");
    return live;
  }

  /**
   * Clone-or-rewrap step. Returns the workspace and whether it was freshly
   * cloned (skills only need to be installed on a fresh clone).
   */
  private async bootWorkspace(
    chat: ChatRow,
  ): Promise<{ workspace: Workspace; clonedFresh: boolean }> {
    if (chat.workspace_path && existsSync(chat.workspace_path)) {
      // Re-wrap existing clone — no re-clone, no skills reinstall. The branch
      // is whatever git left checked out from the prior run.
      return { workspace: Workspace.rewrap(chat.workspace_path), clonedFresh: false };
    }
    const { token } = await this.deps.authProvider.forRepo(chat.repo);
    if (!token) throw new Error(`No GitHub token for repo ${chat.repo}`);
    const workspace = await Workspace.clone(cloneUrlFor(chat.repo, token), `chat-${chat.id}`);
    // Branch switch: stay on the default branch as-is; otherwise check out the
    // chosen branch from origin.
    if (chat.branch && chat.branch !== chat.default_branch) {
      await workspace.checkoutRemote(chat.branch);
    }
    return { workspace, clonedFresh: true };
  }

  /** Resolve the profile for a chat: explicit pin → instance default. */
  private resolveProfileFor(chat: ChatRow): Profile & { name: string } {
    const { config } = this.deps;
    const name = chat.profile ?? config.default_profile;
    if (!name) throw new Error("No profile configured for this chat and no instance default.");
    const p = config.profiles[name];
    if (!p) throw new Error(`Profile "${name}" is not configured.`);
    return { name, ...p };
  }

  /**
   * Run one prompt on the chat's session. Sets `busy`, awaits `session.prompt`,
   * emits `done`/`error` (and `turn_end` with the final text) when finished,
   * and clears `busy`. Throws `BusyError` if the chat already has a prompt in
   * flight — the route translates that to HTTP 409.
   *
   * Returns the agent's final assistant text (the natural-language answer), so
   * the caller can persist it to the chat-message store. Streaming happens
   * concurrently via the events bus.
   */
  async run(chatId: number, text: string, chatRow?: ChatRow): Promise<string> {
    let live = this.live.get(chatId);
    if (!live) {
      if (!chatRow) throw new Error(`chat ${chatId} not booted and no chatRow provided for auto-boot`);
      live = await this.boot(chatRow);
    }
    if (live.busy) throw new BusyError(chatId);
    live.busy = true;
    const bus = this.events(chatId);
    try {
      await live.session.prompt(text);
      const sr = lastAssistantStopReason(live.session);
      if (sr.stopReason === "error") {
        const msg = sr.errorMessage ?? "agent run ended on error";
        bus.emit("event", { type: "error", message: msg } satisfies ChatStreamEvent);
        throw new Error(msg);
      }
      const finalText = extractLastAssistantText(live.session) ?? "";
      // Emit turn_end with the authoritative final text — covers the case where
      // the streamed message_end delta was empty or partial.
      bus.emit("event", { type: "turn_end", text: finalText } satisfies ChatStreamEvent);
      bus.emit("event", { type: "done" } satisfies ChatStreamEvent);
      return finalText;
    } catch (e) {
      // An abort from /cancel arrives here as a rejected prompt — surface it
      // as a done event so the client closes the stream cleanly, and return
      // whatever the agent managed to produce.
      if (isAbortError(e)) {
        const partial = extractLastAssistantText(live.session) ?? "";
        bus.emit("event", { type: "turn_end", text: partial } satisfies ChatStreamEvent);
        bus.emit("event", { type: "done" } satisfies ChatStreamEvent);
        return partial;
      }
      const msg = (e as Error).message ?? String(e);
      bus.emit("event", { type: "error", message: msg } satisfies ChatStreamEvent);
      throw e;
    } finally {
      live.busy = false;
    }
  }

  /** Abort the in-flight prompt (best-effort). No-op if the chat isn't running. */
  async abort(chatId: number): Promise<void> {
    const live = this.live.get(chatId);
    if (!live || !live.busy) return;
    log.info({ chatId }, "aborting chat prompt (operator cancel)");
    try {
      await live.session.abort();
    } catch (e) {
      log.warn({ err: e, chatId }, "session.abort() rejected during chat cancel");
    }
  }

  /**
   * Tear down a chat's live session + workspace and evict it from memory.
   * Best-effort — used by DELETE /api/chats/:id and on shutdown. The DB row is
   * the caller's responsibility; this only handles the in-process state +
   * temp dir.
   */
  async dispose(chatId: number): Promise<void> {
    const live = this.live.get(chatId);
    if (!live) return;
    try {
      live.unsubEvents?.();
    } catch { /* best-effort */ }
    try {
      live.unsubStall?.();
    } catch { /* best-effort */ }
    try {
      live.watcher.dispose();
    } catch { /* best-effort */ }
    try {
      await live.session.dispose?.();
    } catch { /* best-effort */ }
    try {
      await live.workspace.dispose();
    } catch { /* best-effort */ }
    this.live.delete(chatId);
    this.busByChat.delete(chatId);
    log.info({ chatId }, "disposed chat session + workspace");
  }

  /** Dispose ALL live chats. Called from serve.ts shutdown. Best-effort. */
  async disposeAll(): Promise<void> {
    const ids = [...this.live.keys()];
    await Promise.allSettled(ids.map((id) => this.dispose(id)));
  }
}

/** Thrown when a prompt is attempted on a chat that already has one in flight. */
export class BusyError extends Error {
  constructor(public readonly chatId: number) {
    super(`chat ${chatId} is busy`);
    this.name = "BusyError";
  }
}

/** Stable dir for a chat's persisted pi session. Mirrors run.ts:sessionsDirFor. */
function sessionsDirFor(id: string): string {
  const base = resolve(process.env.NOODLE_SESSIONS_DIR ?? "./sessions");
  const dir = join(base, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Bridge pi's session events into our uniform ChatStreamEvent shape on the
 * per-chat EventEmitter. Returns an unsubscribe. Mirrors the event set proven
 * in run.ts:subscribeForLogging (we add the streaming delta + tool args that
 * the log subscriber deliberately drops).
 */
function attachEventBridge(session: AgentSession, bus: EventEmitter): () => void {
  if (typeof session.subscribe !== "function") return () => {};
  let currentTurnText = "";
  const emit = (e: ChatStreamEvent) => bus.emit("event", e);
  const unsub = session.subscribe((event: unknown) => {
    const e = event as Record<string, unknown>;
    switch (e.type) {
      case "message_start": {
        const msg = e.message as { role?: string } | undefined;
        if (msg?.role === "assistant") {
          currentTurnText = "";
          emit({ type: "turn_start" });
        }
        break;
      }
      case "message_update": {
        // pi streams the partial assistant text on this event. The exact field
        // varies by pi version — fall back to the session's streamingMessage.
        const delta = (e as { text?: string }).text ?? streamingText(session);
        if (typeof delta === "string" && delta) {
          currentTurnText = delta;
          emit({ type: "delta", text: delta });
        }
        break;
      }
      case "message_end": {
        const msg = e.message as { role?: string } | undefined;
        if (msg?.role !== "assistant") break;
        const text = fullAssistantText(msg) || currentTurnText;
        emit({ type: "turn_end", text });
        break;
      }
      case "tool_execution_start":
        emit({
          type: "tool_start",
          name: String(e.toolName ?? "tool"),
          args: (e.args as Record<string, unknown>) ?? {},
        });
        break;
      case "tool_execution_end": {
        const ok = e.isError !== true;
        emit({
          type: "tool_end",
          name: String(e.toolName ?? "tool"),
          ok,
          text: truncate(extractToolResultText(e.result), 2000),
        });
        break;
      }
      default:
        // Drop turn_*, agent_start/end, compaction, retry events — the chat UI
        // cares about user-visible deltas + tool activity only.
        break;
    }
  });
  return () => {
    try {
      unsub();
    } catch { /* best-effort */ }
  };
}

/** Read the session's currently-streaming assistant text (pi version-tolerant). */
function streamingText(session: unknown): string {
  const s = session as {
    state?: { streamingMessage?: unknown };
    streamingMessage?: unknown;
  };
  const msg = s.state?.streamingMessage ?? s.streamingMessage;
  return fullAssistantText(msg);
}

/**
 * Coerce a pi message OR a raw content array into its concatenated text.
 * Tolerates both shapes: a full `{ role, content }` message, or just the
 * `content` array itself.
 */
function fullAssistantText(msgOrContent: unknown): string {
  if (typeof msgOrContent === "string") return msgOrContent;
  if (!msgOrContent || typeof msgOrContent !== "object") return "";
  const maybe = msgOrContent as { content?: unknown };
  const content = "content" in maybe ? maybe.content : msgOrContent;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && c.type === "text")
    .map((c) => String(c.text ?? ""))
    .join("");
}

/** Pull text out of a pi tool result (defensive — shapes vary across tools). */
function extractToolResultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const r = result as { content?: unknown; text?: string; output?: string; message?: string };
    if (typeof r.text === "string") return r.text;
    if (typeof r.output === "string") return r.output;
    if (typeof r.message === "string") return r.message;
    if (Array.isArray(r.content)) {
      return r.content
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && c.type === "text")
        .map((c) => String(c.text ?? ""))
        .join("\n");
    }
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

/** Read the stopReason (+errorMessage) of the last assistant message. */
function lastAssistantStopReason(
  session: unknown,
): { stopReason: string | undefined; errorMessage?: string } {
  const messages = (session as { messages?: unknown[] })?.messages;
  if (!Array.isArray(messages)) return { stopReason: undefined };
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
    if (m?.role !== "assistant") continue;
    return { stopReason: m.stopReason, errorMessage: m.errorMessage };
  }
  return { stopReason: undefined };
}

/**
 * Pull the last assistant text message out of a pi session's message history.
 * Walks in reverse, returns the first non-empty assistant text. Mirrors the
 * helper in run.ts but kept local so the runtime has no engine/run dep.
 */
function extractLastAssistantText(session: unknown): string | undefined {
  const messages = (session as { messages?: unknown[] })?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | undefined;
    if (m?.role !== "assistant") continue;
    const text = fullAssistantText(m.content);
    if (text) return text;
  }
  return undefined;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const name = e.name ?? "";
  const msg = e.message ?? "";
  return (
    name === "AbortError" ||
    /abort/i.test(name) ||
    /aborted/i.test(msg) ||
    /cancel/i.test(msg)
  );
}
