import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai/compat";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { log, runLogger } from "../util/log.js";
import { registerCustomProviders } from "../profiles/custom-providers.js";
import { GitHubClient } from "../github/client.js";
import { Workspace, cloneUrlFor } from "./workspace.js";
import { buildCronPrompt } from "./prompt.js";
import { installSkills } from "../util/paths.js";
import { collectSysFacts, buildSysInfoGuidance } from "../util/sysinfo.js";
import { throttleForRpm, throttleExtensionFactory } from "./throttle.js";
import { buildSettingsManager } from "./pi-settings.js";
import { StallWatcher, StallTimeoutError } from "./stall.js";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { RunStore } from "../server/run-store.js";
import type { NoodleConfig } from "../config/schema.js";
import {
  buildFooter,
  extractLastAssistantText,
  lastAssistantStopReason,
  suppressPostDisposeBashRace,
  type RunResult,
  type RunStats,
} from "./run.js";

/** AuthStorage instance type (its constructor is private; use the factory's return type). */
type AuthStorageInstance = ReturnType<typeof AuthStorage.create>;

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
    authStorage?: AuthStorageInstance;
    runStore?: RunStore;
    createAgentSessionFn?: typeof createAgentSession;
    tokenProvider?: () => Promise<string>;
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

  // 2. Resolve model via the registry (same as runJob).
  const authStorage = deps?.authStorage ?? AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const providerKeyMap = registerCustomProviders(config, modelRegistry);
  const providerKey = providerKeyMap.get(profile.name) ?? profile.provider;
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

    // 5. Build prompt + resource loader.
    const sysFacts = collectSysFacts();
    log_.debug({ sysFacts }, "probed system info for cron prompt");
    const prompt = buildCronPrompt(input.prompt, input.repo, config.agent_name, buildSysInfoGuidance(sysFacts));
    const throttle = throttleForRpm(profile.api_rpm);
    // pi retry settings tuned from the profile config so 429 retries don't cascade.
    const settingsManager = buildSettingsManager(ws.path, join(ws.path, ".noodle-agent"), profile);
    const loader = new DefaultResourceLoader({
      cwd: ws.path,
      agentDir: join(ws.path, ".noodle-agent"),
      settingsManager,
      ...(throttle
        ? { extensionFactories: [throttleExtensionFactory(throttle, `${profile.provider}/${profile.model}`)] }
        : {}),
    });
    await loader.reload();

    // 6. Create pi session + run. No custom output tool — the agent ends by
    // writing its findings as a normal final text message, and Noodle opens a
    // single issue with that message as the body after the run (mirrors how
    // runJob turns the agent's answer into the issue comment + PR body).
    const sessionDir = sessionsDirFor(jobId);
    const sessionManager = SessionManager.create(ws.path, sessionDir);
    const create = deps?.createAgentSessionFn ?? createAgentSession;
    const { session } = await create({
      cwd: ws.path,
      model,
      authStorage,
      modelRegistry,
      sessionManager,
      settingsManager,
      resourceLoader: loader,
      thinkingLevel: profile.thinking_level,
      tools: profile.tools,
    });

    subscribeForLogging(session, log_);

    const idleMs = (config.run?.stall_timeout_minutes ?? 0) * 60_000;
    const toolMs = (config.run?.tool_stall_minutes ?? 0) * 60_000;
    const watcher = new StallWatcher(session, { idleTimeoutMs: idleMs, toolTimeoutMs: toolMs });
    const unsubStall = watcher.attach();

    log_.info({ idleTimeoutMs: idleMs || "off", toolTimeoutMs: toolMs || "off" }, "starting cron run");
    const startedAt = Date.now();
    try {
      await session.prompt(prompt);
    } catch (e) {
      if (watcher.didStall) {
        throw new StallTimeoutError(
          (watcher.activeBudget === "tool" ? toolMs : idleMs) || 0,
          watcher.activeBudget,
        );
      }
      throw e;
    } finally {
      watcher.dispose();
      unsubStall?.();
    }
    const durationMs = Date.now() - startedAt;

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

      const sessionPath = sessionManager.getSessionFile() ?? undefined;
      if (runStore && sessionPath) {
        runStore.updateRun(jobId, { session_path: sessionPath });
      }

      // Detect error termination vs capture the agent's final message.
      const stopReason = lastAssistantStopReason(session);
      const errored = stopReason.stopReason === "error";
      if (errored) {
        log_.error({ errorMessage: stopReason.errorMessage, stopReason: stopReason.stopReason }, "cron run ended on error");
      } else {
        agentAnswer = extractLastAssistantText(session);
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
      const issueTitle = cronIssueTitle(input.prompt);
      const issue = await gh.createIssue(input.repo, issueTitle, issueBody, [config.agent_name]);
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
 * Mirror pi agent events into the cron run log — same minimal shape as runJob's
 * subscriber (one line per notable event; full detail lives in the session file).
 * Duplicated from run.ts because that subscriber is a private function there;
 * keeping a cron-specific copy avoids coupling the two run paths and lets cron
 * logging evolve independently.
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
        log_.info(`💬 ${text}`);
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
        // Drop the rest — same as runJob's subscriber.
    }
  });
}

/** Pull concatenated text out of a pi AgentMessage (mirrors run.ts). */
function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Pull returned text out of a pi AgentToolResult (mirrors run.ts). */
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

function toolStartLabel(toolName: unknown, args: unknown): string {
  const a = (args as Record<string, unknown> | null) ?? {};
  switch (toolName) {
    case "read": {
      const fp = a.filePath;
      return `read > ${typeof fp === "string" ? fp : "?"}`;
    }
    case "write": {
      const fp = a.filePath;
      return `write > ${typeof fp === "string" ? fp : "?"}`;
    }
    case "bash": {
      const cmd = a.command;
      if (typeof cmd === "string" && cmd.trim()) return `$ ${truncate(cmd.replace(/\s+/g, " ").trim(), 300)}`;
      return "$ ?";
    }
    case "glob": {
      const pat = a.pattern;
      return `glob > ${typeof pat === "string" ? pat : "?"}`;
    }
    case "grep": {
      const pat = a.pattern;
      return `grep > ${typeof pat === "string" ? pat : "?"}`;
    }
    default:
      return `▸ ${toolName}`;
  }
}

/** Stable sessions dir for a cron run (mirrors run.ts's helper). */
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
 * Derive a concise issue title from the cron task. The task is freeform, so we
 * take its first non-empty line (capped to ~80 chars) and prefix it with the
 * agent name so the issue is identifiable as cron output in a triage list. When
 * the task is blank, fall back to a generic "scheduled sweep" title.
 */
function cronIssueTitle(task: string): string {
  const firstLine = task.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  const head = firstLine ? truncate(firstLine, 80) : "scheduled sweep";
  return head;
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
