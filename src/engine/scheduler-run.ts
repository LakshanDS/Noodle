/**
 * Scheduler (cron-tick) run — thin shim over the shared background-run engine.
 *
 * Historically this file held a full ~1000-line copy of the run pipeline
 * (profile resolution, clone, session boot, restart loop, output). That code
 * now lives once in `background-run.ts` and is shared with `trigger-run.ts`.
 * This file keeps the scheduler's public surface (`runSchedulerJob` +
 * `SchedulerRunInput`) so callers (serve.ts, tests) don't change, and forwards
 * to the shared engine with `runKind: "scheduler"`.
 *
 * What's scheduler-specific (vs trigger):
 *  - No `onStatus` hook (schedulers have no DB status column to update).
 *  - Output label prefix "Issue" → `${agent}-Issue`.
 *  - No event context in the prompt.
 *
 * Everything else — trunk + stacked-branch model, conflict resolution,
 * PR-when-changes output — is identical to triggers and lives in the engine.
 */
import type { GitHubClient } from "../github/client.js";
import type { NoodleConfig } from "../config/schema.js";
import { runBackgroundJob, type BackgroundRunDeps } from "./background-run.js";
import type { RunResult } from "./run.js";

/** AuthStorage instance type (passed through from deps to the engine). */
type AuthStorageInstance = ReturnType<
  typeof import("@earendil-works/pi-coding-agent").AuthStorage.create
>;

/**
 * Input for a scheduled (cron) run. Kept for caller compatibility — the engine
 * consumes `BackgroundRunInput` directly, and `runSchedulerJob` adapts this
 * shape to that one.
 */
export interface SchedulerRunInput {
  /** "owner/name" */
  repo: string;
  /** Freeform task prompt (e.g. "find bugs and open issues"). */
  prompt: string;
  /**
   * Trunk branch the schedule's work stacks on (e.g. "noodle/schedule-bug-hunt").
   * Derived at dispatch time from the schedule's name — see serve.ts.
   */
  branchName: string;
  /** Schedule display name — used in PR titles and manual-sync issues. */
  scheduleName?: string;
  /** Resolved profile name, or null/undefined for the config default. */
  profile?: string | null;
  /** Job id for tmp dir + logs + session persistence. */
  jobId?: string;
  /** GitHub token for the clone URL. Defaults to GITHUB_TOKEN env. */
  token?: string;
}

/**
 * Run one scheduled job end-to-end by dispatching to the shared background-run
 * engine. See `runBackgroundJob` for the full lifecycle.
 */
export async function runSchedulerJob(
  config: NoodleConfig,
  gh: GitHubClient,
  input: SchedulerRunInput,
  deps?: {
    authStorage?: AuthStorageInstance;
    runStore?: import("../server/run-store.js").RunStore;
    createAgentSessionFn?: typeof import("@earendil-works/pi-coding-agent").createAgentSession;
    /** Live run registry — forwarded to runBackgroundJob for cancel support. */
    liveRuns?: import("./live-runs.js").LiveRunRegistry;
    tokenProvider?: () => Promise<string>;
    systemPrompt?: string;
    labelOverrides?: string | null;
  },
): Promise<RunResult> {
  const engineDeps: BackgroundRunDeps = {
    authStorage: deps?.authStorage,
    runStore: deps?.runStore,
    liveRuns: deps?.liveRuns,
    createAgentSessionFn: deps?.createAgentSessionFn,
    tokenProvider: deps?.tokenProvider,
    systemPrompt: deps?.systemPrompt,
    labelOverrides: deps?.labelOverrides,
    outputLabelPrefix: "Issue",
    // No onStatus hook — schedulers have no DB status column.
  };
  return runBackgroundJob(config, gh, {
    repo: input.repo,
    prompt: input.prompt,
    branchName: input.branchName,
    displayName: input.scheduleName ?? input.branchName,
    profile: input.profile,
    jobId: input.jobId,
    token: input.token,
    runKind: "scheduler",
  }, engineDeps);
}

// Body-builder wrappers that tests/output.test.ts imports under their historic
// cron-specific names. They delegate to the shared builders in background-run.ts
// (the cron wording was identical to the shared wording — no behavior change,
// just one source of truth). Wrappers rather than bare re-exports so the
// signatures match the historic 3-arg shape (no runKind parameter).
import {
  buildBackgroundIssueBody,
  buildBackgroundErrorBody,
  buildFooter,
} from "./background-run.js";

/** Cron-output issue body (success path). Historic 2-arg signature. */
export function buildCronIssueBody(agentMessage: string | undefined, footer: string): string {
  return buildBackgroundIssueBody(agentMessage, footer);
}

/** Cron-output issue body (error path). Historic 3-arg signature. */
export function buildCronErrorBody(agentName: string, errorMessage: string, footer: string): string {
  return buildBackgroundErrorBody(agentName, "scheduler", errorMessage, footer);
}

export { buildFooter };
