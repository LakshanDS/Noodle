import { log, runLogger } from "../util/log.js";
import { resolveProfile } from "../profiles/resolve.js";
import { resolveCommand } from "../commands/resolve.js";
import { GitHubClient } from "../github/client.js";
import { Workspace, cloneUrlFor } from "./workspace.js";
import { buildRunPrompt, defaultCommandPrompt } from "./prompt.js";
import { createCommentOnIssueTool } from "./tools.js";
import { phraseOutput } from "./title.js";
import { installSkills } from "../util/paths.js";
import { collectSysFacts, buildSysInfoGuidance } from "../util/sysinfo.js";
import { slugify } from "../util/slugify.js";
import { extractProfileTag } from "../triggers/check.js";
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
import type { CommandRow } from "../server/command-store.js";
import type { NoodleConfig } from "../config/schema.js";

/**
 * Status labels applied to issues the agent works on. All three are ensured to
 * exist (created with the color + description below) at the start of every run,
 * so a repo doesn't need to set them up by hand.
 *
 *   cooking → applied while the agent is running
 *   cooked  → applied when the run finishes successfully (cooking is removed)
 *   failed  → applied when the run errors out (cooking is removed)
 *
 * Label names incorporate the configurable agent name (default "Noodle").
 */
export function labelsFor(agentName: string) {
  return {
    cooking: {
      name: `${agentName} is cooking`,
      color: "f0be04", // amber — without leading '#'
      description: `${agentName} agent is working on this`,
    },
    cooked: {
      name: `${agentName} cooked here`,
      color: "22c55e", // green — without leading '#'
      description: `${agentName} agent run finished`,
    },
    failed: {
      name: `${agentName} got Cooked`,
      color: "b91c1c", // red — without leading '#'
      description: `${agentName} agent run errored out`,
    },
  } as const;
}

/** Default labels using the built-in agent name. */
export const LABELS = labelsFor("Noodle");

export interface RunInput {
  repo: string; // owner/name
  issueNumber: number;
  /** job id for tmp dir + logs + branch suffix */
  jobId?: string;
  /**
   * GitHub token used for the clone URL. Defaults to GITHUB_TOKEN env.
   * Phase 2 passes a short-lived GitHub-App installation token here.
   */
  token?: string;
}

export interface RunResult {
  profile: string;
  model: string;
  changedFiles: string[];
  /** The agent's final message (its answer), posted verbatim as the comment body. */
  agentAnswer?: string;
  prUrl?: string;
  commentUrl: string;
  /** Path to pi's persisted session file (resume/inspect). Omitted if no store. */
  sessionPath?: string;
  /**
   * URL of the issue a cron run opened (its output). Omitted for issue→PR runs,
   * which produce a PR + comment instead.
   */
  outputIssueUrl?: string;
}

/**
 * Stats gathered over the run for the comment/PR footer: tokens, cost, timing,
 * tool-call + turn counts. Populated from pi's `session.getSessionStats()`
 * (sums per-message `usage`) plus a wall-clock duration Noodle captures itself.
 * Cost is real USD for built-in providers; $0 for local/custom models.
 */
export interface RunStats {
  durationMs: number;
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost?: number;
  toolCalls?: number;
  turns?: number;
}

/**
 * Run one job end-to-end: fetch issue → route profile → clone → run agent →
 * commit → push → open PR → comment on issue.
 *
 * The agent's conversation is persisted to a session file under `./sessions/`
 * (survives workspace disposal, resumable). When a `runStore` is supplied
 * (serve mode), a `runs` row records status/PR/summary.
 *
 * The agent runs via `runAgentLoop` (src/engine/runtime.ts), which owns the
 * restart loop + stall watcher + stats capture and is runtime-agnostic. The
 * runtime (pi by default, opencode when the profile selects it) is resolved by
 * `resolveRuntimeName` from command → profile → config default.
 */
export async function runJob(
  config: NoodleConfig,
  gh: GitHubClient,
  input: RunInput,
  deps?: {
    /** Optional run store — when set, the run is recorded in the `runs` table. */
    runStore?: RunStore;
    /**
     * Which agent runtime to use. Defaults to `PiRuntime`; tests inject a fake
     * runtime to avoid spinning up a real agent. (OpenCode runs pass an
     * `OpenCodeRuntime` instance here in Milestone 2.)
     */
    runtime?: AgentRuntime;
    /**
     * Test-only: bypass the runtime entirely and return a bare `RuntimeSession`
     * directly. `runAgentLoop` wraps it with a stall watcher. Production calls
     * leave this unset.
     */
    bootFn?: RuntimeBootOptions["bootFn"];
    /**
     * Fresh-credential providers — serve mode passes these so long jobs
     * (2h+) re-mint their GitHub token / client at each git+HTTP op instead
     * of reusing the 1h-TTL one captured at job start. Defaults reuse the
     * start-of-run token/gh, preserving CLI + Phase-1 behavior.
     */
    tokenProvider?: () => Promise<string>;
    ghProvider?: () => Promise<GitHubClient>;
    /**
     * Called once after the authoritative profile is resolved, so the caller
     * (serve) can correct the job row's enqueue-time profile hint. The hint
     * (from a #tag or default) is usually right, but label/keyword routing can
     * resolve differently — keeping the row accurate matters for per-profile
     * concurrency gating. CLI runs don't set this (no queue).
     */
    onProfileResolved?: (profile: string) => void;
    /**
     * Available slash commands (rows from the command store). When supplied,
     * the run resolves which command (if any) matches the issue+comments and
     * uses its `system_prompt` as the agent framing + its profile override.
     * Omit to run with the built-in default framing (legacy behaviour).
     */
    commands?: CommandRow[];
    /**
     * MCP server store — when set and the resolved profile has `mcp_servers`
     * names, `runJob` resolves them to full definitions (via `store.getByNames`)
     * and passes them through to the runtime's boot options. Omit for CLI/tests
     * (OpenCode runs without MCP servers when no store is available).
     */
    mcpServerStore?: { getByNames(names: string[]): Record<string, import("../config/schema.js").McpServerDefinition> };
  },
): Promise<RunResult> {
  const agentName = config.agent_name;
  const agentSlug = slugify(agentName);
  const jobId = input.jobId ?? `${input.repo.replace("/", "-")}-${input.issueNumber}`;
  // Branch name: bare `<agent>/issue-<n>` for a fresh attempt. If an OPEN PR
  // already exists for this issue (a follow-up `/noodle` run while the previous
  // attempt's PR is still open), reuse that PR's branch and stack this run's
  // work on top — the force-push updates the same PR instead of opening a new
  // one. Closed-without-merge and merged PRs are NOT reused (no open PR found),
  // so a clean retry starts a fresh branch.
  const existing = await gh.findOpenPRForIssue(input.repo, input.issueNumber, agentSlug);
  const reuseBranch = !!existing;
  const branchName = existing?.branch ?? branchNameFor(input.issueNumber, agentSlug);

  // Per-run logger: stdout only (pretty). Run context is bound to the raw JSON
  // for correlation/grep, but the pretty formatter hides it from per-event
  // lines — it's printed once in the run-header banner below.
  const log_ = runLogger({
    jobId,
    repo: input.repo,
    issue: input.issueNumber,
    branch: branchName,
    pid: process.pid,
  });
  // Run header: a banner with all the identifying context up front.
  log.info("═══════════════════════════════════════════════════════════════");
  log.info(
    `agent run started — issue #${input.issueNumber} | repo=${input.repo} | branch=${branchName} | jobId=${jobId} | pid=${process.pid}`,
  );
  log.info(
    existing
      ? { pr: existing.html_url, branch: branchName }
      : { branch: branchName },
    existing ? "reusing branch from open PR (follow-up run)" : "fresh branch (no open PR)",
  );

  // Record the run in the store (serve mode only). CLI runs skip this — the
  // store is an optional dep so the CLI stays DB-free. Updated at the end with
  // profile/model/status/pr/summary/error.
  const runStore = deps?.runStore;
  if (runStore) {
    runStore.createRun({
      job_id: jobId,
      repo: input.repo,
      issue: input.issueNumber,
      branch: branchName,
    });
  }

  // 1. Fetch issue + comments.
  const issue = await gh.getIssue(input.repo, input.issueNumber);
  const comments = await gh.getIssueComments(input.repo, input.issueNumber);
  log_.info({ title: issue.title, labels: issue.labels }, "fetched issue");

  // 1a. Concurrency gate: if the "cooking" label is already on the issue, a run
  // is in progress — don't start a second one. Post a short no-op comment and
  // return a clean result (NOT an error, so the worker doesn't retry). Terminal
  // labels (cooked/failed) do NOT block: they signal a finished run and allow a
  // follow-up. This makes the label the visible source of truth for "is the
  // agent busy here?".
  const labels = labelsFor(agentName);
  const lowerLabels = new Set(issue.labels.map((l) => l.toLowerCase()));
  if (lowerLabels.has(labels.cooking.name.toLowerCase())) {
    log_.info("skipping — issue already has the cooking label (a run is in progress)");
    await gh.createIssueComment(
      input.repo,
      input.issueNumber,
      `_${displayName(agentName)} is already cooking on this issue — the new request will start once the current run finishes._`,
    );
    return {
      profile: "",
      model: "",
      changedFiles: [],
      commentUrl: "",
    };
  }

  // Ensure both status labels exist in the repo (creates them if missing), then
  // mark the issue as being worked on. (The `labels` const is already defined
  // above, before the concurrency gate.)
  await gh.ensureLabel(
    input.repo,
    labels.cooking.name,
    labels.cooking.color,
    labels.cooking.description,
  );
  await gh.ensureLabel(
    input.repo,
    labels.cooked.name,
    labels.cooked.color,
    labels.cooked.description,
  );
  await gh.ensureLabel(
    input.repo,
    labels.failed.name,
    labels.failed.color,
    labels.failed.description,
  );
  await gh.addIssueLabel(input.repo, input.issueNumber, labels.cooking.name);
  log_.info({ label: labels.cooking.name }, "added status label");

  // 2. Route to a profile. A `#<profile>` tag in body or a comment is the
  // highest-priority selector — it wins over label/keyword/default routing.
  // Otherwise fall back to resolveProfile (slash/label/keyword/default).
  const profileNames = Object.keys(config.profiles);
  const tagProfile = extractProfileTag(issue.body ?? "", profileNames)
    ?? comments.map((c) => extractProfileTag(c.body ?? "", profileNames)).find((p) => p !== null)
    ?? null;
  let profile = tagProfile && config.profiles[tagProfile]
    ? { name: tagProfile, ...config.profiles[tagProfile] }
    : resolveProfile(config, {
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        comments: comments.map((c) => c.body),
      });

  // Resolve the slash command that drove this run (if commands are wired in).
  // A matching command overrides the routed profile when it pins one, and its
  // system_prompt becomes the agent framing. With no command list supplied
  // (CLI/tests) we fall back to the built-in default framing — today's behaviour.
  const command = deps?.commands?.length
    ? resolveCommand(deps.commands, {
        title: issue.title,
        body: issue.body ?? "",
        labels: issue.labels,
        comments: comments.map((c) => c.body ?? ""),
      })
    : null;
  let commandName: string | null = null;
  if (command) {
    commandName = command.trigger;
    if (command.profile && config.profiles[command.profile]) {
      profile = { name: command.profile, ...config.profiles[command.profile] };
    }
  }
  log_.info(
    { profile: profile.name, model: profile.model, via: tagProfile ? "#tag" : "routing", command: commandName },
    "routed profile",
  );
  if (runStore) {
    runStore.updateRun(jobId, { profile: profile.name, model: profile.model, ...(commandName ? { command: commandName } : {}) });
  }
  // Correct the job row's enqueue-time profile hint if authoritative resolution
  // differed (e.g. label routing overrode the default). Keeps per-profile
  // concurrency gating accurate.
  deps?.onProfileResolved?.(profile.name);

  // 3. Resolve the agent runtime for this run (pi default, opencode when the
  // profile/command selects it). Recorded on the runs row for the dashboard.
  // Tests inject a fake `runtime` directly (bypassing resolution); production
  // resolves from command-runtime-override → profile → config default.
  const runtimeName = resolveRuntimeName(config, profile, (command as { runtime?: string } | null)?.runtime ?? null);
  const runtime = deps?.runtime ?? await runtimeForName(runtimeName);
  log_.info({ runtime: runtimeName, profile: profile.name, model: profile.model }, "resolved runtime");
  if (runStore) {
    runStore.updateRun(jobId, { runtime: runtimeName });
  }

  // 4. Clone + branch. Base = repo default branch (resolved dynamically).
  const baseBranch = await gh.defaultBranch(input.repo);
  // Credential providers: serve mode re-mints per-op (long jobs outlive the
  // 1h token TTL); CLI/tests fall back to the start-of-run token/gh.
  const tokenProvider = deps?.tokenProvider ?? (async () => input.token ?? process.env.GITHUB_TOKEN ?? "");
  const ghProvider = deps?.ghProvider ?? (async () => gh);
  const freshToken = async () => {
    const t = await tokenProvider();
    if (!t) {
      throw new Error(
        "No GitHub token for git op. Pass input.token (Phase 2) or set GITHUB_TOKEN (Phase 1).",
      );
    }
    return t;
  };
  const ws = await Workspace.clone(cloneUrlFor(input.repo, await freshToken()), jobId);
  let agentAnswer: string | undefined;
  try {
    // Reuse the existing branch when there's an open PR (follow-up run): fetch
    // it and reset onto its tip so the agent's work stacks on top. Otherwise
    // create a fresh branch off the cloned base.
    if (reuseBranch) {
      await ws.checkoutOrReuse(branchName, cloneUrlFor(input.repo, await freshToken()));
    } else {
      await ws.branch(branchName);
    }
    await installSkills(ws.path);

    // 5. Build the prompt. Probe the host hardware up front so the agent knows
    // whether this box can run builds/tests or must verify by reasoning — a
    // small VPS / container often can't, and a "let me run the build" attempt
    // will hang or crash. Framing = the matched command's system_prompt, or the
    // built-in default.
    const sysFacts = collectSysFacts();
    log_.debug({ sysFacts }, "probed system info for agent prompt");
    const framing = command?.system_prompt?.trim()
      ? command.system_prompt
      : defaultCommandPrompt(agentName);
    const prompt = buildRunPrompt(framing, issue, comments, input.repo, buildSysInfoGuidance(sysFacts));

    // 6. Run the agent via the runtime abstraction. `runAgentLoop` owns the
    // session boot, the restart loop (same persisted session on failure), the
    // stall watcher, and stats capture — all runtime-agnostic. The runtime
    // (pi by default) handles session construction + event translation.
    //
    // The session is PERSISTED to a stable dir (./sessions/<jobId>/) that
    // survives workspace disposal — so the full conversation (messages, tool
    // calls, tool results) is on disk for resume/inspection without us having
    // to log it ourselves. The runs row (if any) points at the session file.
    const sessionDir = sessionsDirFor(jobId);
    const idleMs = (config.run?.stall_timeout_minutes ?? 0) * 60_000;
    const toolMs = (config.run?.tool_stall_minutes ?? 0) * 60_000;
    // Resolve MCP server names from the store after profile resolution. The
    // profile's mcp_servers is a string[] (names); the store has the full defs.
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
      customTools: [createCommentOnIssueTool(gh, input.repo, input.issueNumber, agentName)],
      // Attach the log subscriber to each freshly-booted session (initial boot
      // and every restart) so events are mirrored into the run log in real time.
      onSession: (s) => subscribeForLogging(s, log_),
      ...(deps?.bootFn ? { bootFn: deps.bootFn } : {}),
    };

    const { session, sessionPath, durationMs } = await runAgentLoop(runtime, runtimeOpts, prompt);

    // After dispose, a lingering pi bash-tool PTY socket can emit a final chunk
    // whose handler throws "Agent listener invoked outside active run" from an
    // async callback — uncatchable by try/catch and fatal to the process. Guard
    // only that specific benign error around the post-run work so a finished
    // run still reaches its commit/PR/comment. Torn down once the run is done.
    const teardownDisposeGuard = suppressPostDisposeBashRace(log_);
    try {
      // Capture run stats (tokens, cost, tool calls) BEFORE dispose. getSessionStats()
      // reads from session.state.messages, which survives dispose, but grabbing it
      // first is safest. Available even on error-stopped runs (partial stats).
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
        {
          durationMs,
          tokens: runStats.tokens?.total,
          cost: runStats.cost,
          toolCalls: runStats.toolCalls,
          turns: runStats.turns,
        },
        "run stats",
      );
      await session.dispose?.();
      log_.info("agent run finished");

      // Capture the persisted session file path (for the runs row + RunResult).
      // sessionPath comes from runAgentLoop (the runtime's persisted file, if any).
      if (runStore && sessionPath) {
        runStore.updateRun(jobId, { session_path: sessionPath });
      }

      // 7. Detect error termination. pi records an error-stopped turn as
      // { stopReason: "error", errorMessage } — the run resolves normally, but
      // the agent never reached a conclusion, and any earlier assistant text is
      // just an opening utterance (e.g. "I'll load the skills first…"), NOT an
      // answer. Surface the failure honestly instead of posting that utterance.
      const stopReason = lastAssistantStopReason(session);
      const errored = stopReason.stopReason === "error";
      if (errored) {
        const errMsg = stopReason.errorMessage ?? "unknown error";
        log_.error({ errorMessage: errMsg, stopReason: stopReason.stopReason }, "agent run ended on error");
      } else {
        // Capture the agent's final message — its actual answer. Then phrase it
        // into a clean comment/PR body via a single relay LLM call (cleans
        // formatting + strips tool residue WITHOUT losing detail). Falls back to
        // the raw answer on any failure, so the run is never blocked by phrasing.
        agentAnswer = extractLastAssistantText(session);
        if (!agentAnswer) {
          log_.warn("agent produced no final assistant message; comment will use the generic template");
        } else {
          agentAnswer = await phraseOutput(agentAnswer, config, profile);
        }
      }

      // 8. Commit + (if changes) push + open PR. An errored run skips this — it
      // falls through to step 9, which posts the error text as the comment and
      // records the run with a `failed` status.
      if (!errored) {
        await ws.removeInternals();
        const committed = await ws.commitAll(
          `Fix #${input.issueNumber}: ${issue.title}\n\nGenerated by ${agentName} (profile: ${profile.name}).`,
        );

        if (committed) {
          // Re-mint credentials right before push — a long agent run can
          // exceed the token's TTL (1h for GitHub-App installation tokens).
          await ws.push(branchName, cloneUrlFor(input.repo, await freshToken()), reuseBranch);
          const changedFiles = await ws.changedFiles();
          const prBody = buildPrBody(profile, changedFiles, issue.html_url, agentAnswer, agentName, runStats);
          // Re-resolve the gh client too — same expiry risk on the post-run
          // API calls (PR/comment/label) on long runs.
          const ghNow = await ghProvider();
          // Re-check for an open PR on this branch right before creating one.
          // The branch was resolved at run start, but a long agent run may have
          // raced with a human closing/merging the PR in the meantime — re-query
          // so we either reuse the still-open PR or open a fresh one.
          const openNow = await ghNow.findOpenPRForIssue(input.repo, input.issueNumber, agentSlug);
          let pr: { number: number; html_url: string };
          if (openNow) {
            // Force-push already landed the new commits on the existing branch.
            pr = openNow;
            log_.info({ pr: pr.html_url, changedFiles, reused: true }, "updated existing PR (follow-up)");
          } else {
            pr = await ghNow.createPullRequest(
              input.repo,
              branchName,
              baseBranch,
              `Fixes #${issue.number}: ${issue.title}`,
              prBody,
            );
            log_.info({ pr: pr.html_url, changedFiles }, "opened PR");
          }
          const prUrl = pr.html_url;

          await swapLabel(ghNow, input.repo, input.issueNumber, labels, "cooked", log_);

          const commentBody = buildIssueComment(profile, agentAnswer, agentName, runStats);
          const commentUrl = await ghNow.createIssueComment(input.repo, input.issueNumber, commentBody);
          if (runStore) {
            runStore.updateRun(jobId, {
              profile: profile.name,
              model: profile.model,
              status: "succeeded",
              pr_url: prUrl,
              comment_url: commentUrl,
              summary: agentAnswer ?? null,
              finished_at: nowIso(),
            });
          }
          return {
            profile: profile.name,
            model: profile.model,
            changedFiles,
            agentAnswer,
            prUrl,
            commentUrl,
            sessionPath,
          };
        }
      }

      // 9. No changes (or errored) — post the agent's answer / error text and
      // record the run. An errored run swaps to the red `failed` label and posts
      // a templated error comment; a clean no-change run swaps to `cooked`.
      const ghNow = await ghProvider();
      await swapLabel(ghNow, input.repo, input.issueNumber, labels, errored ? "failed" : "cooked", log_);
      const commentBody = errored
        ? buildErrorComment(profile, stopReason.errorMessage ?? "unknown error", agentName, runStats)
        : buildIssueComment(profile, agentAnswer, agentName, runStats);
      const commentUrl = await ghNow.createIssueComment(input.repo, input.issueNumber, commentBody);
      if (errored) {
        log_.warn({ hasAnswer: !!agentAnswer }, "agent errored; posted error comment");
      } else {
        log_.warn({ hasAnswer: !!agentAnswer }, "no changes produced");
      }
      if (runStore) {
        runStore.updateRun(jobId, {
          profile: profile.name,
          model: profile.model,
          status: errored ? "failed" : "no_changes",
          error: errored ? (stopReason.errorMessage ?? "agent run ended on error") : null,
          comment_url: commentUrl,
          summary: agentAnswer ?? null,
          finished_at: nowIso(),
        });
      }
      return {
        profile: profile.name,
        model: profile.model,
        changedFiles: [],
        agentAnswer,
        commentUrl,
        sessionPath,
      };
    } finally {
      teardownDisposeGuard();
    }
  } catch (e) {
    // Mark the run failed (rethrow so the caller still sees the error). Also
    // swap the cooking → failed label: the run added the cooking label at the
    // start, and a thrown error skips the normal terminal-label path. Without
    // this cleanup the cooking label would linger, and the concurrency gate
    // above would block every retry of this failed run forever. Best-effort —
    // a transient API failure here must not mask the original error.
    try {
      await swapLabel(gh, input.repo, input.issueNumber, labels, "failed", log_);
    } catch (cleanupErr) {
      log_.warn({ err: cleanupErr }, "could not swap cooking→failed label after error");
    }
    // Post an error comment so the reporter knows the run failed and why.
    // Best-effort — a failure here must not mask the original error.
    try {
      const commentBody = buildErrorComment(profile, (e as Error).message ?? String(e), agentName);
      await gh.createIssueComment(input.repo, input.issueNumber, commentBody);
    } catch (commentErr) {
      log_.warn({ err: commentErr }, "could not post error comment after failure");
    }
    if (runStore) {
      runStore.updateRun(jobId, { status: "failed", error: (e as Error).message ?? String(e), finished_at: nowIso() });
    }
    throw e;
  } finally {
    await ws.dispose();
  }
}

/** Current time as an ISO 8601 string (for runs.finished_at columns). */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Bare branch name for an issue's first attempt: `<agent>/issue-<n>`. Stable
 * across runs of the same issue so a follow-up run (when the previous PR is
 * still open) reuses it. Closed/merged PRs are not reused, so a retry after
 * rejection gets this same bare name — and since the old PR is gone, reusing
 * the name just re-opens a fresh PR on the same clean branch. (The lookup in
 * `findOpenPRForIssue` keys off this pattern.)
 */
function branchNameFor(issueNumber: number, agentSlug: string): string {
  return `${agentSlug}/issue-${issueNumber}`;
}

/**
 * Install a temporary `uncaughtException` listener that swallows ONE specific
 * benign error from pi: after `session.dispose()`, a lingering bash-tool PTY
 * socket can emit a final data chunk whose handler calls into the (now-stopped)
 * agent event loop, throwing "Agent listener invoked outside active run". The
 * throw happens inside an async socket callback, so no try/catch in Noodle can
 * reach it — without this guard Node kills the process and a finished run loses
 * its commit/PR/comment.
 *
 * Returns a teardown function. ONLY this exact error is tolerated; for any
 * other uncaughtException the guard removes itself and re-emits the error so
 * Node's default crash handling (or the next listener) runs — genuine bugs
 * still surface loudly. Re-throwing inside an uncaughtException listener is
 * unreliable across Node versions, so we remove + re-emit instead.
 *
 * Exported for unit testing.
 */
export function suppressPostDisposeBashRace(log_: typeof log): () => void {
  const guard = (err: Error) => {
    if (/Agent listener invoked outside active run/i.test(err.message)) {
      log_.debug({ err: err.message }, "ignored benign post-dispose bash-socket error from pi");
      return;
    }
    // Anything else is a real bug — step aside and let the default handler run.
    // Remove first to avoid an infinite re-emit loop, then re-emit.
    process.removeListener("uncaughtException", guard);
    process.emit("uncaughtException", err);
  };
  process.prependListener("uncaughtException", guard);
  return () => process.removeListener("uncaughtException", guard);
}

// Re-export the runtime-neutral helpers (now living in runtime.ts) so existing
// imports from run.js — cron-run.ts + the stop-reason / summary-fallback tests —
// keep resolving. The canonical implementations are in runtime.ts.
export { extractLastAssistantText, lastAssistantStopReason } from "./runtime.js";

/**
 * Terminal label state for a finished run: `cooked` (success / clean no-change)
 * or `failed` (errored). Drives which label gets applied when cooking is removed.
 */
type TerminalLabel = "cooked" | "failed";

/**
 * Swap the cooking → terminal status label on an issue. Removal of `cooking` is
 * best-effort: if it fails (transient API error, label already gone, etc.) we
 * still add the terminal label and log the removal error rather than aborting —
 * the run has already produced its PR/comment, and a stuck cooking tag is
 * preferable to losing the terminal tag and a clean outcome signal.
 */
async function swapLabel(
  gh: GitHubClient,
  repo: string,
  issue: number,
  labels: ReturnType<typeof labelsFor>,
  terminal: TerminalLabel,
  log_ = log,
): Promise<void> {
  try {
    await gh.removeIssueLabel(repo, issue, labels.cooking.name);
  } catch (e) {
    log_.warn({ err: e, label: labels.cooking.name }, `could not remove cooking label; ${terminal} label will still be added`);
  }
  await gh.addIssueLabel(repo, issue, labels[terminal].name);
}

// --- output builders (exported for testing) --------------------------------
// The agent's final message IS the comment/PR body — posted verbatim, with a
// rich footer appended: who ran on what model, timing, token usage, cost, and a
// random dev-humor one-liner. When the agent produced no final message, a short
// deterministic fallback keeps the run useful instead of posting nothing.

/**
 * Generic dev-humor one-liners. One is picked at random per footer — a small
 * bit of personality at the bottom of each comment. Kept G-rated and on-theme
 * for a coding agent.
 */
const FUN_LINES: string[] = [
  "Commit message written, coffee consumed, bug squashed.",
  "100% more deterministic than my morning routine.",
  "Powered by tokens, caffeine, and mild anxiety.",
  "This code is definitely production-ready. Probably.",
  "Plot twist: the tests passed on the first try.",
  "rm -rf / was NOT run. You're welcome.",
  "If it compiles, it ships. (Please review anyway.)",
  "Semicolons: the cause of, and solution to, all of life's problems.",
  "I've seen things you people wouldn't believe. Stack traces on fire.",
  "There are 10 types of people: those who read this in binary, and the rest.",
  "404: better punchline not found.",
  "Optimism: deploying on a Friday.",
];

/** Format a millisecond duration as a human-readable "1m 23s" / "42s" string. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Compact token count with a magnitude suffix: 842 → "842", 45210 → "45.21K",
 * 6154663 → "6.15M", 12017498 → "12.02B". Trailing zeros are trimmed so 10000
 * renders as "10K" not "10.00K". Sub-1000 counts stay as plain integers.
 */
function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  for (const [div, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (abs >= div) {
      return `${(n / div).toFixed(2).replace(/\.?0+$/, "")}${suffix}`;
    }
  }
  return String(Math.round(n));
}

// Integer percent of `part` relative to `whole`. Returns "0%" when whole is 0
// rather than NaN — should never hit at runtime but cheap to be defensive.
function pctOf(part: number, whole: number): string {
  if (!whole) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

/** Format a USD cost, trimming to cents for small amounts. */
function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Display name for human-facing output (comments/PR body): the configured agent
 * name with an `-Agent` suffix, e.g. "Noodle" → "Noodle-Agent". No-op if the
 * name already ends in "Agent" (case-insensitive). Internal uses (git identity,
 * labels, prompts) keep the raw config name.
 */
function displayName(agentName: string): string {
  return /agent$/i.test(agentName) ? agentName : `${agentName}-Agent`;
}

/**
 * Build the rich footer block, one fact per line:
 *
 *   🤖 **Noodle-Agent**
 *   Profile: claude (anthropic/claude-sonnet-4-20250514)
 *   Cooked for: 4m 12s · 8 tool calls · 3 turns
 *   Tokens: 45.21K in · 3.18K out · 48.39K total
 *   Cost: $0.18
 *   *<random fun line>*
 *
 * Token and cost lines are omitted when not applicable: local/custom models
 * with no pricing show tokens but no cost; a missing stats object shows neither.
 */
export function buildFooter(
  profile: { name: string; provider: string; model: string },
  agentName: string,
  stats?: RunStats,
): string {
  const lines: string[] = [];

  // Line 1: agent name only.
  lines.push(`🤖 **${displayName(agentName)}**`);

  // Line 2: profile + model. The PR link is intentionally not repeated here —
  // the issue already shows the linked PR in its timeline, and the PR body has
  // its own footer without this line.
  lines.push(`Profile: ${profile.name} (\`${profile.provider}/${profile.model}\`)`);

  // Line 3+: stats (only if we have something to show).
  if (stats) {
    // Cooked for: duration · tool calls · turns
    const cooked: string[] = [`Cooked for: ${formatDuration(stats.durationMs)}`];
    if (stats.toolCalls != null) cooked.push(`${stats.toolCalls} tool calls`);
    if (stats.turns != null) cooked.push(`${stats.turns} turns`);
    lines.push(cooked.join(" · "));

    // Tokens (only if non-trivial).
    if (stats.tokens && stats.tokens.total > 0) {
      const t = stats.tokens;
      const parts = [
        `${formatTokens(t.input)} in`,
        `${formatTokens(t.output)} out`,
      ];
      // Cache tokens only surface for providers that support prompt caching
      // (Anthropic, an Anthropic-protocol proxy). Rendered as a percentage of
      // input tokens — the ratio that actually tells you how much was reused
      // vs reread.
      if (t.cacheRead > 0) parts.push(`${pctOf(t.cacheRead, t.input)} cache read`);
      if (t.cacheWrite > 0) parts.push(`${pctOf(t.cacheWrite, t.input)} cache write`);
      parts.push(`${formatTokens(t.total)} total`);
      lines.push(`Tokens: ${parts.join(" · ")}`);

      // Cost (only when priced — built-in providers, or custom endpoints with
      // *_price fields set in the config).
      if (stats.cost != null && stats.cost > 0) {
        lines.push(`Cost: ${formatCost(stats.cost)}`);
      }
    }
  }

  // Random fun line.
  lines.push(`*${FUN_LINES[Math.floor(Math.random() * FUN_LINES.length)]}*`);
  return lines.join("\n");
}

/**
 * Build the PR body: the agent's message, the changed files, and the footer.
 * When `agentMessage` is missing, a short notice asks the reviewer to check the
 * diff directly.
 */
export function buildPrBody(
  profile: { name: string; provider: string; model: string } | string,
  changedFiles: string[],
  issueUrl: string,
  agentMessage?: string,
  agentName = "Noodle",
  stats?: RunStats,
): string {
  // Accept legacy callsites that pass the profile name as a string.
  const prof = typeof profile === "string"
    ? { name: profile, provider: "unknown", model: "unknown" }
    : profile;
  const lines: string[] = [];
  if (agentMessage) {
    lines.push(agentMessage.trim(), "");
  } else {
    lines.push("_The agent did not leave a summary. Please review the diff carefully._", "");
  }
  if (changedFiles.length) {
    lines.push("**Changed files:**", ...changedFiles.map((f) => `- \`${f}\``), "");
  }
  lines.push("---", buildFooter(prof, agentName, stats), "", `Closes ${issueUrl}`);
  return lines.join("\n");
}

/**
 * Build the issue comment: the agent's message verbatim, then the rich footer.
 *
 * When the agent produced no message, a short generic note is used instead so
 * the issue still gets a response.
 */
export function buildIssueComment(
  profile: { name: string; provider: string; model: string },
  agentMessage: string | undefined,
  agentName = "Noodle",
  stats?: RunStats,
): string {
  const body = agentMessage?.trim() ||
    `_${displayName(agentName)} ran but made no code changes and left no message. The issue may need clarification, or it may not be a code change._`;
  return `${body}\n\n---\n${buildFooter(profile, agentName, stats)}`;
}

/**
 * Build the issue comment for an errored run. The reporter gets an honest,
 * templated notice that the agent failed — with the actual error text quoted in
 * a blockquote so the cause (quota, rate limit, server error) is visible for
 * debugging — plus the rich footer (stats captured up to the point of failure).
 */
export function buildErrorComment(
  profile: { name: string; provider: string; model: string },
  errorMessage: string,
  agentName = "Noodle",
  stats?: RunStats,
): string {
  const err = errorMessage.trim() || "unknown error";
  const name = displayName(agentName);
  const body =
    `⚠️ **${name}'s run on this issue errored out before finishing.**\n\n` +
    `> \`${err}\`\n\n` +
    `No changes were made. The run may be retried once the underlying issue ` +
    `(API quota, rate limit, provider outage, etc.) is resolved.`;
  return `${body}\n\n---\n${buildFooter(profile, agentName, stats)}`;
}
