import type { GitHubClient } from "../github/client.js";
import { log } from "../util/log.js";

/**
 * Live "cooking" check run attached to a PR's head commit while an agent run is
 * in flight — the GitHub-Actions-style spinner.
 *
 * What the user sees: a spinner in the PR merge box, a "Noodle is cooking"
 * entry in the PR's Checks tab with a counting elapsed timer (GitHub renders
 * the timer client-side from the check's `started_at` — the API is only touched
 * again on stage changes and completion), and ✓/✗ next to the commit when done.
 *
 * Constraints that shape this module:
 *   - **App mode only.** The Checks API rejects writes from user tokens
 *     (403) — callers gate this behind their App-mode detection and pass
 *     `enabled: false` for PAT setups.
 *   - **Best-effort, never blocking.** A run's outcome (comment/PR/labels) is
 *     the deliverable; check-run failures are logged and swallowed.
 *   - **Self-healing.** `start` first cancels any of our own still-in-progress
 *     checks on the same SHA — leftovers from a crashed process or a retry —
 *     so a PR never shows two live spinners for one run slot. (GitHub marks
 *     runs abandoned >14 days as `stale`; the sweep is the fast path, not a
 *     replacement.) The sweep can in theory cancel a concurrent sibling run's
 *     check when two issues stack onto the same PR at once — cosmetic only,
 *     since each run still completes its own check at the end.
 */

/** The check name shown in the Checks tab + merge box (sweep matches on it). */
export function runCheckName(agentName: string): string {
  return `${agentName} is cooking`;
}

export type CheckOutcome = "success" | "failure";

/** Min interval between mid-run PATCHes — rate-limit + spam guard. */
const STAGE_MIN_INTERVAL_MS = 30_000;
/** Keep check summaries comfortably under GitHub's output size caps. */
const SUMMARY_MAX_CHARS = 4_000;

export interface RunCheckStartOptions {
  gh: GitHubClient;
  repo: string;
  /** Head SHA of the PR the run's progress should show on. Missing → no check. */
  sha?: string | null;
  jobId: string;
  agentName: string;
  /** Human context line for the check summary (e.g. "PR #42 — /noodle-fix"). */
  context: string;
  /** App-mode gate — check runs are App-token exclusive. */
  enabled: boolean;
  /** Fresh gh per call so long runs survive the 1h installation-token TTL. */
  getGh?: () => Promise<GitHubClient>;
}

export class RunCheck {
  private constructor(
    private readonly repo: string,
    private readonly id: number,
    private readonly jobId: string,
    private gh: GitHubClient,
    private readonly getGh?: () => Promise<GitHubClient>,
  ) {}

  private done = false;
  private lastWrite = Date.now();

  /**
   * Sweep stale in-progress checks on `sha`, then create the live one. Returns
   * null when checks are disabled, there's no SHA to attach to, or any API call
   * fails (e.g. the App lacks `checks:write`) — a run never fails because of
   * its check run.
   */
  static async start(opts: RunCheckStartOptions): Promise<RunCheck | null> {
    const { gh, repo, sha, jobId, agentName, context, enabled, getGh } = opts;
    if (!enabled || !sha) return null;
    const name = runCheckName(agentName);
    try {
      // Sweep: any of our checks still spinning on this SHA belongs to a dead
      // attempt (crashed process / retry) — cancel before creating ours.
      const stale = await gh.listInProgressCheckRuns(repo, sha, name);
      for (const c of stale) {
        try {
          await gh.completeCheckRun(repo, c.id, {
            conclusion: "cancelled",
            title: "Superseded — a new run started",
          });
        } catch (e) {
          log.warn({ err: e, repo, jobId, checkRunId: c.id }, "could not cancel stale check run");
        }
      }
      const id = await gh.createCheckRun(repo, {
        name,
        headSha: sha,
        externalId: jobId,
        title: "Run started",
        summary: `${context}\n\nThe agent is working — this check updates as the run progresses.`,
      });
      log.info({ repo, jobId, checkRunId: id, sha }, "check run created (in progress)");
      return new RunCheck(repo, id, jobId, gh, getGh);
    } catch (e) {
      log.warn({ err: e, repo, jobId }, "check run unavailable (App mode requires checks:write)");
      return null;
    }
  }

  /** Mid-run stage update (e.g. "Agent working…"). Throttled; best-effort. */
  async stage(title: string): Promise<void> {
    if (this.done) return;
    if (Date.now() - this.lastWrite < STAGE_MIN_INTERVAL_MS) return;
    this.lastWrite = Date.now();
    try {
      await (await this.client()).updateCheckRun(this.repo, this.id, { title });
    } catch (e) {
      log.warn({ err: e, repo: this.repo, jobId: this.jobId }, "check-run stage update failed");
    }
  }

  /** Terminal write. Idempotent — later calls are no-ops. Best-effort. */
  async complete(outcome: CheckOutcome, title: string, summary?: string): Promise<void> {
    if (this.done) return;
    this.done = true;
    try {
      await (await this.client()).completeCheckRun(this.repo, this.id, {
        conclusion: outcome,
        title,
        summary: summary ? summary.slice(0, SUMMARY_MAX_CHARS) : undefined,
      });
      log.info({ repo: this.repo, jobId: this.jobId, outcome }, "check run completed");
    } catch (e) {
      log.warn({ err: e, repo: this.repo, jobId: this.jobId }, "check-run completion failed");
    }
  }

  /**
   * Re-mint the gh client when a provider was supplied — a long run outlives
   * the 1h installation-token TTL, so the final completion needs a fresh one.
   * Falls back to the start-of-run client if the provider throws.
   */
  private async client(): Promise<GitHubClient> {
    if (this.getGh) {
      try {
        this.gh = await this.getGh();
      } catch {
        /* keep the current client */
      }
    }
    return this.gh;
  }
}
