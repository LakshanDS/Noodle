import { log, runLogger } from "../util/log.js";
import { GitHubClient } from "../github/client.js";
import { Workspace, cloneUrlFor } from "./workspace.js";
import { buildCronPrompt } from "./prompt.js";
import { generateIssueTitle, templateTitle, phraseOutput } from "./title.js";
import { installSkills } from "../util/paths.js";
import { collectSysFacts, buildSysInfoGuidance } from "../util/sysinfo.js";
import {
  runAgentLoop,
  extractLastAssistantText,
  lastAssistantStopReason,
  sessionsDirFor,
  resolveRuntimeName,
  runtimeForName,
  type AgentRuntime,
  type RuntimeBootOptions,
} from "./runtime.js";
import { subscribeForLogging } from "./runtime-events.js";
import type { RunStore } from "../server/run-store.js";
import type { NoodleConfig } from "../config/schema.js";
import {
  buildFooter,
  suppressPostDisposeBashRace,
  type RunResult,
  type RunStats,
} from "./run.js";

/**
 * Color applied to the agent-name label on cron output issues — teal (#008672,
 * without the leading '#'). Makes cron output visually distinct in a triage list.
 */
const CRON_LABEL_COLOR = "008672";

/**
 * Input for a scheduled (cron) run. Unlike the issue-driven RunInput, there is
 * no source issue — the agent works a freeform prompt and its final message is
 * turned into a NEW issue by Noodle after the run.
 */
export interface CronRunInput {
  /** "owner/name" */
  repo: string;
  /** Freeform task prompt (e.g. "find bugs and open issues"). */
  prompt: string;
  /** Branch the agent commits to. Reused across runs of the same cron. */
  branchName: string;
  /** Resolved profile name, or null/undefined for the config default. */
  profile?: string | null;
  /** Job id for tmp dir + logs + session persistence. */
  jobId?: string;
  /** GitHub token for the clone URL. Defaults to GITHUB_TOKEN env. */
  token?: string;
}

/**
 * Run one scheduled job end-to-end: resolve profile → clone → branch → run pi
 * → commit + push the branch → open an issue with the agent's final message →
 * record the run.
 *
 * Sibling to `runJob` (engine/run.ts), sharing the same building blocks
 * (Workspace, profile resolution, model registry, session management, stall
 * watcher, footer builder) but with a different lifecycle: no source issue, no
 * PR, no status labels. The agent's deliverable is its final text message;
 * Noodle opens a single issue in the repo with that message as the body (plus a
 * rich footer, same shape as an issue→PR run). The commit/branch is kept for
 * traceability (so an operator can see what the agent inspected/changed) but no
 * PR is opened against it.
 *
 * The branch is reused across runs when it exists on the remote — a daily cron
 * stacks onto yesterday's branch, giving a running timeline of the sweep.
 */
export async function runCronJob(
  config: NoodleConfig,
  gh: GitHubClient,
  input: CronRunInput,
  deps?: {
    runStore?: RunStore;
    /** Agent runtime (defaults to PiRuntime). Tests inject a fake. */
    runtime?: AgentRuntime;
    /** Test-only: bypass the runtime, return a bare RuntimeSession. */
    bootFn?: RuntimeBootOptions["bootFn"];
    tokenProvider?: () => Promise<string>;
    /** MCP server store — resolves profile's mcp_servers names to definitions. */
    mcpServerStore?: { getByNames(names: string[]): Record<string, import("../config/schema.js").McpServerDefinition> };
  },
): Promise<RunResult> {
  const jobId = input.jobId ?? `cron-${input.repo.replace("/", "-")}`;
  const branchName = input.branchName;

  const log_ = runLogger({
    jobId,
    repo: input.repo,
    branch: branchName,
    pid: process.pid,
  });
  log.info("═══════════════════════════════════════════════════════════════");
  log.info(
    `cron run started — repo=${input.repo} | branch=${branchName} | jobId=${jobId} | pid=${process.pid}`,
  );

  const runStore = deps?.runStore;
  if (runStore) {
    runStore.createRun({
      job_id: jobId,
      repo: input.repo,
      issue: null,
      branch: branchName,
    });
  }

  // 1. Resolve profile: explicit cron profile, else the config default.
  const profileName = input.profile ?? config.default_profile;
  const profileDef = config.profiles[profileName];
  if (!profileDef) {
    throw new Error(
      `Cron profile "${profileName}" is not defined in profiles (default_profile: ${config.default_profile}).`,
    );
  }
  const profile = { name: profileName, ...profileDef };
  log_.info({ profile: profile.name, model: profile.model }, "routed profile");

  // 2. Resolve the agent runtime (pi default, opencode when the profile/cron
  // selects it). Cron runs don't have a per-cron runtime override yet, so this
  // resolves from profile → config default.
  const runtimeName = resolveRuntimeName(config, profile, null);
  const runtime = deps?.runtime ?? await runtimeForName(runtimeName);
  log_.info({ runtime: runtimeName, profile: profile.name, model: profile.model }, "resolved runtime");
  if (runStore) {
    runStore.updateRun(jobId, { runtime: runtimeName });
  }

  // 3. Clone.
  const tokenProvider = deps?.tokenProvider ?? (async () => input.token ?? process.env.GITHUB_TOKEN ?? "");
  const freshToken = async () => {
    const t = await tokenProvider();
    if (!t) {
      throw new Error("No GitHub token for git op. Set GITHUB_TOKEN or pass input.token.");
    }
    return t;
  };
  const ws = await Workspace.clone(cloneUrlFor(input.repo, await freshToken()), jobId);
  let agentAnswer: string | undefined;
  try {
    // 4. Branch: reuse the existing remote branch when present (stack this run
    // on top of prior runs), otherwise create a fresh one. We probe by fetching
    // the branch ref; a failure means it doesn't exist yet. A cron branch is
    // intentionally a long-lived timeline, not a one-shot like an issue branch.
    const reused = await tryReuseBranch(ws, branchName, cloneUrlFor(input.repo, await freshToken()), log_);
    if (!reused) {
      await ws.branch(branchName);
    }
    await installSkills(ws.path);

    // 4. Build the cron prompt. No custom output tool — the agent ends by
    // writing its findings as a normal final text message, and Noodle opens a
    // single issue with that message as the body after the run (mirrors how
    // runJob turns the agent's answer into the issue comment + PR body).
    const sysFacts = collectSysFacts();
    log_.debug({ sysFacts }, "probed system info for cron prompt");
    const prompt = buildCronPrompt(input.prompt, input.repo, config.agent_name, buildSysInfoGuidance(sysFacts));

    // 5. Run the agent via the runtime abstraction. `runAgentLoop` owns the
    // session boot, the restart loop, the stall watcher, and stats capture —
    // all runtime-agnostic. Cron runs pass no custom tools (no issue to comment on).
    const sessionDir = sessionsDirFor(jobId);
    const idleMs = (config.run?.stall_timeout_minutes ?? 0) * 60_000;
    const toolMs = (config.run?.tool_stall_minutes ?? 0) * 60_000;
    // Resolve MCP server names from the store after profile resolution.
    const resolvedMcpServers = deps?.mcpServerStore && profile.mcp_servers?.length
      ? deps.mcpServerStore.getByNames(profile.mcp_servers)
      : undefined;

    const runtimeOpts: RuntimeBootOptions = {
      cwd: ws.path,
      sessionDir,
      profile,
      resolvedMcpServers,
      stallBudgets: { idleTimeoutMs: idleMs, toolTimeoutMs: toolMs },
      log_,
      onSession: (s) => subscribeForLogging(s, log_),
      ...(deps?.bootFn ? { bootFn: deps.bootFn } : {}),
    };

    const { session, sessionPath, durationMs } = await runAgentLoop(runtime, runtimeOpts, prompt);

    // Guard the benign post-dispose bash-socket race (same as runJob).
    const teardownDisposeGuard = suppressPostDisposeBashRace(log_);
    try {
      const sessionStats = session.getSessionStats?.();
      const runStats: RunStats = {
        durationMs,
        tokens: sessionStats?.tokens
          ? {
              input: sessionStats.tokens.input,
              output: sessionStats.tokens.output,
              cacheRead: sessionStats.tokens.cacheRead,
              cacheWrite: sessionStats.tokens.cacheWrite,
              total: sessionStats.tokens.total,
            }
          : undefined,
        cost: sessionStats?.cost,
        toolCalls: sessionStats?.toolCalls,
        turns: sessionStats?.assistantMessages,
      };
      log_.info(
        { durationMs, tokens: runStats.tokens?.total, cost: runStats.cost, toolCalls: runStats.toolCalls, turns: runStats.turns },
        "cron run stats",
      );
      await session.dispose?.();
      log_.info("cron run finished");

      // sessionPath comes from runAgentLoop (the runtime's persisted file, if any).
      if (runStore && sessionPath) {
        runStore.updateRun(jobId, { session_path: sessionPath });
      }

      // Detect error termination vs capture the agent's final message.
      const stopReason = lastAssistantStopReason(session);
      const errored = stopReason.stopReason === "error";
      if (errored) {
        log_.error({ errorMessage: stopReason.errorMessage, stopReason: stopReason.stopReason }, "cron run ended on error");
      } else {
        // Capture the agent's findings, then phrase them into a clean issue body
        // (cleans formatting + strips tool residue WITHOUT losing detail). Falls
        // back to the raw answer on any failure.
        const raw = extractLastAssistantText(session);
        agentAnswer = raw ? await phraseOutput(raw, config, profile) : undefined;
      }

      // Commit + push the branch (traceability). No PR — the issue below is the output.
      await ws.removeInternals();
      const committed = await ws.commitAll(
        `cron run (${input.branchName})\n\nScheduled run by ${config.agent_name} (profile: ${profile.name}).`,
      );
      if (committed) {
        await ws.push(branchName, cloneUrlFor(input.repo, await freshToken()), reused);
        log_.info({ branch: branchName, reused }, "pushed cron branch");
      }

      // Open the cron output issue: the agent's final message as the body, with
      // a rich footer (same shape as an issue→PR run's comment). On an errored
      // run the body is an honest error notice instead — the agent's last text
      // is just an opening utterance, not a real answer. The title is derived
      // from the task so the issue is identifiable in a triage list.
      const issueBody = errored
        ? buildCronErrorBody(config.agent_name, stopReason.errorMessage ?? "agent run ended on error")
        : buildCronIssueBody(agentAnswer, buildFooter(profile, config.agent_name, runStats));
      // Generate a clean title from the agent's findings via a separate model
      // call (falls back to a template on any failure). Only on success — an
      // errored run uses the task as the title since there are no findings.
      const issueTitle = errored
        ? templateTitle(input.prompt)
        : await generateIssueTitle(agentAnswer ?? "", input.prompt, config, profile);
      // Ensure the cron-issue label exists with the brand teal color so cron
      // output issues are visually identifiable in a triage list. Idempotent.
      const cronLabel = `${config.agent_name}-Issue`;
      await gh.ensureLabel(
        input.repo,
        cronLabel,
        CRON_LABEL_COLOR,
        `${config.agent_name}-Agent scheduled job result`,
      );
      const issue = await gh.createIssue(input.repo, issueTitle, issueBody, [cronLabel]);
      log_.info({ issue: issue.number, url: issue.html_url, errored }, "opened cron output issue");

      if (runStore) {
        runStore.updateRun(jobId, {
          profile: profile.name,
          model: profile.model,
          status: errored ? "failed" : "succeeded",
          error: errored ? (stopReason.errorMessage ?? "agent run ended on error") : null,
          summary: agentAnswer ?? null,
          output_issue_url: issue.html_url,
          finished_at: nowIso(),
        });
      }
      return {
        profile: profile.name,
        model: profile.model,
        changedFiles: committed ? await ws.changedFiles() : [],
        agentAnswer,
        commentUrl: "",
        sessionPath,
        outputIssueUrl: issue.html_url,
      };
    } finally {
      teardownDisposeGuard();
    }
  } catch (e) {
    if (runStore) {
      runStore.updateRun(jobId, { status: "failed", error: (e as Error).message ?? String(e), finished_at: nowIso() });
    }
    throw e;
  } finally {
    await ws.dispose();
  }
}

/**
 * Try to reuse an existing remote branch: fetch it and reset onto its tip so
 * this run's work stacks on top of prior runs. Returns true when the branch
 * existed and was checked out, false when it doesn't exist (caller creates a
 * fresh branch). A cron branch is a long-lived timeline; reuse is the common
 * path after the first run.
 *
 * Failures other than "branch not found" (network blip, auth) are re-thrown —
 * we don't want to silently start a fresh branch and lose the timeline on a
 * transient git error.
 */
async function tryReuseBranch(
  ws: Workspace,
  name: string,
  freshCloneUrl: string,
  log_: typeof log,
): Promise<boolean> {
  try {
    // Fetch the single ref. simpleGit.fetch throws on a non-existent ref.
    await (ws as unknown as { git: { fetch: (url: string, ref: string) => Promise<unknown> } }).git.fetch(freshCloneUrl, name);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/not found|doesn't exist|could not find|does not exist| fatal:/i.test(msg)) {
      log_.debug({ branch: name }, "branch does not exist yet — will create fresh");
      return false;
    }
    // Ambiguous failure — re-throw so the caller surfaces it rather than
    // silently starting a fresh branch and breaking the timeline.
    throw e;
  }
  await ws.checkoutOrReuse(name, freshCloneUrl);
  log_.debug({ branch: name }, "reused existing remote cron branch");
  return true;
}

/**
 * Mirror agent events into the cron run log — delegated to the shared
 * `subscribeForLogging` in runtime-events.ts (imported above), so both run paths
 * log identically. Formerly a cron-specific duplicate; now one implementation.
 */

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build the cron output issue body from the agent's final message + the shared
 * footer. A blank/missing agent message still produces a useful issue body so
 * the run is never silent (the team sees the agent ran but had nothing to say).
 */
function buildCronIssueBody(agentMessage: string | undefined, footer: string): string {
  const body = agentMessage?.trim() ||
    "_The agent ran but produced no findings. It may have found nothing concrete to report._";
  return `${body}\n\n---\n${footer}`;
}

/**
 * Build the cron output issue body for an errored run. Honest notice that the
 * run failed, with the error text quoted so the cause is visible, plus the
 * footer. Mirrors `buildErrorComment` from run.ts but for the cron (no-issue) path.
 */
function buildCronErrorBody(agentName: string, errorMessage: string): string {
  const err = errorMessage.trim() || "unknown error";
  const body =
    `⚠️ **Scheduled run by ${agentName} errored out before finishing.**\n\n` +
    `> \`${err}\`\n\n` +
    `No findings were produced. The run may be retried once the underlying issue ` +
    `(API quota, rate limit, provider outage, etc.) is resolved.`;
  return body;
}

// Re-export buildFooter for callers (UI / summary rendering) that want the
// same footer shape as an issue-driven run.
export { buildFooter };
