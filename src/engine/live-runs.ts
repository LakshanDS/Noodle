import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { log } from "../util/log.js";

/**
 * Live registry of in-flight run sessions, keyed by job id ("job-19"). Mirrors
 * the ChatRuntime's `live` map but for queue-dispatched runs (issue/PR via
 * runJob, scheduler/trigger via runBackgroundJob).
 *
 * Why this exists: jobs run in-process (no child process to SIGTERM), so the
 * only way to cancel a running job is to call `session.abort()` on its live pi
 * session. The cancel endpoint (POST /api/runs/:id/cancel) looks up the session
 * here and aborts it. Without this, cancel only marks the DB row failed — the
 * agent keeps running until it finishes on its own.
 *
 * Lifecycle: the run registers its session when it boots (and re-registers on
 * each session restart, so the registry always holds the CURRENT session), and
 * unregisters in a finally block when the run exits for any reason. A stale
 * entry can't be aborted into a stray prompt because session.prompt() is the
 * only thing that observes an abort, and the run loop is already done.
 */
export class LiveRunRegistry {
  private readonly live = new Map<string, AgentSession>();

  /** Register (or replace) the live session for a job id. Called on boot + restart. */
  set(jobId: string, session: AgentSession): void {
    this.live.set(jobId, session);
  }

  /** Remove the live session for a job id. Called in the run's finally block. */
  delete(jobId: string): void {
    this.live.delete(jobId);
  }

  /** True iff a live session is registered for this job id. */
  has(jobId: string): boolean {
    return this.live.has(jobId);
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
