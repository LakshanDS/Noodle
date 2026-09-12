import { EventEmitter } from "node:events";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { log } from "../util/log.js";

/**
 * Uniform event shape the run SSE route ships to the browser. Identical to
 * `ChatStreamEvent` (same pi events, same semantics) — aliased rather than
 * redefined so the two paths can't drift on two parallel unions. See
 * `attachEventBridge` in chat-runtime.ts for the pi → stream-event mapping.
 */
export type RunStreamEvent = import("./chat-runtime.js").ChatStreamEvent;

/**
 * Live registry of in-flight run sessions, keyed by job id ("job-19"). Mirrors
 * the ChatRuntime's `live` map but for queue-dispatched runs (issue/PR via
 * runJob, scheduler/trigger via runBackgroundJob).
 *
 * Two responsibilities:
 *
 * 1. **Cancel**: jobs run in-process (no child process to SIGTERM), so the
 *    only way to cancel a running job is to call `session.abort()` on its live
 *    pi session. The cancel endpoint (POST /api/runs/:id/cancel) looks up the
 *    session here and aborts it. Without this, cancel only marks the DB row
 *    failed — the agent keeps running until it finishes on its own.
 *
 * 2. **Streaming**: each live run also owns a per-job `EventEmitter` bus. The
 *    run subscribes the session's pi events to it (via `attachEventBridge`),
 *    and the SSE route (GET /api/runs/:id/stream) fans the events out to the
 *    browser as they happen — same pattern as ChatRuntime.events() +
 *    /api/chats/:id/stream.
 *
 * Lifecycle: the run registers its session when it boots (and re-registers on
 * each session restart, so the registry always holds the CURRENT session), and
 * unregisters in a finally block when the run exits for any reason — which also
 * drops the bus, so any late cancel or stream subscriber is a clean no-op. A
 * stale entry can't be aborted into a stray prompt because session.prompt() is
 * the only thing that observes an abort, and the run loop is already done.
 *
 * NOTE: the bus is in-process only — fine for the current single-process
 * deployment. If runs ever move to multiple workers, this would need a real
 * pub/sub backend (Redis etc.) to cross the boundary, same as the chat path.
 */
export class LiveRunRegistry {
  private readonly live = new Map<string, AgentSession>();
  private readonly buses = new Map<string, EventEmitter>();

  /** Register (or replace) the live session for a job id. Called on boot + restart. */
  set(jobId: string, session: AgentSession): void {
    this.live.set(jobId, session);
  }

  /** Remove the live session + bus for a job id. Called in the run's finally block. */
  delete(jobId: string): void {
    this.live.delete(jobId);
    this.buses.delete(jobId);
  }

  /** True iff a live session is registered for this job id (i.e. the run is mid-flight). */
  has(jobId: string): boolean {
    return this.live.has(jobId);
  }

  /**
   * True iff the run is currently mid-flight — i.e. a live session is
   * registered. Mirrors ChatRuntime.isBusy() for the SSE route's
   * "client connected after the run finished → synthesize done" check.
   */
  isBusy(jobId: string): boolean {
    return this.live.has(jobId);
  }

  /**
   * Per-job event bus. Lazily created. The run path subscribes pi's session
   * events to it (`attachEventBridge`), and the SSE route listens on it to fan
   * events to the browser. Same shape as ChatRuntime.events(). Dropped in
   * `delete()` alongside the session.
   */
  events(jobId: string): EventEmitter {
    let ee = this.buses.get(jobId);
    if (!ee) {
      ee = new EventEmitter();
      this.buses.set(jobId, ee);
    }
    return ee;
  }

  /**
   * Convenience: emit a RunStreamEvent on the job's bus (no-op if no bus / no
   * listeners). Used by the run paths to push the terminal `turn_end` +
   * `done`/`error` so a connected client closes cleanly even if it missed the
   * live message_end.
   */
  emit(jobId: string, e: RunStreamEvent): void {
    this.buses.get(jobId)?.emit("event", e);
  }

  /**
   * Abort the in-flight prompt for a job (best-effort). No-op if the job has no
   * live session (already finished, or running a phase with no session yet like
   * cloning). Returns true if an abort was issued, false if nothing to abort.
   */
  async abort(jobId: string): Promise<boolean> {
    const session = this.live.get(jobId);
    if (!session) return false;
    try {
      await session.abort();
      log.info({ jobId }, "aborted live run session (operator cancel)");
      return true;
    } catch (e) {
      log.warn({ err: e, jobId }, "session.abort() rejected during run cancel");
      return false;
    }
  }
}
