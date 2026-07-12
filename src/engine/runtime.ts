/**
 * Agent runtime abstraction.
 *
 * Noodle supports two interchangeable coding-agent engines behind one
 * interface: `pi` (the default, `@earendil-works/pi-coding-agent`) and
 * `opencode` (`@opencode-ai/sdk`). Both implement `AgentRuntime`; the rest of
 * the engine (`runJob`, `runCronJob`, the stall watcher, the run store) talks
 * to whichever runtime a run resolved to, through the normalized types here.
 *
 * The seam is deliberately small — Noodle only uses six things from a session:
 * `prompt()`, `subscribe()`, `abort()`, `dispose()`, `getSessionStats()`, and
 * the message history (for last-answer / stop-reason extraction). Everything
 * else (git, PR, comments, queue, labels, footer) is runtime-agnostic.
 *
 * ## Normalized events
 *
 * Each runtime emits its own native event shapes. Adapters translate them into
 * the `RuntimeEvent` union so the stall watcher and the log subscriber consume
 * one shape regardless of engine. Unknown native events map to `activity`,
 * which pokes the stall watcher without producing a log line.
 *
 * ## Selection precedence
 *
 * `selectRuntime()` resolves which engine a run uses, in this order:
 *   1. the command's or cron's `runtime` override (explicit per-trigger choice)
 *   2. the resolved profile's `runtime`
 *   3. `config.default_runtime`
 *
 * The runtime is recorded on the run row for the dashboard, then passed to
 * `runAgentLoop()`, which owns the restart loop + stall watcher + stats capture
 * shared by both `runJob` and `runCronJob`.
 */

import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { log } from "../util/log.js";
import type { Profile } from "../config/schema.js";
import type { NoodleConfig } from "../config/schema.js";
import { StallWatcher, StallTimeoutError, type StallBudgets } from "./stall.js";

/** The two supported agent engines. */
export type RuntimeName = "pi" | "opencode";

/**
 * Normalized agent event — one shape consumed by the stall watcher and the log
 * subscriber, regardless of which runtime produced it. Adapters translate their
 * native events into these via a pure mapper.
 *
 * `activity` is the catch-all: any event that signals "the agent is alive" but
 * doesn't map to a richer type. It pokes the stall watcher without a log line.
 */
export type RuntimeEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; willRetry?: boolean }
  | { type: "message_end"; role: string; text: string }
  | { type: "tool_start"; tool: string; args?: Record<string, unknown> }
  | { type: "tool_end"; tool: string; isError: boolean; output: string }
  | { type: "retry"; attempt: number; maxAttempts: number; error: string }
  | { type: "compaction"; phase: "start" | "end"; error?: string }
  | { type: "activity" };

/**
 * Run stats captured for the comment/PR footer: tokens, cost, timing, tool-call
 * + turn counts. Each runtime populates what it can; fields are optional so a
 * runtime that doesn't surface cost (e.g. a local model) just omits it.
 */
export interface RuntimeStats {
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost?: number;
  toolCalls?: number;
  assistantMessages?: number;
}

/**
 * Minimal message shape the answer/stop-reason extractors read. Both runtimes
 * expose their conversation as an array of these; the extractors walk it in
 * reverse for the last assistant text + the stop reason.
 */
export interface RuntimeMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * The session surface every runtime exposes. Mirrors the six pi-session methods
 * Noodle already calls (see run.ts) so the pi adapter is a thin wrapper. The
 * `messages` field lets `extractLastAssistantText` / `lastAssistantStopReason`
 * stay runtime-agnostic.
 */
export interface RuntimeSession {
  /** Send a prompt to the agent and await completion. Throws on failure. */
  prompt(text: string): Promise<void>;
  /** Subscribe to normalized events. Returns an unsubscribe function. */
  subscribe(fn: (e: RuntimeEvent) => void): () => void;
  /** Cleanly abort the in-flight prompt (called by the stall watcher). */
  abort(): Promise<void>;
  /** Release runtime resources. Optional — caller uses `?.`. */
  dispose?(): Promise<void>;
  /** Token/cost/turn usage for the footer. Optional — caller uses `?.`. */
  getSessionStats?(): RuntimeStats | undefined;
  /** Conversation history for answer + stop-reason extraction. */
  readonly messages?: ReadonlyArray<RuntimeMessage>;
}

/**
 * A runtime-neutral custom tool descriptor. `runJob` builds these (currently
 * just `comment_on_issue`); each runtime's adapter translates the descriptor
 * into its native tool format (pi's `defineTool`, OpenCode's tool registration).
 *
 * `parameters` is a plain JSON Schema (no typebox `Type.Object`) so it isn't
 * coupled to any runtime's schema builder. `execute` returns the tool's text
 * output on success and throws on failure (the adapter surfaces the error to
 * the model with `isError`).
 */
export interface RuntimeCustomTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<string>;
}

/**
 * A resolved profile: the profile's `name` plus its full config (provider,
 * model, tools, rate limits, runtime, …). Passed to a runtime so it can configure
 * its session without re-resolving from the config tree.
 */
export type ResolvedProfile = { name: string } & Profile;

/** Options passed to a runtime when booting (or resuming) a session. */
export interface RuntimeBootOptions {
  /** Workspace root — the runtime runs here. */
  cwd: string;
  /** Where the runtime may persist its session (survives workspace disposal). */
  sessionDir: string;
  /** Resolved profile (name + config). */
  profile: ResolvedProfile;
  /**
   * MCP server definitions resolved from the profile's `mcp_servers` name list
   * (serve mode reads from the McpServerStore; CLI/tests omit it). Only the
   * OpenCode runtime consumes this; pi runs ignore it. Keyed by server name.
   */
  resolvedMcpServers?: Record<string, import("../config/schema.js").McpServerDefinition>;
  /** Two stall budgets derived from `config.run.*`. */
  stallBudgets: StallBudgets;
  /** Per-run logger (run-scoped context already bound). */
  log_: typeof log;
  /**
   * Called once with each freshly-booted session, before it's returned to the
   * run loop. `runJob`/`runCronJob` use it to attach the log subscriber
   * (`subscribeForLogging`) without the runtime needing to know about logging.
   * Invoked for both the production boot/resume path and the test bootFn path.
   */
  onSession?: (session: RuntimeSession) => void;
  /** Runtime-custom tools (e.g. comment_on_issue for issue runs). Empty for cron. */
  customTools?: RuntimeCustomTool[];
  /**
   * Injected session factory for tests. When set, the runtime is bypassed —
   * the fake returns a bare `RuntimeSession` directly, `onSession` is invoked
   * on it, and `runAgentLoop` wraps it with a stall watcher. Production calls
   * leave this unset.
   */
  bootFn?: (opts: RuntimeBootOptions) => Promise<RuntimeSession>;
}

/** A booted session + its stall watcher, ready for `runAgentLoop`. */
export interface RuntimeSessionHandle {
  session: RuntimeSession;
  /** Persisted session file path (for restart). Undefined if the runtime doesn't persist. */
  sessionPath?: string;
  watcher: StallWatcher;
  unsubscribeStall: (() => void) | undefined;
}

/**
 * An agent runtime — the contract both `pi` and `opencode` implement.
 * `boot()` starts a fresh session; `resume()` reopens a persisted one (for the
 * restart loop). Both return a handle carrying the session, its stall watcher,
 * and the unsubscribe for the stall subscription.
 */
export interface AgentRuntime {
  readonly name: RuntimeName;
  boot(opts: RuntimeBootOptions): Promise<RuntimeSessionHandle>;
  resume(sessionPath: string, opts: RuntimeBootOptions): Promise<RuntimeSessionHandle>;
}

// --- restart-loop constants (shared by runJob + runCronJob) -----------------

/**
 * Session restart loop: when `session.prompt()` throws after a runtime's own
 * retry is exhausted, we reopen the SAME persisted session (full context
 * survives), create a fresh session, and try again. Flat 2-minute backoff
 * between each restart — enough for sustained provider throttling to clear.
 */
export const SESSION_RESTART_ATTEMPTS = 3;
export const SESSION_RESTART_DELAY_MS = 120_000; // 2 minutes
/**
 * Hard cap on total restarts across all reset cycles, so progress-based resets
 * can't loop forever on a provider that keeps failing after partial work.
 */
export const SESSION_RESTART_HARD_CAP = 9;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve which runtime a run uses. Precedence: explicit trigger override
 * (command/cron) → profile → config default. Returns the runtime name only —
 * the caller maps it to an `AgentRuntime` instance (via `runtimeForName`).
 *
 * Pure; safe to unit-test without any runtime loaded.
 */
export function resolveRuntimeName(
  config: NoodleConfig,
  profile: ResolvedProfile,
  triggerOverride?: string | null,
): RuntimeName {
  if (triggerOverride === "pi" || triggerOverride === "opencode") return triggerOverride;
  if (profile.runtime === "pi" || profile.runtime === "opencode") return profile.runtime;
  return config.default_runtime ?? "pi";
}

/**
 * Map a resolved runtime name to its `AgentRuntime` instance. The registry is
 * lazy (runtimes are imported on first use) so the OpenCode SDK is only loaded
 * when an opencode run actually happens — pi-only deployments pay no cost.
 *
 * Exported for run.ts/cron-run.ts; tests bypass this by injecting a fake
 * `runtime` directly via deps.
 */
export async function runtimeForName(name: RuntimeName): Promise<AgentRuntime> {
  if (name === "opencode") {
    const { OpenCodeRuntime } = await import("./runtimes/opencode.js");
    return OpenCodeRuntime;
  }
  const { PiRuntime } = await import("./runtimes/pi.js");
  return PiRuntime;
}

/**
 * Stable directory for a run's persisted session. Lives OUTSIDE the temp
 * workspace (which is rm'd on dispose) so the conversation survives for resume
 * and inspection. Read from `NOODLE_SESSIONS_DIR`, default `./sessions/<jobId>/`.
 */
export function sessionsDirFor(jobId: string): string {
  const base = resolve(process.env.NOODLE_SESSIONS_DIR ?? "./sessions");
  const dir = join(base, jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The shared agent run loop, extracted verbatim from the (formerly duplicated)
 * restart loops in `runJob` and `runCronJob`. Owns:
 *   - first-attempt boot + restart-on-failure (same persisted session)
 *   - stall-watcher attach/dispose around each attempt
 *   - progress-based restart-budget reset (a run making turns always gets 3 fresh)
 *   - the hard-cap guard against infinite restart cycles
 *   - stats capture before dispose
 *
 * On success returns the final session + its persisted path + wall-clock
 * duration. On failure throws the last error (after labelling a stall as
 * `StallTimeoutError` so the queue skips retrying it).
 *
 * `opts.bootFn` (when set) bypasses the runtime entirely — tests inject a fake
 * session factory here. Production leaves it unset and the runtime's `boot`/
 * `resume` are used.
 */
export async function runAgentLoop(
  runtime: AgentRuntime,
  opts: RuntimeBootOptions,
  prompt: string,
): Promise<{ session: RuntimeSession; sessionPath?: string; durationMs: number }> {
  const { log_: log_, stallBudgets } = opts;
  const { idleTimeoutMs, toolTimeoutMs } = stallBudgets;

  log_.info(
    { runtime: runtime.name, idleTimeoutMs: idleTimeoutMs || "off", toolTimeoutMs: toolTimeoutMs || "off" },
    "starting agent run",
  );
  const startedAt = Date.now();

  // First attempt: fresh session (real runtime or injected fake). `onSession`
  // (when set) is invoked on the freshly-booted session so the caller can attach
  // its log subscriber before the first prompt.
  let booted = opts.bootFn
    ? await toHandle(await opts.bootFn(opts), opts)
    : await bootWithHook(runtime, opts);
  let promptError: unknown = null;

  for (let attempt = 0, totalRestarts = 0; attempt <= SESSION_RESTART_ATTEMPTS; attempt++, totalRestarts++) {
    if (totalRestarts > SESSION_RESTART_HARD_CAP) {
      log_.warn({ totalRestarts }, "hit hard cap on total restarts — giving up");
      break;
    }
    const { session, watcher, unsubscribeStall } = booted;
    const turnsBefore = session.getSessionStats?.()?.assistantMessages ?? 0;
    try {
      await session.prompt(attempt === 0 ? prompt : "Continue. The previous attempt failed — pick up where you left off.");
    } catch (e) {
      watcher.dispose();
      unsubscribeStall?.();
      // A stall aborts the in-flight prompt; surface it as a typed error so the
      // queue doesn't retry (a stall won't recover on its own).
      if (watcher.didStall) {
        throw new StallTimeoutError(
          (watcher.activeBudget === "tool" ? toolTimeoutMs : idleTimeoutMs) || 0,
          watcher.activeBudget,
        );
      }
      promptError = e;
    }
    // Even when prompt() doesn't throw, the runtime may have resolved with an
    // error stop reason (retryable errors that exhausted internal retries can
    // resolve gracefully instead of throwing). Treat that as a failure too.
    if (!promptError) {
      const sr = lastAssistantStopReason(session);
      if (sr.stopReason === "error") {
        promptError = new Error(sr.errorMessage ?? "agent run ended on error (stopReason=error)");
      }
    }

    // Success — clean up and exit the loop.
    if (!promptError) {
      watcher.dispose();
      unsubscribeStall?.();
      break;
    }

    // Failure — dispose, optionally restart.
    watcher.dispose();
    unsubscribeStall?.();

    // If the agent completed new turns before failing, it made real progress.
    // Reset the restart counter so a run that's actively working always gets
    // 3 fresh restarts — instead of burning its budget on one bad stretch.
    const turnsAfter = session.getSessionStats?.()?.assistantMessages ?? 0;
    if (turnsAfter > turnsBefore) {
      log_.info({ turnsBefore, turnsAfter }, "agent made progress before failure — resetting restart budget");
      attempt = -1; // loop increments to 0 → 3 fresh attempts
    }

    if (attempt >= SESSION_RESTART_ATTEMPTS) break;

    const sessionPath = booted.sessionPath;
    try { await session.dispose?.(); } catch { /* best-effort */ }
    log_.warn(
      { err: (promptError as Error).message ?? String(promptError), restartAttempt: attempt + 2, maxRestarts: SESSION_RESTART_ATTEMPTS, delayMs: SESSION_RESTART_DELAY_MS },
      "session.prompt() failed — will restart with same session after backoff",
    );
    await sleep(SESSION_RESTART_DELAY_MS);
    // A runtime without session persistence (no sessionPath) can't resume —
    // boot fresh instead. pi always persists; OpenCode persists when it can.
    booted = sessionPath && !opts.bootFn
      ? await resumeWithHook(runtime, sessionPath, opts)
      : await bootWithHook(runtime, opts);
    log_.info({ restartAttempt: attempt + 2 }, "restarted session from saved context");
  }

  if (promptError) {
    throw promptError;
  }

  return {
    session: booted.session,
    sessionPath: booted.sessionPath,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Wrap a bare `RuntimeSession` (as returned by `opts.bootFn` in tests) into a
 * `RuntimeSessionHandle` with a stall watcher attached. Invokes `opts.onSession`
 * first so the caller's log subscriber is wired before the watcher. Mirrors what
 * a real runtime's `boot()` does internally.
 */
async function toHandle(session: RuntimeSession, opts: RuntimeBootOptions): Promise<RuntimeSessionHandle> {
  opts.onSession?.(session);
  const watcher = new StallWatcher(session, opts.stallBudgets);
  const unsubscribeStall = watcher.attach();
  return { session, watcher, unsubscribeStall };
}

/**
 * Boot via the runtime, then invoke `opts.onSession` on the fresh session so
 * the caller's log subscriber is attached before the run loop uses the handle.
 * Thin wrapper around `runtime.boot()` — keeps the onSession hook in one place.
 */
async function bootWithHook(runtime: AgentRuntime, opts: RuntimeBootOptions): Promise<RuntimeSessionHandle> {
  const handle = await runtime.boot(opts);
  opts.onSession?.(handle.session);
  return handle;
}

/** Resume via the runtime, then invoke `opts.onSession`. Sibling to `bootWithHook`. */
async function resumeWithHook(
  runtime: AgentRuntime,
  sessionPath: string,
  opts: RuntimeBootOptions,
): Promise<RuntimeSessionHandle> {
  const handle = await runtime.resume(sessionPath, opts);
  opts.onSession?.(handle.session);
  return handle;
}

/**
 * Read the `stopReason` (+ `errorMessage`, if any) of the LAST assistant message
 * in a runtime session. A turn that ended in an internal error is recorded as
 * `{ stopReason: "error", errorMessage: "..." }` — the run resolves normally but
 * the agent never reached a real conclusion, so we surface the failure instead
 * of posting an opening utterance as if it were a real answer.
 *
 * Runtime-agnostic: works against any `RuntimeSession.messages`. Returns
 * `{ stopReason: undefined }` when there are no assistant messages.
 *
 * Exported for unit testing and for `runJob`/`runCronJob`'s post-loop checks.
 */
export function lastAssistantStopReason(
  session: Pick<RuntimeSession, "messages"> | undefined | null,
): { stopReason: string | undefined; errorMessage?: string } {
  const messages = session?.messages;
  if (!Array.isArray(messages)) return { stopReason: undefined };
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    return { stopReason: m.stopReason, errorMessage: m.errorMessage };
  }
  return { stopReason: undefined };
}

/**
 * Pull the last assistant text message out of a runtime session's history. This
 * is the agent's actual answer — posted verbatim as the issue comment / PR body.
 * Only trustworthy when the run didn't end on an error (see
 * `lastAssistantStopReason`); an error-stopped run may have only an opening
 * utterance, not a real answer.
 *
 * Tolerant of both content shapes in use: a string, or an array of parts where
 * each part has `{ type: "text", text }`. Walks messages in reverse and returns
 * the first non-empty assistant text, or undefined.
 *
 * Runtime-agnostic: works against any `RuntimeSession.messages`.
 *
 * Exported for unit testing and for `runJob`/`runCronJob`'s post-loop extraction.
 */
export function extractLastAssistantText(
  session: Pick<RuntimeSession, "messages"> | undefined | null,
): string | undefined {
  const messages = session?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const text = textFromContent(m.content);
    if (text) return text;
  }
  return undefined;
}

/** Coerce a message `content` (string or array of parts) into plain text. */
function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((p) => (p as { type?: string })?.type === "text")
    .map((p) => (p as { text?: string }).text ?? "")
    .join("\n")
    .trim();
  return parts || undefined;
}
