/**
 * Trigger (webhook-event-driven) run — thin shim over the shared background-run
 * engine.
 *
 * Historically this file held a full copy of the run pipeline duplicated from
 * scheduler-run.ts. That code now lives once in `background-run.ts` and is
 * shared with `scheduler-run.ts`. This file keeps the trigger's public surface
 * (`runTriggerJob` + `TriggerRunInput`) so callers (serve.ts) don't change,
 * and forwards to the shared engine with `runKind: "trigger"`.
 *
 * What's trigger-specific (vs scheduler):
 *  - `onStatus` hook updates the trigger row's status column ("running" →
 *    "succeeded"/"failed") via `triggerStore.updateRunStatus`.
 *  - Output label prefix "Trigger" → `${agent}-Trigger`.
 *  - Event context (type + action) injected into the prompt header.
 *
 * Everything else — trunk + stacked-branch model, conflict resolution,
 * PR-when-changes output — is identical to schedulers and lives in the engine.
 *
 * Note: `TriggerRunInput.eventSummary` was never populated by any caller (dead
 * code) and is dropped here. The trigger's only event context that actually
 * survived the webhook→queue→run path is the event type/action name pair.
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
 * Input for an event-driven trigger run. Kept for caller compatibility — the
 * engine consumes `BackgroundRunInput` directly, and `runTriggerJob` adapts
 * this shape to that one.
 */
export interface TriggerRunInput {
  /** "owner/name" */
  repo: string;
  /** Freeform task prompt (the trigger's configured prompt). */
  prompt: string;
  /** Trunk branch the trigger's work stacks on (e.g. "noodle/trigger-on-push"). */
  branchName: string;
  /** Resolved profile name, or null/undefined for the config default. */
  profile?: string | null;
  /** Job id for tmp dir + logs + session persistence. */
  jobId?: string;
  /** GitHub token for the clone URL. Defaults to GITHUB_TOKEN env. */
  token?: string;
  /** The GitHub event that triggered this run (e.g. "issues", "pull_request"). */
  eventType: string;
  /** The event action (e.g. "opened", "created"). May be null. */
  eventAction?: string | null;
  /** Display name (trigger name) for PR titles and manual-sync issues. */
  triggerLabel?: string | null;
}

/**
 * Run one trigger job end-to-end by dispatching to the shared background-run
 * engine. The trigger's DB status column is updated at start/end via the
 * `onStatus` hook. See `runBackgroundJob` for the full lifecycle.
 */
export async function runTriggerJob(
  config: NoodleConfig,
  gh: GitHubClient,
  input: TriggerRunInput,
  deps?: {
    authStorage?: AuthStorageInstance;
    runStore?: import("../server/run-store.js").RunStore;
    createAgentSessionFn?: typeof import("@earendil-works/pi-coding-agent").createAgentSession;
    /** Live run registry — forwarded to runBackgroundJob for cancel support. */
    liveRuns?: import("./live-runs.js").LiveRunRegistry;
    tokenProvider?: () => Promise<string>;
    systemPrompt?: string;
    labelOverrides?: string | null;
    /** Updates the trigger row's status column. Called at start/success/failure. */
    triggerStore?: { updateRunStatus: (id: number, status: string) => void };
    triggerId?: number;
  },
): Promise<RunResult> {
  const triggerId = deps?.triggerId;
  const triggerStore = deps?.triggerStore;
  const engineDeps: BackgroundRunDeps = {
    authStorage: deps?.authStorage,
    runStore: deps?.runStore,
    liveRuns: deps?.liveRuns,
    createAgentSessionFn: deps?.createAgentSessionFn,
    tokenProvider: deps?.tokenProvider,
    systemPrompt: deps?.systemPrompt,
    labelOverrides: deps?.labelOverrides,
    outputLabelPrefix: "Trigger",
    onStatus: (status) => {
      if (triggerId != null && triggerStore) {
        triggerStore.updateRunStatus(triggerId, status);
      }
    },
  };
  return runBackgroundJob(config, gh, {
    repo: input.repo,
    prompt: input.prompt,
    branchName: input.branchName,
    displayName: input.triggerLabel ?? input.branchName,
    profile: input.profile,
    jobId: input.jobId,
    token: input.token,
    runKind: "trigger",
    eventContext: { type: input.eventType, action: input.eventAction ?? null },
  }, engineDeps);
}

// Body-builder wrappers that tests/output.test.ts imports under their historic
// trigger-specific names. Delegate to the shared builders in background-run.ts
// with the trigger's runKind baked in. Wrappers (not re-exports) so the
// signatures match the historic shapes.
import {
  buildBackgroundIssueBody,
  buildBackgroundErrorBody,
} from "./background-run.js";

/** Trigger-output issue body (success path). Historic 2-arg signature. */
export function buildTriggerIssueBody(agentMessage: string | undefined, footer: string): string {
  return buildBackgroundIssueBody(agentMessage, footer);
}

/** Trigger-output issue body (error path). Historic 3-arg signature. */
export function buildTriggerErrorBody(agentName: string, errorMessage: string, footer: string): string {
  return buildBackgroundErrorBody(agentName, "trigger", errorMessage, footer);
}
