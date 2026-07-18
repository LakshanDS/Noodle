import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai/compat";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { log, runLogger } from "../util/log.js";
import { registerCustomProviders } from "../profiles/custom-providers.js";
import { GitHubClient } from "../github/client.js";
import { Workspace, cloneUrlFor } from "./workspace.js";
import { expandTags } from "./tags.js";
import { generateIssueTitle, templateTitle } from "./title.js";
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
 * Color applied to the agent-name label on trigger output issues — teal (#008672,
 * without the leading '#'). Matches cron output for visual consistency.
 */
const TRIGGER_LABEL_COLOR = "008672";

/**
 * Session restart constants — same as cron-run.ts.
 */
const SESSION_RESTART_ATTEMPTS = 3;
const SESSION_RESTART_DELAY_MS = 120_000; // 2 minutes
const SESSION_RESTART_HARD_CAP = 9;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Input for an event-driven trigger run. Unlike the issue-driven RunInput, there is
 * no source issue — the agent works a freeform prompt with event context and its
 * final message is turned into a NEW issue by Noodle after the run.
 */
export interface TriggerRunInput {
  /** "owner/name" */
  repo: string;
  /** Freeform task prompt (the trigger's configured prompt). */
  prompt: string;
  /** Branch the agent commits to. Reused across runs of the same trigger. */
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
  /** A human-readable summary of the event for the prompt context. */
  eventSummary?: string;
  /** The trigger's custom label (display-only). */
  triggerLabel?: string | null;
}

/**
 * Build the user prompt for an event-driven trigger run. Includes the event
 * context (what happened on GitHub) plus the trigger's configured prompt.
 *
 * Only `noodle-default` is loaded: trigger runs respond to events and produce
 * findings, similar to cron runs. The event context tells the agent what happened.
 */
export function buildTriggerPrompt(
  task: string,
  repo: string,
  eventType: string,
  eventAction: string | null | undefined,
  eventSummary: string | undefined,
  agentName = "Noodle",
  sysInfo?: string,
): string {
  const lines: string[] = [];
  if (sysInfo) {
    lines.push(sysInfo, "", "---", "");
  }

  const eventName = eventAction ? `${eventType}.${eventAction}` : eventType;
  lines.push(
    `You are responding to a GitHub event in the repository \`${repo}\`.`,
    "",
    `**Event:** \`${eventName}\``,
  );
  if (eventSummary) {
    lines.push("", eventSummary);
  }
  lines.push(
    "",
    "**Load the skill before starting:**",
    "- `noodle-default` — the always-active engineering mindset (lazy senior dev:",
    "  minimal diff, stdlib first, no over-engineering). It governs how you reason",
    "  about the code you inspect.",
    "",
    "This is a **trigger run** — you were activated because a GitHub event occurred.",
    "Investigate the situation, then write up your findings as your **final message**",
    "(normal text, in Markdown). Be concrete: for each finding, say what's wrong",
    "and where to find it (file + line). Don't pad with architecture walkthroughs",
    "or restate the event. If you have nothing concrete to report, say so plainly.",
    "",
    `${agentName} opens a single GitHub issue with your final message as the body,`,
    "and commits any exploratory changes to the trigger's branch (for traceability).",
    "No pull request is opened — your final message IS the deliverable.",
    "",
    "## Task",
    "",
    task.trim() || "_(no task specified)_",
  );
  return lines.join("\n");
}

/**
 * Run one event-driven trigger job end-to-end: resolve profile → clone → branch →
 * run pi → commit + push the branch → open an issue with the agent's final message
 * → record the run.
 *
 * Mirrors `runCronJob` but includes event context in the prompt.
 */
export async function runTriggerJob(
  config: NoodleConfig,
  gh: GitHubClient,
  input: TriggerRunInput,
  deps?: {
    authStorage?: AuthStorageInstance;
    runStore?: RunStore;
    createAgentSessionFn?: typeof createAgentSession;
    tokenProvider?: () => Promise<string>;
    systemPrompt?: string;
    triggerStore?: { updateRunStatus: (id: number, status: string) => void };
    triggerId?: number;
  },
): Promise<RunResult> {
  const jobId = input.jobId ?? `trigger-${input.repo.replace("/", "-")}`;
  const branchName = input.branchName;

  const log_ = runLogger({
    jobId,
    repo: input.repo,
    branch: branchName,
    pid: process.pid,
  });
  log.info("═══════════════════════════════════════════════════════════════");
  log.info(
    `trigger run started — repo=${input.repo} | branch=${branchName} | event=${input.eventType}${input.eventAction ? `.${input.eventAction}` : ""} | jobId=${jobId} | pid=${process.pid}`,
  );

  // Mark trigger as running.
  if (deps?.triggerStore && deps?.triggerId) {
    deps.triggerStore.updateRunStatus(deps.triggerId, "running");
  }

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
    // 1. Resolve profile.
    const profileName = input.profile ?? config.default_profile;
    if (!profileName) {
      throw new Error("No profile specified and no default_profile is configured.");
    }
    const profileDef = config.profiles[profileName];
    if (!profileDef) {
      throw new Error(
        `Trigger profile "${profileName}" is not defined in profiles (default_profile: ${config.default_profile ?? "(none)"}).`,
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
      // 4. Branch: reuse the existing remote branch when present.
      const reused = await tryReuseBranch(ws, branchName, cloneUrlFor(input.repo, await freshToken()), log_);
      if (!reused) {
        await ws.branch(branchName);
      }
      await installSkills(ws.path);

      // 5. Build prompt + resource loader.
      const sysFacts = collectSysFacts();
      log_.debug({ sysFacts }, "probed system info for trigger prompt");

      const sysInfo = buildSysInfoGuidance(sysFacts);
      let fullSysInfo = sysInfo;
      if (deps?.systemPrompt) {
        try {
          const expanded = await expandTags(deps.systemPrompt, { sysFacts, gh, repo: input.repo });
          if (expanded.trim()) fullSysInfo = `${expanded}\n\n---\n\n${sysInfo}`;
        } catch (e) {
          log_.warn({ err: (e as Error).message }, "failed to expand system prompt tags — using sysInfo only");
        }
      }
      const prompt = buildTriggerPrompt(
        input.prompt,
        input.repo,
        input.eventType,
        input.eventAction,
        input.eventSummary,
        config.agent_name,
        fullSysInfo,
      );
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

      // 6. Create pi session + run.
      const sessionDir = sessionsDirFor(jobId);
      const create = deps?.createAgentSessionFn ?? createAgentSession;
      const idleMs = (config.run?.stall_timeout_minutes ?? 0) * 60_000;
      const toolMs = (config.run?.tool_stall_minutes ?? 0) * 60_000;
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
        const watcher = new StallWatcher(session, { idleTimeoutMs: idleMs, toolTimeoutMs: toolMs });
        const unsubStall = watcher.attach();
        return { session, sessionManager, watcher, unsubStall };
      };

      log_.info({ idleTimeoutMs: idleMs || "off", toolTimeoutMs: toolMs || "off" }, "starting trigger run");
      const startedAt = Date.now();

      let currentManager = SessionManager.create(ws.path, sessionDir);
      let booted = await bootSession(currentManager);
      let promptError: unknown = null;

      for (let attempt = 0, totalRestarts = 0; attempt <= SESSION_RESTART_ATTEMPTS; attempt++, totalRestarts++) {
        if (totalRestarts > SESSION_RESTART_HARD_CAP) {
          log_.warn({ totalRestarts }, "hit hard cap on total restarts — giving up");
          break;
        }
        const { session, sessionManager, watcher, unsubStall } = booted;
        const turnsBefore = session.getSessionStats?.()?.assistantMessages ?? 0;
        try {
          await session.prompt(attempt === 0 ? prompt : "Continue. The previous attempt failed — pick up where you left off.");
        } catch (e) {
          watcher.dispose();
          unsubStall?.();
          if (watcher.didStall) {
            throw new StallTimeoutError(
              (watcher.activeBudget === "tool" ? toolMs : idleMs) || 0,
              watcher.activeBudget,
            );
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
        const turnsAfter = session.getSessionStats?.()?.assistantMessages ?? 0;
        if (turnsAfter > turnsBefore) {
          log_.info({ turnsBefore, turnsAfter }, "agent made progress before failure — resetting restart budget");
          attempt = -1;
        }
        if (attempt >= SESSION_RESTART_ATTEMPTS) break;
        const sessionPath = sessionManager.getSessionFile();
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

      if (promptError) throw promptError;

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
          "trigger run stats",
        );
        await session.dispose?.();
        log_.info("trigger run finished");

        const sessionPath = sessionManager.getSessionFile() ?? undefined;
        if (runStore && sessionPath) {
          runStore.updateRun(jobId, { session_path: sessionPath });
        }

        const stopReason = lastAssistantStopReason(session);
        const errored = stopReason.stopReason === "error";
        if (errored) {
          log_.error({ errorMessage: stopReason.errorMessage, stopReason: stopReason.stopReason }, "trigger run ended on error");
        } else {
          agentAnswer = extractLastAssistantText(session);
        }

        await ws.removeInternals();
        const committed = await ws.commitAll(
          `trigger run (${input.branchName})\n\nEvent-driven run by ${config.agent_name} (event: ${input.eventType}${input.eventAction ? `.${input.eventAction}` : ""}).`,
        );
        if (committed) {
          await ws.push(branchName, cloneUrlFor(input.repo, await freshToken()), reused);
          log_.info({ branch: branchName, reused }, "pushed trigger branch");
        }

        const issueBody = errored
          ? buildTriggerErrorBody(config.agent_name, stopReason.errorMessage ?? "agent run ended on error")
          : buildTriggerIssueBody(agentAnswer, buildFooter(profile, config.agent_name, runStats));
        const issueTitle = errored
          ? templateTitle(input.prompt)
          : await generateIssueTitle(agentAnswer ?? "", input.prompt, profile);
        const triggerLabel = `${config.agent_name}-Trigger`;
        await gh.ensureLabel(
          input.repo,
          triggerLabel,
          TRIGGER_LABEL_COLOR,
          `${config.agent_name}-Agent trigger event result`,
        );
        const issue = await gh.createIssue(input.repo, issueTitle, issueBody, [triggerLabel]);
        log_.info({ issue: issue.number, url: issue.html_url, errored }, "opened trigger output issue");

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

        // Mark trigger status.
        if (deps?.triggerStore && deps?.triggerId) {
          deps.triggerStore.updateRunStatus(deps.triggerId, errored ? "failed" : "succeeded");
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
      if (deps?.triggerStore && deps?.triggerId) {
        deps.triggerStore.updateRunStatus(deps.triggerId, "failed");
      }
      throw e;
    } finally {
      await ws.dispose();
    }
  } catch (e) {
    if (runStore) {
      runStore.updateRun(jobId, { status: "failed", error: (e as Error).message ?? String(e), finished_at: nowIso() });
    }
    throw e;
  }
}

/**
 * Try to reuse an existing remote branch: fetch it and reset onto its tip so
 * this run's work stacks on top of prior runs.
 */
async function tryReuseBranch(
  ws: Workspace,
  name: string,
  freshCloneUrl: string,
  log_: typeof log,
): Promise<boolean> {
  try {
    await (ws as unknown as { git: { fetch: (url: string, ref: string) => Promise<unknown> } }).git.fetch(freshCloneUrl, name);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/not found|doesn't exist|could not find|does not exist| fatal:/i.test(msg)) {
      log_.debug({ branch: name }, "branch does not exist yet — will create fresh");
      return false;
    }
    throw e;
  }
  await ws.checkoutOrReuse(name, freshCloneUrl);
  log_.debug({ branch: name }, "reused existing remote trigger branch");
  return true;
}

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
    }
  });
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("\n");
}

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
  const pathOf = () => (typeof a.path === "string" ? a.path : "?");
  const patternOf = () => (typeof a.pattern === "string" ? a.pattern : "?");
  switch (toolName) {
    case "read": return `☰ read > ${pathOf()}`;
    case "write": return `✎ write > ${pathOf()}`;
    case "edit": return `✎ edit > ${pathOf()}`;
    case "bash": {
      const cmd = a.command;
      if (typeof cmd === "string" && cmd.trim()) return `$ ${truncate(cmd.replace(/\s+/g, " ").trim(), 300)}`;
      return "$ ?";
    }
    case "find": return `⌖ find > ${patternOf()}`;
    case "grep": return `⌕ grep > ${patternOf()}`;
    case "ls": return `≡ ls > ${pathOf()}`;
    default: return `▸ ${toolName}`;
  }
}

function sessionsDirFor(jobId: string): string {
  const base = resolve(process.env.NOODLE_SESSIONS_DIR ?? "./sessions");
  const dir = join(base, jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildTriggerIssueBody(agentMessage: string | undefined, footer: string): string {
  const body = agentMessage?.trim() ||
    "_The agent ran but produced no findings. It may have found nothing concrete to report._";
  return `${body}\n\n---\n${footer}`;
}

function buildTriggerErrorBody(agentName: string, errorMessage: string): string {
  const err = errorMessage.trim() || "unknown error";
  const body =
    `⚠️ **Trigger run by ${agentName} errored out before finishing.**\n\n` +
    `> \`${err}\`\n\n` +
    `No findings were produced. The run may be retried once the underlying issue ` +
    `(API quota, rate limit, provider outage, etc.) is resolved.`;
  return body;
}

export { buildFooter };
