import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai/compat";
// pi's own classifier: returns false on errors that won't recover on retry
// (404 Not Found, 401/403 auth, quota exhaustion, context overflow). Reusing it
// keeps our fail-fast list in sync with pi's retryable list.
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { log, runLogger } from "../util/log.js";
import { registerCustomProviders } from "../profiles/custom-providers.js";
import { GitHubClient } from "../github/client.js";
import { Workspace, cloneUrlFor } from "./workspace.js";
import { expandTags } from "./tags.js";
import { generateIssueTitle, phraseOutput, templateTitle } from "./title.js";
import { installSkills } from "../util/paths.js";
import { collectSysFacts, buildSysInfoGuidance } from "../util/sysinfo.js";
import { throttleForRpm, throttleExtensionFactory } from "./throttle.js";
import { buildSettingsManager } from "./pi-settings.js";
import { StallWatcher, StallTimeoutError } from "./stall.js";
import type { LiveRunRegistry } from "./live-runs.js";
import { defaultLabelSet, parseLabelSet, labelDescription, type LabelSet } from "./labels.js";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { RunStore } from "../server/run-store.js";
import type { NoodleConfig, Profile } from "../config/schema.js";
import {
  buildFooter,
  buildPrBody,
  extractLastAssistantText,
  lastAssistantStopReason,
  suppressPostDisposeBashRace,
  type RunResult,
  type RunStats,
} from "./run.js";

/** AuthStorage instance type (its constructor is private; use the factory's return type). */
type AuthStorageInstance = ReturnType<typeof AuthStorage.create>;

/**
 * Color applied to the agent-name label on background-run output — teal
 * (#008672, without the leading '#'). Makes scheduler/trigger output visually
 * distinct in a triage list.
 */
const BACKGROUND_LABEL_COLOR = "008672";

/**
 * Session restart loop: when session.prompt() throws after pi's own 5-attempt
 * retry is exhausted, we reopen the SAME session file (full context survives on
 * disk), create a fresh session, and try again. This catches sustained provider
 * outages that outlast both the forwarder's 429-absorption and pi's internal
 * retry. Flat 2-minute backoff between each restart.
 */
const SESSION_RESTART_ATTEMPTS = 3;
const SESSION_RESTART_DELAY_MS = 120_000; // 2 minutes
/** Hard cap on total restarts across all reset cycles, so progress-based resets
 *  can't loop forever on a provider that keeps failing after partial work. */
const SESSION_RESTART_HARD_CAP = 9;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * What kind of background run this is. The only effect is the prompt framing
 * (scheduler = "scheduled task", trigger = "responding to a GitHub event" +
 * event type/action header). Everything else — branch model, output pipeline,
 * conflict resolution — is identical.
 */
export type RunKind = "scheduler" | "trigger";

/**
 * Input for a background run (scheduler or trigger). Neither kind has a source
 * issue — the agent works a freeform prompt and its final message is delivered
 * as a PR (when the run made code changes) or an issue (no-changes / error).
 */
export interface BackgroundRunInput {
  /** "owner/name" */
  repo: string;
  /** Freeform task prompt (e.g. "find bugs and open issues"). */
  prompt: string;
  /**
   * Trunk branch the run's work stacks on (e.g. "noodle/schedule-bug-hunt" or
   * "noodle/trigger-on-push"). Derived at dispatch time from the schedule's or
   * trigger's name. Long-lived: run 1 creates it from the default branch, later
   * runs fetch it, sync it with main (merge), then either work on it directly
   * (no open PR) or stack a fresh branch off it (open PR exists).
   */
  branchName: string;
  /** Display name (schedule or trigger name) — for PR titles, manual-sync issues, commit msgs. */
  displayName: string;
  /** Resolved profile name, or null/undefined for the config default. */
  profile?: string | null;
  /** Job id for tmp dir + logs + session persistence. */
  jobId?: string;
  /** GitHub token for the clone URL. Defaults to GITHUB_TOKEN env. */
  token?: string;
  /** What kind of run this is — controls prompt framing only. */
  runKind: RunKind;
  /** Trigger-only: the event type/action that fired (e.g. { type: "issues", action: "opened" }). */
  eventContext?: { type: string; action: string | null };
}

/**
 * Dependencies for a background run. Both kinds share the same engine; the only
 * kind-specific hook is `onStatus` (used by triggers to update their DB row's
 * status field) and `outputLabelPrefix` (controls whether the output label is
 * `${agent}-Issue` or `${agent}-Trigger`).
 */
export interface BackgroundRunDeps {
  authStorage?: AuthStorageInstance;
  runStore?: RunStore;
  /**
   * Live run registry — when set, the run registers its pi session here so the
   * cancel endpoint can abort it mid-flight. See LiveRunRegistry.
   */
  liveRuns?: LiveRunRegistry;
  createAgentSessionFn?: typeof createAgentSession;
  tokenProvider?: () => Promise<string>;
  /** Custom system prompt text from the settings DB (same as runJob). */
  systemPrompt?: string;
  /**
   * Custom label-set override (JSON string from the schedule/trigger row's
   * `labels` field). When null/absent, the global Settings labels apply.
   */
  labelOverrides?: string | null;
  /**
   * Called at run start (status="running"), success (status="succeeded"), and
   * failure (status="failed"). Triggers use this to update their DB row's
   * status; schedulers don't pass one (they have no equivalent column).
   */
  onStatus?: (status: "running" | "succeeded" | "failed") => void;
  /**
   * Which suffix to use on the output label: `${agent}-Issue` (scheduler) or
   * `${agent}-Trigger` (trigger). Defaults to "Issue".
   */
  outputLabelPrefix?: "Issue" | "Trigger";
}

/**
 * Run one background job end-to-end (scheduler cron tick OR webhook trigger):
 * resolve profile → clone → trunk + sync + branch → run pi → commit + push →
 * open PR/issue → record the run. Shared by both activation paths; they differ
 * only in prompt framing and the `onStatus` side-effect hook.
 *
 * Trunk + stacked-branch model (identical for both kinds):
 *   - Trunk doesn't exist → create from default branch.
 *   - Trunk exists → fetch it, merge `origin/<default>` into it. If conflict,
 *     a bounded agent pass resolves; on failure the merge is aborted and a
 *     "needs manual sync" issue is opened.
 *   - Open PR on trunk → stack this run on a fresh `<trunk>-<hash>` branch,
 *     open a stacked PR targeting the trunk. Otherwise work directly on the
 *     trunk and open a PR targeting the default branch.
 *
 * No force push anywhere: trunks get merge/resolution commits (fast-forward
 * pushable), stacked branches are new refs.
 */
export async function runBackgroundJob(
  config: NoodleConfig,
  gh: GitHubClient,
  input: BackgroundRunInput,
  deps?: BackgroundRunDeps,
): Promise<RunResult> {
  const jobId = input.jobId ?? `bg-${input.repo.replace("/", "-")}`;
  const branchName = input.branchName;
  const outputLabelPrefix = deps?.outputLabelPrefix ?? "Issue";

  const log_ = runLogger({
    jobId,
    repo: input.repo,
    branch: branchName,
    pid: process.pid,
  });
  log.info("═══════════════════════════════════════════════════════════════");
  log.info(
    `${input.runKind} run started — repo=${input.repo} | branch=${branchName}` +
      (input.runKind === "trigger" && input.eventContext
        ? ` | event=${input.eventContext.type}${input.eventContext.action ? `.${input.eventContext.action}` : ""}`
        : "") +
      ` | jobId=${jobId} | pid=${process.pid}`,
  );

  // Trigger-only status hook (scheduler has no equivalent).
  deps?.onStatus?.("running");

  const runStore = deps?.runStore;
  if (runStore) {
    runStore.createRun({
      job_id: jobId,
      repo: input.repo,
      issue: null,
      branch: branchName,
    });
  }

  try {
    // 1. Resolve profile: explicit, else the config default.
    const profileName = input.profile ?? config.default_profile;
    if (!profileName) {
      throw new Error("No profile specified and no default_profile is configured.");
    }
    const profileDef = config.profiles[profileName];
    if (!profileDef) {
      throw new Error(
        `${input.runKind === "trigger" ? "Trigger" : "Cron"} profile "${profileName}" is not defined in profiles (default_profile: ${config.default_profile ?? "(none)"}).`,
      );
    }
    const profile = { name: profileName, provider: profileName, ...profileDef };
    log_.info({ profile: profile.name, model: profile.model }, "routed profile");

    // 2. Resolve model via the registry.
    const authStorage = deps?.authStorage ?? AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const providerKeyMap = registerCustomProviders(config, modelRegistry);
    const providerKey = providerKeyMap.get(profile.name) ?? profile.name;
    let model: Model<Api> | undefined;
    try {
      model = modelRegistry.find(providerKey, profile.model);
    } catch (e) {
      throw new Error(
        `Could not resolve model "${providerKey}/${profile.model}". ` +
          `Check the profile config. (${(e as Error).message})`,
      );
    }
    if (!model) {
      throw new Error(`Could not resolve model "${providerKey}/${profile.model}".`);
    }

    // 3. Clone.
    const tokenProvider = deps?.tokenProvider ?? (async () => input.token ?? "");
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
      // 4. Trunk + stacked-branch resolution. See runBackgroundJob doc comment.
      const baseBranch = await gh.defaultBranch(input.repo);
      const trunkExists = await tryFetchBranch(ws, branchName, cloneUrlFor(input.repo, await freshToken()), log_);
      if (trunkExists) {
        await ws.checkoutOrReuse(branchName, cloneUrlFor(input.repo, await freshToken()));
        const mergeResult = await ws.mergeMain(baseBranch, cloneUrlFor(input.repo, await freshToken()));
        if (mergeResult.conflicted) {
          log_.warn({ files: mergeResult.files }, "trunk conflicted with main — spawning resolver");
          const resolved = await runConflictResolver(
            ws,
            { model, authStorage, modelRegistry, profile, config, createAgentSessionFn: deps?.createAgentSessionFn, log_ },
            mergeResult.files,
          );
          if (!resolved) {
            await ws.abortMerge();
            log_.error({ branch: branchName, files: mergeResult.files }, "could not resolve trunk conflicts — opening manual-sync issue");
            const syncIssueBody = buildManualSyncBody(
              config.agent_name,
              input.displayName,
              input.runKind,
              branchName,
              baseBranch,
              mergeResult.files,
              buildFooter(profile, config.agent_name, { durationMs: 0 }),
            );
            const syncTitle = `${input.runKind === "trigger" ? "Trigger" : "Schedule"} "${input.displayName}" — manual sync needed (conflict with ${baseBranch})`;
            const syncLabel = `${config.agent_name}-${outputLabelPrefix}`;
            await gh.ensureLabel(
              input.repo,
              syncLabel,
              BACKGROUND_LABEL_COLOR,
              `${config.agent_name}-Agent ${input.runKind} job result`,
            );
            const labelSet: LabelSet = parseLabelSet(deps?.labelOverrides ?? null) ?? defaultLabelSet();
            const failedLabel = labelSet.failed;
            await gh.ensureLabel(input.repo, failedLabel.name, failedLabel.color, labelDescription("failed"));
            const syncIssue = await gh.createIssue(input.repo, syncTitle, syncIssueBody, [syncLabel, failedLabel.name]);
            log_.warn({ issue: syncIssue.number, url: syncIssue.html_url }, "opened manual-sync issue for trunk conflict");
            if (runStore) {
              runStore.updateRun(jobId, {
                profile: profile.name,
                model: profile.model,
                status: "failed",
                error: `trunk conflicted with ${baseBranch}; resolver could not clean it up`,
                output_issue_url: syncIssue.html_url,
                finished_at: nowIso(),
              });
            }
            deps?.onStatus?.("failed");
            return {
              profile: profile.name,
              model: profile.model,
              changedFiles: [],
              agentAnswer: undefined,
              commentUrl: "",
              sessionPath: undefined,
              outputIssueUrl: syncIssue.html_url,
            };
          }
          // Resolver committed on the trunk. Push so any existing open PR absorbs
          // the merge-sync commit and stays mergeable. Plain push — fast-forward.
          await ws.push(branchName, cloneUrlFor(input.repo, await freshToken()), false);
          log_.info({ branch: branchName }, "pushed trunk after resolver — existing PR (if any) updated");
        }
      } else {
        await ws.branch(branchName);
      }
      const openPR = trunkExists ? await gh.findOpenPRByBranch(input.repo, branchName) : null;
      let workBranch: string;
      let prBase: string;
      if (openPR) {
        workBranch = `${branchName}-${randomHash(3)}`;
        await ws.branchFrom(workBranch, branchName, cloneUrlFor(input.repo, await freshToken()));
        prBase = branchName;
        log_.info({ trunk: branchName, workBranch, prNumber: openPR.number }, "open PR on trunk — stacking new branch");
      } else {
        workBranch = branchName;
        prBase = baseBranch;
      }
      await installSkills(ws.path);

      // 5. Build prompt + resource loader.
      const sysFacts = collectSysFacts();
      log_.debug({ sysFacts }, "probed system info for background-run prompt");
      const sysInfo = buildSysInfoGuidance(sysFacts);
      let fullSysInfo = sysInfo;
      if (deps?.systemPrompt) {
        try {
          const expanded = await expandTags(deps.systemPrompt, { sysFacts, gh, repo: input.repo });
          if (expanded.trim()) {
            const referencesSystem = /\{system(\.|})/i.test(deps.systemPrompt);
            fullSysInfo = referencesSystem ? expanded : `${expanded}\n\n---\n\n${sysInfo}`;
          }
        } catch (e) {
          log_.warn({ err: (e as Error).message }, "failed to expand system prompt tags — using sysInfo only");
        }
      }
      // Expand {pr}, {issue}, {system}, etc. tags in the freeform task prompt
      // too — the operator writes them in the schedule/trigger task exactly
      // like in the system prompt. Falls back to the raw prompt on any failure
      // so a transient GitHub API error can't block the run.
      let taskPrompt = input.prompt;
      try {
        taskPrompt = await expandTags(input.prompt, { sysFacts, gh, repo: input.repo });
      } catch (e) {
        log_.warn({ err: (e as Error).message }, "failed to expand task prompt tags — using raw task");
      }
      const prompt = buildBackgroundPrompt({ ...input, prompt: taskPrompt }, config.agent_name, fullSysInfo);
      const throttle = throttleForRpm(profile.api_rpm);
      const settingsManager = buildSettingsManager(ws.path, join(ws.path, ".noodle-agent"), profile);
      const loader = new DefaultResourceLoader({
        cwd: ws.path,
        agentDir: join(ws.path, ".noodle-agent"),
        settingsManager,
        ...(throttle
          ? { extensionFactories: [throttleExtensionFactory(throttle, `${profile.name}/${profile.model}`)] }
          : {}),
      });
      await loader.reload();

      // 6. Create pi session + run (with restart loop).
      const sessionDir = sessionsDirFor(jobId);
      const create = deps?.createAgentSessionFn ?? createAgentSession;
      const idleMs = (config.run?.stall_timeout_minutes ?? 0) * 60_000;
      const toolMs = (config.run?.tool_stall_minutes ?? 0) * 60_000;
      // The rate-limit stall budget shares the idle (stall_timeout_minutes)
      // value: it's the same notion of "no real progress for this long → abort."
      // See StallWatcher for why the rate-limit budget is a separate mechanism
      // from the idle budget despite sharing the same duration.
      const rateLimitMs = idleMs;
      const sessionCreateOpts = {
        cwd: ws.path,
        model,
        authStorage,
        modelRegistry,
        settingsManager,
        resourceLoader: loader,
        thinkingLevel: profile.thinking_level,
        tools: profile.tools,
      };

      const bootSession = async (sessionManager: SessionManager) => {
        const { session } = await create({ ...sessionCreateOpts, sessionManager });
        subscribeForLogging(session, log_);
        const watcher = new StallWatcher(session, { idleTimeoutMs: idleMs, toolTimeoutMs: toolMs, rateLimitTimeoutMs: rateLimitMs });
        const unsubStall = watcher.attach();
        // Register the live session so the cancel endpoint can abort it.
        // Updated on every restart so the registry always holds the current one.
        deps?.liveRuns?.set(jobId, session);
        return { session, sessionManager, watcher, unsubStall };
      };

      log_.info({ idleTimeoutMs: idleMs || "off", toolTimeoutMs: toolMs || "off", rateLimitTimeoutMs: rateLimitMs || "off" }, "starting background run");
      const startedAt = Date.now();

      let currentManager = SessionManager.create(ws.path, sessionDir);
      let booted = await bootSession(currentManager);
      let promptError: unknown = null;

      for (let attempt = 0, totalRestarts = 0; attempt <= SESSION_RESTART_ATTEMPTS; attempt++, totalRestarts++) {
        if (totalRestarts > SESSION_RESTART_HARD_CAP) {
          log_.warn({ totalRestarts }, "hit hard cap on total restarts — giving up");
          break;
        }
        const { session, watcher, unsubStall } = booted;
        const turnsBefore = session.getSessionStats?.()?.assistantMessages ?? 0;
        try {
          await session.prompt(attempt === 0 ? prompt : "Continue. The previous attempt failed — pick up where you left off.");
        } catch (e) {
          watcher.dispose();
          unsubStall?.();
          if (watcher.didStall) {
            // A stall is fatal to the whole run — throw out of the restart loop.
            // The queue treats StallTimeoutError as non-retryable, so the job
            // dies instead of looping. Use the tripped budget for an accurate
            // duration/label (rateLimit measures consecutive 429 time, not idle).
            const budget = watcher.trippedBudget ?? watcher.activeBudget;
            const stalledForMs = budget === "tool" ? toolMs : budget === "rateLimit" ? rateLimitMs : idleMs;
            throw new StallTimeoutError(stalledForMs || 0, budget);
          }
          promptError = e;
        }
        if (!promptError) {
          const sr = lastAssistantStopReason(session);
          if (sr.stopReason === "error") {
            promptError = new Error(sr.errorMessage ?? "agent run ended on error (stopReason=error)");
          }
        }
        if (!promptError) {
          watcher.dispose();
          unsubStall?.();
          break;
        }
        watcher.dispose();
        unsubStall?.();

        // Fail fast on non-retryable errors (404, auth, quota, context overflow).
        // These never recover on retry — but pi still counts the errored assistant
        // turn, which the "made progress" branch below misreads as real work and
        // uses to reset the restart budget forever. So we'd loop until the hard
        // cap, burning the 2-minute backoff each time, for a config error that a
        // single attempt already proved fatal. Break now and surface the error.
        const lastStop = lastAssistantStopReason(session);
        if (
          lastStop.stopReason === "error" &&
          lastStop.errorMessage &&
          // isRetryableAssistantError only reads stopReason + errorMessage, so a
          // minimal shape is enough — cast through unknown to satisfy its full
          // AssistantMessage parameter type without fabricating the other fields.
          !isRetryableAssistantError({ stopReason: "error", errorMessage: lastStop.errorMessage } as unknown as Parameters<typeof isRetryableAssistantError>[0])
        ) {
          log_.warn(
            { err: lastStop.errorMessage },
            "non-retryable error — stopping restart loop (will not recover on retry)",
          );
          break;
        }

        // If the agent completed new turns before failing, it MIGHT have made
        // real progress — reset the restart counter so a run that's actively
        // working always gets 3 fresh restarts. BUT pi also counts 429-failed
        // (error-stopped) turns in assistantMessages, which are NOT real
        // progress: they're just "we tried, got 429'd, stopped." Without this
        // guard a sustained 429 storm resets the budget every cycle and loops
        // until the hard cap. Only reset when the last turn was NOT an error.
        const turnsAfter = session.getSessionStats?.()?.assistantMessages ?? 0;
        const lastWasError = lastAssistantStopReason(session).stopReason === "error";
        if (turnsAfter > turnsBefore && !lastWasError) {
          log_.info({ turnsBefore, turnsAfter }, "agent made progress before failure — resetting restart budget");
          attempt = -1; // loop increments to 0 → 3 fresh attempts
        }

        if (attempt >= SESSION_RESTART_ATTEMPTS) break;

        const sessionPath = booted.sessionManager.getSessionFile();
        try { await session.dispose?.(); } catch { /* best-effort */ }
        log_.warn(
          { err: (promptError as Error).message ?? String(promptError), restartAttempt: attempt + 2, maxRestarts: SESSION_RESTART_ATTEMPTS, delayMs: SESSION_RESTART_DELAY_MS },
          "session.prompt() failed — will restart with same session after backoff",
        );
        await sleep(SESSION_RESTART_DELAY_MS);
        currentManager = SessionManager.open(sessionPath!, sessionDir, ws.path);
        booted = await bootSession(currentManager);
        log_.info({ restartAttempt: attempt + 2 }, "restarted session from saved context");
      }

      if (promptError) {
        throw promptError;
      }

      const session = booted.session;
      const sessionManager = booted.sessionManager;
      const durationMs = Date.now() - startedAt;

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
          "background run stats",
        );
        await session.dispose?.();
        log_.info("background run finished");

        const sessionPath = sessionManager.getSessionFile() ?? undefined;
        if (runStore && sessionPath) {
          runStore.updateRun(jobId, { session_path: sessionPath });
        }

        // Detect error termination vs capture the agent's final message.
        const stopReason = lastAssistantStopReason(session);
        const errored = stopReason.stopReason === "error";
        if (errored) {
          log_.error({ errorMessage: stopReason.errorMessage, stopReason: stopReason.stopReason }, "background run ended on error");
        } else {
          agentAnswer = extractLastAssistantText(session);
          if (agentAnswer) {
            agentAnswer = await phraseOutput(agentAnswer, profile);
          }
        }

        // Commit + push. PR when changes+success, issue when no-changes/error.
        await ws.removeInternals();
        const changedFiles: string[] = [];
        let prUrl = "";
        let issueUrl = "";
        if (!errored) {
          const committed = await ws.commitAll(
            `${input.runKind} run (${input.displayName})\n\n${input.runKind === "trigger" ? "Trigger" : "Scheduled"} run by ${config.agent_name} (profile: ${profile.name}).`,
          );
          if (committed) {
            await ws.push(workBranch, cloneUrlFor(input.repo, await freshToken()), false);
            log_.info({ branch: workBranch, prBase }, "pushed background-run work branch");
            changedFiles.push(...(await ws.changedFiles()));
          }
        }

        const outputLabel = `${config.agent_name}-${outputLabelPrefix}`;
        await gh.ensureLabel(
          input.repo,
          outputLabel,
          BACKGROUND_LABEL_COLOR,
          `${config.agent_name}-Agent ${input.runKind} job result`,
        );
        const labelSet: LabelSet = parseLabelSet(deps?.labelOverrides ?? null) ?? defaultLabelSet();
        const outcomeStage = errored ? "failed" : "cooked";
        const outcome = labelSet[outcomeStage];
        await gh.ensureLabel(input.repo, outcome.name, outcome.color, labelDescription(outcomeStage));

        if (!errored && changedFiles.length > 0) {
          const prTitle = await generateIssueTitle(agentAnswer ?? "", input.prompt, profile);
          const prBody = buildPrBody(profile, changedFiles, "", agentAnswer, config.agent_name, runStats);
          const pr = await gh.createPullRequest(input.repo, workBranch, prBase, prTitle, prBody);
          prUrl = pr.html_url;
          try {
            await gh.addIssueLabel(input.repo, pr.number, outputLabel);
            await gh.addIssueLabel(input.repo, pr.number, outcome.name);
          } catch (labelErr) {
            log_.warn({ err: (labelErr as Error).message, pr: pr.number }, "could not apply labels to background-run PR");
          }
          log_.info({ pr: pr.number, url: prUrl, base: prBase, changedFiles }, "opened background-run output PR");
        } else {
          const issueBody = errored
            ? buildBackgroundErrorBody(config.agent_name, input.runKind, stopReason.errorMessage ?? "agent run ended on error", buildFooter(profile, config.agent_name, runStats))
            : buildBackgroundIssueBody(agentAnswer, buildFooter(profile, config.agent_name, runStats));
          const issueTitle = errored
            ? templateTitle(input.prompt)
            : await generateIssueTitle(agentAnswer ?? "", input.prompt, profile);
          const issue = await gh.createIssue(input.repo, issueTitle, issueBody, [outputLabel, outcome.name]);
          issueUrl = issue.html_url;
          log_.info({ issue: issue.number, url: issueUrl, errored, hadChanges: changedFiles.length > 0 }, "opened background-run output issue");
        }

        if (runStore) {
          runStore.updateRun(jobId, {
            profile: profile.name,
            model: profile.model,
            status: errored ? "failed" : "succeeded",
            error: errored ? (stopReason.errorMessage ?? "agent run ended on error") : null,
            summary: agentAnswer ?? null,
            ...(prUrl ? { pr_url: prUrl } : {}),
            ...(issueUrl ? { output_issue_url: issueUrl } : {}),
            finished_at: nowIso(),
          });
        }
        deps?.onStatus?.(errored ? "failed" : "succeeded");
        return {
          profile: profile.name,
          model: profile.model,
          changedFiles,
          agentAnswer,
          commentUrl: "",
          sessionPath,
          ...(prUrl ? { prUrl } : {}),
          ...(issueUrl ? { outputIssueUrl: issueUrl } : {}),
        };
      } finally {
        teardownDisposeGuard();
      }
    } catch (e) {
      if (runStore) {
        runStore.updateRun(jobId, { status: "failed", error: (e as Error).message ?? String(e), finished_at: nowIso() });
      }
      deps?.onStatus?.("failed");
      throw e;
    } finally {
      // Remove from the live registry so a late cancel is a clean no-op.
      deps?.liveRuns?.delete(jobId);
      await ws.dispose();
    }
  } catch (e) {
    if (runStore) {
      runStore.updateRun(jobId, { status: "failed", error: (e as Error).message ?? String(e), finished_at: nowIso() });
    }
    deps?.onStatus?.("failed");
    throw e;
  }
}

/**
 * Build the agent prompt for a background run. Branches on `runKind`:
 *  - scheduler: "You are running a scheduled task in <repo>. This is a scheduled run."
 *  - trigger:   "You are responding to a GitHub event in <repo>. Event: <type>.<action>. This is a trigger run."
 *
 * Everything else (sysInfo prepend, skill-loading, findings-as-final-message
 * contract, task block) is identical. The trigger's event context is just the
 * event type/action name — no payload survives the webhook→queue→run path, and
 * the dead `eventSummary` field was never populated by any caller.
 */
export function buildBackgroundPrompt(input: BackgroundRunInput, agentName: string, sysInfo?: string): string {
  const lines: string[] = [];
  if (sysInfo) {
    lines.push(sysInfo, "", "---", "");
  }
  if (input.runKind === "trigger") {
    lines.push(`You are responding to a GitHub event in the repository \`${input.repo}\`.`);
    const eventContext = input.eventContext;
    if (eventContext) {
      const eventName = eventContext.action ? `${eventContext.type}.${eventContext.action}` : eventContext.type;
      lines.push("", `**Event:** \`${eventName}\``);
    }
  } else {
    lines.push(`You are running a scheduled task in the GitHub repository \`${input.repo}\`.`);
  }
  lines.push(
    "",
    "**Load the skill before starting:**",
    "- `noodle-default` — the always-active engineering mindset (lazy senior dev:",
    "  minimal diff, stdlib first, no over-engineering). It governs how you reason",
    "  about the code you inspect.",
    "",
    input.runKind === "trigger"
      ? "This is a **trigger run** — you were activated because a GitHub event occurred."
      : "This is a **scheduled run** — there is no issue to fix. Investigate the task, then",
  );
  if (input.runKind === "trigger") {
    lines.push(
      "Investigate the situation, then write up your findings as your **final message**",
      "(normal text, in Markdown). Be concrete: for each finding, say what's wrong",
      "and where to find it (file + line). Don't pad with architecture walkthroughs",
      "or restate the event. If you have nothing concrete to report, say so plainly.",
    );
  } else {
    lines.push(
      "write up your findings as your **final message** (normal text, in Markdown).",
      "Be concrete: for each finding, say what's wrong and where to find it (file +",
      "line). Don't pad with architecture walkthroughs or restate the task. If you",
      "have nothing concrete to report, say so plainly.",
    );
  }
  lines.push(
    "",
    `${agentName} opens a pull request when your run makes code changes (your final`,
    "message becomes the PR body), or a single GitHub issue with your final message",
    "as the body when there are no changes. Your final message IS the deliverable.",
    "",
    "## Task",
    "",
    input.prompt.trim() || "_(no task specified)_",
  );
  return lines.join("\n");
}

/**
 * Probe whether a remote branch exists. Returns true when the fetch succeeded
 * (branch is on the remote), false when the fetch failed with a "not found"
 * style error. Other failures (network, auth) are re-thrown so the caller
 * surfaces them instead of silently treating them as "branch doesn't exist".
 *
 * Does NOT check out the branch — the caller does that via `checkoutOrReuse`
 * after deciding how to handle the trunk.
 */
async function tryFetchBranch(
  ws: Workspace,
  name: string,
  freshCloneUrl: string,
  log_: typeof log,
): Promise<boolean> {
  try {
    await (ws as unknown as { git: { fetch: (url: string, ref: string) => Promise<unknown> } }).git.fetch(freshCloneUrl, name);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/not found|doesn't exist|couldn't find|could not find|does not exist|fatal:.*remote ref/i.test(msg)) {
      log_.debug({ branch: name }, "branch does not exist yet — will create fresh");
      return false;
    }
    throw e;
  }
  log_.debug({ branch: name }, "trunk exists on remote");
  return true;
}

/**
 * Short hex string for branch-name uniqueness (e.g. `noodle/schedule-bug-hunt-a4fa3d`).
 */
function randomHash(bytes: number): string {
  return randomBytes(bytes).toString("hex").slice(0, bytes * 2);
}

/**
 * Inputs the conflict-resolver needs to boot a pi session.
 */
interface ConflictResolverDeps {
  model: Model<Api>;
  authStorage: AuthStorageInstance;
  modelRegistry: ReturnType<typeof ModelRegistry.create>;
  profile: Profile & { name: string; provider: string };
  config: NoodleConfig;
  createAgentSessionFn?: typeof createAgentSession;
  log_: typeof log;
}

/**
 * Spawn a bounded agent pass to resolve merge-conflict markers left in the
 * working tree by `ws.mergeMain()`. Same profile/model as the main run, NARROW
 * prompt: clear every conflict marker, stage, commit. No GitHub side effects
 * from this pass — the caller's subsequent trunk push is the visible effect.
 *
 * Tighter restart budget than the main run (1 restart, not 3): conflict
 * resolution is a bounded task, and if one retry can't clear it, we'd rather
 * surface the manual-sync issue than burn tokens on repeated attempts.
 *
 * Returns true when the worktree is clean of conflict markers, false otherwise.
 */
async function runConflictResolver(
  ws: Workspace,
  deps: ConflictResolverDeps,
  conflictedFiles: string[],
): Promise<boolean> {
  const { model, authStorage, modelRegistry, profile, config, log_ } = deps;
  const create = deps.createAgentSessionFn ?? createAgentSession;

  const fileList = conflictedFiles.map((f) => `- \`${f}\``).join("\n");
  const resolverPrompt =
    `The working tree has merge-conflict markers after a \`git merge origin/main\` into this branch. ` +
    `Resolve every conflict marker (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) in the files below by editing them ` +
    `to a correct merged state that preserves both sides' intent — do not blindly pick one side.\n\n` +
    `Conflicted files:\n${fileList}\n\n` +
    `When all markers are gone, stage every change and commit with the message ` +
    `\`merge origin/main (conflicts resolved by ${config.agent_name})\`. ` +
    `Do NOT run tests, do NOT push, do NOT open issues or PRs. Stop after the commit.`;

  const settingsManager = buildSettingsManager(ws.path, join(ws.path, ".noodle-agent"), profile);
  const loader = new DefaultResourceLoader({ cwd: ws.path, agentDir: join(ws.path, ".noodle-agent"), settingsManager });
  await loader.reload();

  const sessionDir = sessionsDirFor(`resolver-${Date.now()}`);
  const idleMs = (config.run?.stall_timeout_minutes ?? 0) * 60_000;
  const toolMs = (config.run?.tool_stall_minutes ?? 0) * 60_000;
  const rateLimitMs = idleMs;
  const sessionCreateOpts = {
    cwd: ws.path,
    model,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader: loader,
    thinkingLevel: profile.thinking_level,
    tools: profile.tools,
  };

  const bootSession = async (sessionManager: SessionManager) => {
    const { session } = await create({ ...sessionCreateOpts, sessionManager });
    subscribeForLogging(session, log_);
    const watcher = new StallWatcher(session, { idleTimeoutMs: idleMs, toolTimeoutMs: toolMs, rateLimitTimeoutMs: rateLimitMs });
    const unsubStall = watcher.attach();
    return { session, sessionManager, watcher, unsubStall };
  };

  log_.info({ conflictedFiles }, "conflict resolver starting");
  const startedAt = Date.now();

  let currentManager = SessionManager.create(ws.path, sessionDir);
  let booted = await bootSession(currentManager);
  let promptError: unknown = null;

  for (let attempt = 0; attempt <= 1; attempt++) {
    const { session, watcher, unsubStall } = booted;
    try {
      await session.prompt(attempt === 0 ? resolverPrompt : "Continue resolving the merge conflicts. Clear any remaining conflict markers, then commit.");
    } catch (e) {
      watcher.dispose();
      unsubStall?.();
      if (watcher.didStall) {
        log_.warn({ stalledForMs: watcher.activeBudget === "tool" ? toolMs : idleMs }, "resolver stalled — aborting");
        return false;
      }
      promptError = e;
    }
    if (!promptError) {
      const sr = lastAssistantStopReason(session);
      if (sr.stopReason === "error") {
        promptError = new Error(sr.errorMessage ?? "resolver ended on error");
      }
    }
    if (!promptError) {
      watcher.dispose();
      unsubStall?.();
      break;
    }
    watcher.dispose();
    unsubStall?.();
    if (attempt >= 1) break;
    const sessionPath = booted.sessionManager.getSessionFile();
    try { await booted.session.dispose?.(); } catch { /* best-effort */ }
    log_.warn({ err: (promptError as Error).message, restartAttempt: attempt + 2 }, "resolver failed — restarting once");
    await sleep(SESSION_RESTART_DELAY_MS);
    currentManager = SessionManager.open(sessionPath!, sessionDir, ws.path);
    booted = await bootSession(currentManager);
  }

  if (promptError) {
    log_.error({ err: (promptError as Error).message, durationMs: Date.now() - startedAt }, "resolver could not complete");
    try { await booted.session.dispose?.(); } catch { /* best-effort */ }
    return false;
  }

  const stillConflicted = await ws.hasConflictMarkers();
  if (stillConflicted) {
    log_.warn({ durationMs: Date.now() - startedAt }, "resolver finished but conflict markers remain");
    try { await booted.session.dispose?.(); } catch { /* best-effort */ }
    return false;
  }

  const committed = await ws.commitAll(`merge origin/main (conflicts resolved by ${config.agent_name})`);
  log_.info({ durationMs: Date.now() - startedAt, committedByResolver: committed }, "resolver finished — trunk clean");
  try { await booted.session.dispose?.(); } catch { /* best-effort */ }
  return true;
}

/**
 * Body for the "needs manual sync" issue opened when the resolver couldn't
 * clear a trunk↔main conflict. Worded for either run kind.
 */
function buildManualSyncBody(
  agentName: string,
  displayName: string,
  runKind: RunKind,
  trunkBranch: string,
  baseBranch: string,
  conflictedFiles: string[],
  footer: string,
): string {
  const kindLabel = runKind === "trigger" ? "Trigger" : "Scheduled";
  const fileList = conflictedFiles.map((f) => `- \`${f}\``).join("\n");
  return [
    `⚠️ **${kindLabel} run for "${displayName}" could not sync \`${trunkBranch}\` with \`${baseBranch}\`.`,
    "",
    `An automated attempt to resolve the merge conflicts failed. The trunk branch has been ` +
      `left at its pre-merge state; subsequent runs will retry the sync.`,
    "",
    `**Conflicting files:**`,
    fileList,
    "",
    `**To unblock:**`,
    `- Rebase \`${trunkBranch}\` onto \`${baseBranch}\` manually and resolve the conflicts, OR`,
    `- Delete the \`${trunkBranch}\` branch — the next run will recreate it fresh from \`${baseBranch}\`.`,
    "",
    `---`,
    footer,
    "",
    `_Filed by ${agentName} ${runKind} runner — no code review needed unless the trunk has unmerged work._`,
  ].join("\n");
}

/**
 * Mirror pi agent events into the run log (one line per notable event; full
 * detail lives in the session file). Shared by the main run + the conflict
 * resolver. Sibling to run.ts's private subscriber; kept here so the background
 * run path can evolve its log shape independently.
 */
function subscribeForLogging(
  session: { subscribe?: (fn: (e: unknown) => void) => unknown },
  log_: typeof log,
) {
  if (typeof session.subscribe !== "function") return;
  let lastToolOutput = "";
  session.subscribe((event: unknown) => {
    const e = event as Record<string, unknown>;
    switch (e.type) {
      case "agent_start":
        log_.info("▶ agent started");
        break;
      case "agent_end":
        log_.info(e.willRetry === true ? "■ agent finished (will retry)" : "■ agent finished");
        break;
      case "message_end": {
        const msg = e.message as { role?: string } | undefined;
        if (msg?.role && msg.role !== "assistant") break;
        const text = extractMessageText(msg).trim();
        if (!text || text === lastToolOutput) break;
        lastToolOutput = "";
        log_.info(`» ${text}`);
        break;
      }
      case "tool_execution_start":
        lastToolOutput = "";
        log_.info(toolStartLabel(e.toolName, e.args));
        break;
      case "tool_execution_end": {
        const isError = e.isError === true;
        const out = extractToolResultText(e.result).trim();
        lastToolOutput = out.slice(0, 300);
        if (isError) {
          log_.warn(`✗ ${e.toolName}: ${truncate(firstLine(out), 200)}`);
        } else {
          log_.info("✓ done");
        }
        break;
      }
      case "auto_retry_start":
        log_.warn(`↻ retry ${e.attempt}/${e.maxAttempts}: ${e.errorMessage}`);
        break;
      default:
        // Drop the rest.
    }
  });
}

/** Pull concatenated text out of a pi AgentMessage. */
function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Pull returned text out of a pi AgentToolResult. */
function extractToolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return String(result);
  return content
    .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `… (+${s.length - max} more chars)` : s;
}

function firstLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/**
 * Label for a `tool_execution_start` event. Each tool gets a short glyph +
 * the one arg that matters for log readability.
 */
function toolStartLabel(toolName: unknown, args: unknown): string {
  const a = (args as Record<string, unknown> | null) ?? {};
  const pathOf = () => (typeof a.path === "string" ? a.path : "?");
  const patternOf = () => (typeof a.pattern === "string" ? a.pattern : "?");
  switch (toolName) {
    case "read":
      return `☰ read > ${pathOf()}`;
    case "write":
      return `✎ write > ${pathOf()}`;
    case "edit":
      return `✎ edit > ${pathOf()}`;
    case "bash": {
      const cmd = a.command;
      if (typeof cmd === "string" && cmd.trim()) return `$ ${truncate(cmd.replace(/\s+/g, " ").trim(), 300)}`;
      return "$ ?";
    }
    case "find":
      return `⌖ find > ${patternOf()}`;
    case "grep":
      return `⌕ grep > ${patternOf()}`;
    case "ls":
      return `≡ ls > ${pathOf()}`;
    default:
      return `▸ ${toolName}`;
  }
}

/** Stable sessions dir for a run (mirrors run.ts's helper). */
function sessionsDirFor(jobId: string): string {
  const base = resolve(process.env.NOODLE_SESSIONS_DIR ?? "./sessions");
  const dir = join(base, jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build the background-run output issue body from the agent's final message +
 * the shared footer. A blank/missing agent message still produces a useful
 * issue body so the run is never silent.
 */
export function buildBackgroundIssueBody(agentMessage: string | undefined, footer: string): string {
  const body = agentMessage?.trim() ||
    "_The agent ran but produced no findings. It may have found nothing concrete to report._";
  return `${body}\n\n---\n${footer}`;
}

/**
 * Build the background-run output issue body for an errored run. Honest notice
 * that the run failed, with the error text quoted so the cause is visible.
 */
export function buildBackgroundErrorBody(agentName: string, runKind: RunKind, errorMessage: string, footer: string): string {
  const err = errorMessage.trim() || "unknown error";
  const kindLabel = runKind === "trigger" ? "Trigger" : "Scheduled";
  const body =
    `⚠️ **${kindLabel} run by ${agentName} errored out before finishing.**\n\n` +
    `> \`${err}\`\n\n` +
    `No findings were produced. The run may be retried once the underlying issue ` +
    `(API quota, rate limit, provider outage, etc.) is resolved.`;
  return `${body}\n\n---\n${footer}`;
}

// Re-export buildFooter for callers that want the same footer shape as an
// issue-driven run.
export { buildFooter };
