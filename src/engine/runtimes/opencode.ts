/**
 * OpenCode runtime adapter — the alternative `AgentRuntime` implementation.
 *
 * Drives `@opencode-ai/sdk` behind the same runtime-neutral contract as
 * `PiRuntime` (see `../runtime.ts`). Owns everything OpenCode-specific:
 *   - building the OpenCode `Config` (opencode.json shape) from a Noodle profile
 *   - starting an in-process OpenCode server via `createOpencode()`
 *   - session creation/prompt/abort/messages via the SDK client
 *   - OpenCode's native `Event` (SSE) → normalized `RuntimeEvent` translation
 *   - `AssistantMessage` tokens/cost → `RuntimeStats`
 *   - MCP server wiring (profile.mcp_servers → config.mcp)
 *
 * Both runtimes share the same skills (`.agents/skills/`), prompts, git/PR/comment
 * machinery, and the `runAgentLoop` restart/stall loop — this adapter only owns
 * the agent-loop internals.
 *
 * ## Server lifecycle
 *
 * Each run boots its own in-process server (`createOpencode`) pointed at the
 * workspace `cwd`, so concurrent runs don't share state. The server + session
 * are torn down on `dispose()`. A run that needs to resume (restart loop) opens
 * the same session ID — OpenCode persists sessions on disk, keyed by ID.
 */

import { createOpencode } from "@opencode-ai/sdk";
import type { OpencodeClient, Config, Event as OcEvent } from "@opencode-ai/sdk";
import type { McpServerDefinition } from "../../config/schema.js";
import { StallWatcher } from "../stall.js";
import { log } from "../../util/log.js";
import type {
  AgentRuntime,
  RuntimeBootOptions,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionHandle,
  RuntimeStats,
  RuntimeMessage,
} from "../runtime.js";

/**
 * OpenCode runtime. One shared instance — each `boot()`/`resume()` starts its
 * own server + session, so there's no shared mutable state.
 */
export const OpenCodeRuntime: AgentRuntime = {
  name: "opencode",
  boot: (opts) => bootOpenCodeSession(opts),
  resume: (sessionPath, opts) => bootOpenCodeSession(opts, sessionPath),
};

/** The OpenCode agent name Noodle runs with (the built-in general agent). */
const OPENCODE_AGENT = "general";

/**
 * Boot (or resume) an OpenCode session. Builds the config from the profile,
 * starts an in-process server, creates a session, wires the event stream, and
 * returns the handle with the stall watcher attached.
 *
 * `resumeSessionId` (when set) skips session creation and reuses an existing
 * persisted session — OpenCode sessions survive across server restarts.
 */
async function bootOpenCodeSession(
  opts: RuntimeBootOptions,
  resumeSessionId?: string,
): Promise<RuntimeSessionHandle> {
  const { cwd, profile, stallBudgets, resolvedMcpServers } = opts;

  // --- build the OpenCode config from the resolved profile + MCP servers ----
  const config = profileToOpenCodeConfig(profile, resolvedMcpServers);

  // --- start an in-process server + client ---------------------------------
  const { client, server } = await createOpencode({ config });

  // --- create (or reuse) a session -----------------------------------------
  let sessionId = resumeSessionId;
  if (!sessionId) {
    const res = await client.session.create({ query: { directory: cwd } });
    sessionId = (res.data as { id?: string } | undefined)?.id;
    if (!sessionId) {
      server.close();
      throw new Error("OpenCode session.create returned no session id");
    }
  }

  // --- subscribe to the global event stream (filtered to this session) -----
  // The stream is an async generator over GlobalEvent; we translate each event
  // to a RuntimeEvent and fan it out to our subscribers. Only events for THIS
  // session (or session-agnostic events) are forwarded.
  const subscribers = new Set<(e: RuntimeEvent) => void>();
  const streamDone = startEventStream(client, sessionId, subscribers, opts.log_);

  // --- wrap as a RuntimeSession --------------------------------------------
  // The message snapshot is refreshed after each prompt completes (the SDK
  // fetches the full conversation on demand). Before the first prompt, empty.
  // `lastInfo` holds the most recent AssistantMessage (carrying tokens/cost) so
  // getSessionStats can report real usage to the footer.
  let lastMessages: RuntimeMessage[] = [];
  let lastInfo: {
    cost?: number;
    tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  } | undefined;

  const session: RuntimeSession = {
    prompt: async (text: string) => {
      const res = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text }],
          model: { providerID: profile.provider, modelID: profile.model },
          agent: OPENCODE_AGENT,
        },
      });
      // The prompt response carries { info: AssistantMessage, parts: Part[] }.
      // Extract the assistant's reply text from the text parts so the run loop's
      // `extractLastAssistantText` finds it on the message snapshot.
      const data = res.data as {
        info?: {
          role?: string;
          error?: { name?: string; data?: { message?: string } } | null;
          finish?: string;
          cost?: number;
          tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
        };
        parts?: Array<{ type: string; text?: string }>;
      } | undefined;
      const answerText = (data?.parts ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")
        .trim();
      const info = data?.info;
      lastInfo = info; // stash for getSessionStats
      // Refresh the full message snapshot (for stop-reason detection) and append
      // the assistant reply with its extracted text so the answer reaches the
      // issue comment / PR body.
      lastMessages = await fetchMessagesAsRuntime(client, sessionId);
      if (info) {
        lastMessages = [...lastMessages, {
          role: "assistant",
          content: answerText || undefined,
          stopReason: info.error ? "error" : info.finish,
          errorMessage: info.error?.data?.message ?? info.error?.name ?? undefined,
        }];
      }
    },
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    abort: () => client.session.abort({ path: { id: sessionId } }).then(() => undefined),
    dispose: async () => {
      streamDone.cancelled = true;
      try { await client.instance.dispose(); } catch { /* best-effort */ }
      server.close();
    },
    getSessionStats: () => statsFromLastInfo(lastInfo),
    get messages() {
      return lastMessages;
    },
  };

  const watcher = new StallWatcher(session, stallBudgets);
  const unsubscribeStall = watcher.attach();

  // Expose the session path (session ID) for the restart loop's resume path.
  return {
    session,
    sessionPath: sessionId,
    watcher,
    unsubscribeStall,
  };
}

// ---------------------------------------------------------------------------
// Prompt execution
// ---------------------------------------------------------------------------

/**
 * Send a prompt to the OpenCode session and await completion. Inlined into the
 * session closure in `bootOpenCodeSession` (it needs write access to the
 * message snapshot). Kept here as documentation of the prompt payload shape:
 *
 *   await client.session.prompt({
 *     path: { id: sessionId },
 *     body: {
 *       parts: [{ type: "text", text }],
 *       model: { providerID, modelID },
 *       agent: "general",
 *     },
 *   })
 *
 * The SDK blocks until the agent finishes its turn. Throws on provider/abort
 * error — the run loop's restart logic handles that.
 */

// ---------------------------------------------------------------------------
// Config translation: Noodle profile → OpenCode Config
// ---------------------------------------------------------------------------

/**
 * Build an OpenCode `Config` (the opencode.json shape) from a Noodle profile.
 *
 * - Provider/model: the profile's `provider`/`model` become the default model.
 *   Custom endpoints (base_url + api) register a custom provider with OpenCode.
 * - MCP servers: the profile's `mcp_servers` map directly into `config.mcp`.
 * - Tools: the profile's `tools` allowlist becomes `config.tools` (only enabled
 *   built-ins are exposed). OpenCode's built-in tool names differ slightly from
 *   pi's (e.g. `read`/`edit`/`write`/`bash`/`grep`/`ls`/`task`), so we pass them
 *   through as-is — mismatches are silently ignored by OpenCode.
 *
 *
 * `resolvedMcpServers` carries the full MCP server definitions resolved from
 * the profile's `mcp_servers` name list (serve mode reads from the McpServerStore).
 * Only consumed here; pi runs never call this function.
 *
 * Exported for unit testing.
 */
export function profileToOpenCodeConfig(
  profile: RuntimeBootOptions["profile"],
  resolvedMcpServers?: Record<string, McpServerDefinition>,
): Config {
  const config: Config = {
    model: `${profile.provider}/${profile.model}`,
    permission: {
      // Autonomous runs must not prompt — allow all tool categories.
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      external_directory: "allow",
      doom_loop: "allow",
    },
  };

  // Custom endpoint (Ollama/vLLM/proxy) → register as an OpenCode provider.
  if (profile.base_url && profile.api) {
    config.provider = {
      [profile.provider]: {
        api: openCodeApiFormat(profile.api),
        options: {
          baseURL: profile.base_url,
          ...(profile.api_key_env && process.env[profile.api_key_env]
            ? { apiKey: process.env[profile.api_key_env] }
            : {}),
        },
        ...(profile.model
          ? {
              models: {
                [profile.model]: {
                  id: profile.model,
                  ...(profile.context_window ? { limit: { context: profile.context_window, output: profile.max_tokens ?? 4096 } } : {}),
                  ...(profile.reasoning ? { reasoning: true } : {}),
                },
              },
            }
          : {}),
      },
    };
  }

  // MCP servers (OpenCode-only feature; pi ignores this field). The definitions
  // are resolved from the profile's `mcp_servers` name list by the serve-mode
  // worker before booting the runtime — passed in via `resolvedMcpServers`.
  if (resolvedMcpServers && Object.keys(resolvedMcpServers).length > 0) {
    config.mcp = {};
    for (const [name, srv] of Object.entries(resolvedMcpServers)) {
      // Noodle's schema distinguishes stdio (command-based) from sse/http
      // (URL-based). OpenCode uses "local" (stdio) vs "remote" (URL).
      if ((srv.type === "sse" || srv.type === "http") && srv.url) {
        config.mcp[name] = { type: "remote", url: srv.url };
      } else if (srv.command) {
        config.mcp[name] = {
          type: "local",
          command: [srv.command, ...srv.args],
          ...(srv.env ? { environment: srv.env } : {}),
        };
      }
    }
  }

  return config;
}

/**
 * Map Noodle's wire-protocol enum (pi-ai's `Api`) to OpenCode's `api` string.
 * OpenCode uses shorter names: "openai", "anthropic", "google", etc. Most
 * custom endpoints are OpenAI-compatible, so the default is "openai".
 */
function openCodeApiFormat(api: string): string {
  switch (api) {
    case "openai-completions":
    case "openai-responses":
    case "azure-openai-responses":
      return "openai";
    case "anthropic-messages":
      return "anthropic";
    case "google-generative-ai":
    case "google-vertex":
      return "google";
    case "mistral-conversations":
      return "mistral";
    case "bedrock-converse-stream":
      return "bedrock";
    default:
      return "openai";
  }
}

// ---------------------------------------------------------------------------
// Event translation: OpenCode Event → RuntimeEvent
// ---------------------------------------------------------------------------

/**
 * Start consuming the OpenCode global event stream (SSE via async generator).
 * Each event is translated to a `RuntimeEvent` and fanned out to subscribers.
 * Only events for `sessionId` (or session-agnostic events) are forwarded.
 *
 * Returns a handle with `cancelled` — setting it true stops the loop. The loop
 * also exits naturally when the generator ends (server close / dispose).
 *
 * Pure translation logic lives in `openCodeEventToRuntimeEvent` (unit-tested).
 */
function startEventStream(
  client: OpencodeClient,
  sessionId: string,
  subscribers: Set<(e: RuntimeEvent) => void>,
  log_: typeof log,
): { cancelled: boolean } {
  const state = { cancelled: false };
  void (async () => {
    try {
      const { stream } = await client.event.subscribe();
      for await (const ocEvent of stream) {
        if (state.cancelled) break;
        // The stream yields OpenCode `Event` directly. Filter to this session's
        // events; some (file.edited, etc.) have no sessionID — forward as pokes.
        const eventSessionId = sessionOf(ocEvent as OcEvent);
        if (eventSessionId && eventSessionId !== sessionId) continue;
        const mapped = openCodeEventToRuntimeEvent(ocEvent as OcEvent);
        for (const fn of subscribers) fn(mapped);
      }
    } catch (e) {
      if (!state.cancelled) {
        log_.warn({ err: (e as Error).message }, "OpenCode event stream ended unexpectedly");
      }
    }
  })();
  return state;
}

/** Extract the sessionID from an OpenCode event (varies by event type). */
function sessionOf(e: OcEvent): string | undefined {
  const p = (e as { properties?: Record<string, unknown> }).properties;
  if (!p) return undefined;
  return (p.sessionID as string | undefined) ??
    (p.info as { sessionID?: string } | undefined)?.sessionID ??
    undefined;
}

/**
 * PURE: translate an OpenCode `Event` into a normalized `RuntimeEvent`.
 * Exported for unit testing.
 *
 * Maps the event types Noodle cares about (logging + stall + error detection):
 *   session.status (busy)      → agent_start
 *   session.status (idle)      → agent_end
 *   session.status (retry)     → retry
 *   message.updated (assistant)→ message_end (with text extracted from parts)
 *   message.part.updated (tool)→ tool_start / tool_end (by ToolPart.state)
 *   message.part.updated (text)→ message_end (streaming text — pokes stall)
 *   session.compacted          → compaction (start)
 *   session.error              → activity (error surfaced via prompt() throw)
 *   everything else            → activity (stall-watcher poke)
 */
export function openCodeEventToRuntimeEvent(e: OcEvent): RuntimeEvent {
  switch (e.type) {
    case "session.status": {
      const status = (e as { properties: { status: { type: string; attempt?: number; message?: string } } }).properties.status;
      if (status.type === "busy") return { type: "agent_start" };
      if (status.type === "idle") return { type: "agent_end" };
      if (status.type === "retry") {
        return {
          type: "retry",
          attempt: status.attempt ?? 0,
          maxAttempts: 0,
          error: status.message ?? "retrying",
        };
      }
      return { type: "activity" };
    }

    case "session.idle":
      return { type: "agent_end" };

    case "session.compacted":
      return { type: "compaction", phase: "start" };

    case "message.part.updated": {
      const part = (e as { properties: { part: { type: string; tool?: string; state?: { status: string; output?: string; input?: Record<string, unknown> }; text?: string } } }).properties.part;
      if (part.type === "tool" && part.state) {
        const tool = part.tool ?? "?";
        if (part.state.status === "running" || part.state.status === "pending") {
          return { type: "tool_start", tool, args: part.state.input };
        }
        if (part.state.status === "completed" || part.state.status === "error") {
          return {
            type: "tool_end",
            tool,
            isError: part.state.status === "error",
            output: (part.state as { output?: string }).output ?? "",
          };
        }
      }
      // Text/reasoning/other part updates — treat as activity (stall poke).
      return { type: "activity" };
    }

    case "message.updated": {
      const info = (e as { properties: { info: { role?: string; error?: unknown } } }).properties.info;
      if (info.role === "assistant") {
        // Full assistant message — we can't cheaply extract text here (it lives
        // in parts, fetched separately), so emit a message_end with empty text.
        // The log subscriber skips empty text; the stall watcher still pokes.
        return { type: "message_end", role: "assistant", text: "" };
      }
      return { type: "activity" };
    }

    case "session.error":
      // The error also surfaces as a prompt() rejection — emit activity so the
      // stall watcher doesn't trip while prompt() unwinds.
      return { type: "activity" };

    default:
      return { type: "activity" };
  }
}

// ---------------------------------------------------------------------------
// Message + stats extraction
// ---------------------------------------------------------------------------

/**
 * Fetch the session's full message history and translate it into the
 * `RuntimeMessage[]` shape the run loop reads for answer/stop-reason extraction.
 *
 * OpenCode's `session.messages` returns `{ data: Message[] }`. Each
 * `AssistantMessage` carries role + error + finish; we synthesize `stopReason`
 * from `finish`/`error` so `lastAssistantStopReason` (runtime.ts) detects
 * error-stopped runs the same way it does for pi.
 *
 * Note: OpenCode keeps message text in separate `Part` objects, not on the
 * message itself, so `content` is left undefined here. The assistant's reply
 * text is extracted from the `session.prompt` response parts and appended to
 * the snapshot in the prompt closure (see `bootOpenCodeSession`).
 */
async function fetchMessagesAsRuntime(client: OpencodeClient, sessionId: string): Promise<RuntimeMessage[]> {
  const res = await client.session.messages({ path: { id: sessionId } });
  const messages = (res.data as unknown[] | undefined) ?? [];
  return messages.map((m) => {
    const msg = m as {
      role?: string;
      error?: { name?: string; data?: { message?: string } } | null;
      finish?: string;
    };
    const errored = !!msg.error;
    return {
      role: msg.role,
      stopReason: errored ? "error" : msg.finish,
      errorMessage: msg.error?.data?.message ?? msg.error?.name ?? undefined,
      content: undefined,
    } as RuntimeMessage;
  });
}

/**
 * Build `RuntimeStats` from the most recent OpenCode `AssistantMessage` (stashed
 * after each prompt). OpenCode carries tokens + cost natively, so we map them
 * directly — no pricing lookup needed. Returns undefined before the first
 * prompt completes (no data yet), same as a pi run that hasn't started.
 *
 * Token mapping: OpenCode reports input/output/reasoning + a cache object with
 * read/write. We sum input+reasoning as "input" (reasoning is input-side cost)
 * and surface cache read/write separately — matching the footer's pi shape.
 */
export function statsFromLastInfo(info: {
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
} | undefined): RuntimeStats | undefined {
  if (!info) return undefined;
  const t = info.tokens;
  if (!t) return undefined;
  const input = (t.input ?? 0) + (t.reasoning ?? 0);
  const output = t.output ?? 0;
  const cacheRead = t.cache?.read ?? 0;
  const cacheWrite = t.cache?.write ?? 0;
  return {
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
    },
    cost: info.cost,
    // OpenCode doesn't surface a turn/tool-call count on the message; the run
    // loop's turns counter falls back to counting assistant messages instead.
    toolCalls: undefined,
    assistantMessages: undefined,
  };
}
