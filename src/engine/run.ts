import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai/compat";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { log } from "../util/log.js";
import { resolveProfile } from "../profiles/resolve.js";
import { registerCustomProviders } from "../profiles/custom-providers.js";
import { GitHubClient } from "../github/client.js";
import { Workspace, cloneUrlFor } from "./workspace.js";
import { buildPrompt } from "./prompt.js";
import { createCommentOnIssueTool } from "./tools.js";
import { installSkills } from "../util/paths.js";
import { createRunLogger } from "../util/log.js";
import { throttleForRpm, throttleExtensionFactory } from "./throttle.js";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { RunStore } from "../server/run-store.js";
import type { NoodleConfig } from "../config/schema.js";

/** AuthStorage instance type (its constructor is private; use the factory's return type). */
type AuthStorageInstance = ReturnType<typeof AuthStorage.create>;

/**
 * Status labels Noodle applies to issues it works on. Both are ensured to exist
 * (created with the color + description below) at the start of every run, so a
 * repo doesn't need to set them up by hand.
 *
 *   cooking → applied while the agent is running
 *   cooked  → applied when the run finishes (cooking is removed)
 */
export const LABELS = {
  cooking: {
    name: "Noodle is cooking",
    color: "f0be04", // amber — without leading '#'
    description: "Noodle agent is working on this",
  },
  cooked: {
    name: "Noodle cooked here",
    color: "22c55e", // green — without leading '#'
    description: "Noodle agent run finished",
  },
} as const;

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
}

/**
 * Run one job end-to-end: fetch issue → route profile → clone → run pi →
 * commit → push → open PR → comment on issue.
 *
 * The agent's conversation is persisted to a session file under `./sessions/`
 * (survives workspace disposal, resumable via SessionManager.open). When a
 * `runStore` is supplied (serve mode), a `runs` row records status/PR/summary.
 */
export async function runJob(
  config: NoodleConfig,
  gh: GitHubClient,
  input: RunInput,
  deps?: {
    /** Optional pre-built auth storage (carrying API keys). */
    authStorage?: AuthStorageInstance;
    /** Optional run store — when set, the run is recorded in the `runs` table. */
    runStore?: RunStore;
    /** Override for tests. Defaults to pi's createAgentSession. */
    createAgentSessionFn?: typeof createAgentSession;
  },
): Promise<RunResult> {
  const jobId = input.jobId ?? `${input.repo.replace("/", "-")}-${input.issueNumber}`;
  // Branch name is derived up front so we can name the per-run log file after it.
  const branchName = makeBranchName(input.issueNumber, jobId);

  // Per-run logger: JSON-Lines file (named after the branch) + console mirror.
  // Both Noodle's steps and every pi agent event flow through this one logger.
  const { log: log_, filePath: runLogPath } = createRunLogger(branchName, {
    jobId,
    repo: input.repo,
    issue: input.issueNumber,
    branch: branchName,
  });
  log_.info({ runLogPath }, "per-run log file opened");

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

  // Ensure both status labels exist in the repo (creates them if missing), then
  // mark the issue as being worked on.
  await gh.ensureLabel(
    input.repo,
    LABELS.cooking.name,
    LABELS.cooking.color,
    LABELS.cooking.description,
  );
  await gh.ensureLabel(
    input.repo,
    LABELS.cooked.name,
    LABELS.cooked.color,
    LABELS.cooked.description,
  );
  await gh.addIssueLabel(input.repo, input.issueNumber, LABELS.cooking.name);
  log_.info({ label: LABELS.cooking.name }, "added status label");

  // 2. Route to a profile.
  const profile = resolveProfile(config, {
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    comments: comments.map((c) => c.body),
  });
  log_.info({ profile: profile.name, model: profile.model }, "routed profile");
  if (runStore) {
    runStore.updateRun(jobId, { profile: profile.name, model: profile.model });
  }

  // 3. Resolve the model via the registry.
  const authStorage = deps?.authStorage ?? AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  // Register any custom-endpoint profiles (Ollama/vLLM/proxies) with pi first.
  registerCustomProviders(config, modelRegistry);
  let model: Model<Api> | undefined;
  try {
    model = modelRegistry.find(profile.provider, profile.model);
  } catch (e) {
    throw new Error(
      `Could not resolve model "${profile.provider}/${profile.model}". ` +
        `Check the profile config and that the model id is valid. (${(e as Error).message})`,
    );
  }
  if (!model) {
    throw new Error(
      `Could not resolve model "${profile.provider}/${profile.model}". ` +
        `Check the profile config and that the model id is valid.`,
    );
  }

  // 4. Clone + branch. Base = repo default branch (resolved dynamically).
  const baseBranch = await gh.defaultBranch(input.repo);
  const token = input.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "No GitHub token for clone. Pass input.token (Phase 2) or set GITHUB_TOKEN (Phase 1).",
    );
  }
  const ws = await Workspace.clone(cloneUrlFor(input.repo, token), jobId);
  // branchName was computed up front for the per-run log file; reused here.
  let agentAnswer: string | undefined;
  try {
    await ws.branch(branchName);
    await installSkills(ws.path);

    // 5. Build prompt + resource loader.
    const prompt = buildPrompt(issue, comments, input.repo);
    // Optional per-profile rate-limit throttle (e.g. NVIDIA NIM's 40 rpm).
    const throttle = throttleForRpm(profile.api_rpm);
    const loader = new DefaultResourceLoader({
      cwd: ws.path,
      agentDir: join(ws.path, ".noodle-agent"),
      ...(throttle
        ? { extensionFactories: [throttleExtensionFactory(throttle, `${profile.provider}/${profile.model}`)] }
        : {}),
    });
    await loader.reload();

    // 6. Create pi session + run. The agent ends by posting its full final
    // answer as a normal text message; Noodle phrases it into the issue
    // comment / PR body via one post-run LLM call (below).
    //
    // The session is PERSISTED to a stable dir (./sessions/<jobId>/) that
    // survives workspace disposal — so the full conversation (messages, tool
    // calls, tool results) is on disk for resume/inspection without us having
    // to log it ourselves. The runs row (if any) points at the session file.
    const sessionDir = sessionsDirFor(jobId);
    const sessionManager = SessionManager.create(ws.path, sessionDir);
    const create = deps?.createAgentSessionFn ?? createAgentSession;
    const { session } = await create({
      cwd: ws.path,
      model,
      authStorage,
      modelRegistry,
      sessionManager,
      resourceLoader: loader,
      tools: profile.tools,
      customTools: [
        createCommentOnIssueTool(gh, input.repo, input.issueNumber),
      ],
    });

    subscribeForLogging(session, log_);

    log_.info("starting agent run");
    await session.prompt(prompt);

    // After dispose, a lingering pi bash-tool PTY socket can emit a final chunk
    // whose handler throws "Agent listener invoked outside active run" from an
    // async callback — uncatchable by try/catch and fatal to the process. Guard
    // only that specific benign error around the post-run work so a finished
    // run still reaches its commit/PR/comment. Torn down once the run is done.
    const teardownDisposeGuard = suppressPostDisposeBashRace(log_);
    try {
      await session.dispose?.();
      log_.info("agent run finished");

      // Capture the persisted session file path (for the runs row + RunResult).
      const sessionPath = sessionManager.getSessionFile() ?? undefined;
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
        // Honest comment so the reporter knows it failed (not a fake answer).
        agentAnswer =
          `⚠️ Noodle's agent stopped with an error before finishing:\n\n> ${errMsg}\n\n` +
          `No changes were made. The run may be retried.`;
      } else {
        // Capture the agent's final message — its actual answer. Posted verbatim
        // as the issue comment / PR body (with a signature footer), so the
        // agent's own words reach the reader.
        agentAnswer = extractLastAssistantText(session);
        if (!agentAnswer) {
          log_.warn("agent produced no final assistant message; comment will use the generic template");
        }
      }

      // 8. Commit + (if changes) push + open PR. An errored run skips this — it
      // falls through to step 9, which posts the error text as the comment and
      // records the run with a `failed` status.
      if (!errored) {
        await ws.removeInternals();
        const committed = await ws.commitAll(
          `Fix #${input.issueNumber}: ${issue.title}\n\nGenerated by Noodle (profile: ${profile.name}).`,
        );

        if (committed) {
          await ws.push(branchName);
          const changedFiles = await ws.changedFiles();
          const prBody = buildPrBody(profile.name, changedFiles, issue.html_url, agentAnswer);
          const pr = await gh.createPullRequest(
            input.repo,
            branchName,
            baseBranch,
            `Fixes #${issue.number}: ${issue.title}`,
            prBody,
          );
          const prUrl = pr.html_url;
          log_.info({ pr: prUrl, changedFiles }, "opened PR");

          await swapLabel(gh, input.repo, input.issueNumber, log_);

          const commentBody = buildIssueComment(profile, agentAnswer, {
            prNumber: pr.number,
            prUrl: pr.html_url,
            changedFiles,
          });
          const commentUrl = await gh.createIssueComment(input.repo, input.issueNumber, commentBody);
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
      // record the run. An errored run is marked `failed`; a clean no-change
      // run is `no_changes`.
      await swapLabel(gh, input.repo, input.issueNumber, log_);
      const commentBody = buildIssueComment(profile, agentAnswer);
      const commentUrl = await gh.createIssueComment(input.repo, input.issueNumber, commentBody);
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
    // Mark the run failed (rethrow so the caller still sees the error).
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

/** Branch name unique per run: noodle/issue-42-<shortid>. */
function makeBranchName(issueNumber: number, jobId: string): string {
  // short, readable suffix from the jobId (already unique per run)
  const suffix = jobId.replace(/^[\w./-]+-\d+-/, "").slice(0, 8) || Date.now().toString(36);
  return `noodle/issue-${issueNumber}-${suffix}`;
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

/**
 * Stable directory for a run's persisted pi session. Lives OUTSIDE the temp
 * workspace (which is rm'd on dispose) so the conversation survives for resume
 * and inspection. Read from NOODLE_SESSIONS_DIR, default ./sessions/<jobId>/.
 */
function sessionsDirFor(jobId: string): string {
  const base = resolve(process.env.NOODLE_SESSIONS_DIR ?? "./sessions");
  const dir = join(base, jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Pull the last assistant text message out of a pi session's message history.
 * This is the agent's actual answer — posted verbatim as the issue comment /
 * PR body. Only trustworthy when the run didn't end on an error (see
 * `lastAssistantStopReason`); an error-stopped run may have only an opening
 * utterance, not a real answer.
 *
 * Duck-typed (not relying on the AgentMessage type from a transitive dep) and
 * tolerant of both shapes pi uses: `content` as a string, or as an array of
 * parts where each part has `{ type: "text", text }`. Walks messages in
 * reverse and returns the first non-empty assistant text, or undefined.
 *
 * Exported for unit testing.
 */
export function extractLastAssistantText(session: unknown): string | undefined {
  const messages = (session as { messages?: unknown[] })?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    const text = textFromContent(m.content);
    if (text) return text;
  }
  return undefined;
}

/** Coerce a pi message `content` (string or array of parts) into plain text. */
function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((p) => (p as { type?: string })?.type === "text")
    .map((p) => (p as { text?: string }).text ?? "")
    .join("\n")
    .trim();
  return parts || undefined;
}

/**
 * Read the `stopReason` (+ `errorMessage`, if any) of the LAST assistant
 * message in a pi session. pi records a turn that ended in an internal error as
 * `{ stopReason: "error", errorMessage: "..." }` — the run resolves normally
 * but the agent never reached a real conclusion.
 *
 * When `stopReason === "error"`, any earlier assistant text is just an opening
 * utterance (e.g. "I'll load the skills first…"), NOT an answer. The runner
 * uses this to detect error-stopped runs and surface the failure instead of
 * posting that utterance as if it were a real response.
 *
 * Returns `{ stopReason: undefined }` when there are no assistant messages.
 *
 * Exported for unit testing.
 */
export function lastAssistantStopReason(
  session: unknown,
): { stopReason: string | undefined; errorMessage?: string } {
  const messages = (session as { messages?: unknown[] })?.messages;
  if (!Array.isArray(messages)) return { stopReason: undefined };
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
    if (m?.role !== "assistant") continue;
    return { stopReason: m.stopReason, errorMessage: m.errorMessage };
  }
  return { stopReason: undefined };
}

/**
 * Attach a subscriber that mirrors a SLIM set of pi events into the run log.
 * The agent's full conversation (messages, tool results, thinking) now lives in
 * the persisted session file — so the log only needs operational signal:
 *   - tool calls (start/end) — what the agent did
 *   - turn_start — agent wake-ups
 *   - tool errors — flagged as warnings
 * Agent text, tool-result dumps, and per-turn noise are intentionally omitted
 * to keep the log file a thin, readable operational + error tail.
 */
function subscribeForLogging(
  session: { subscribe?: (fn: (e: unknown) => void) => unknown },
  log_: typeof log,
) {
  if (typeof session.subscribe !== "function") return;
  session.subscribe((event: unknown) => {
    const e = event as Record<string, unknown>;
    switch (e.type) {
      case "tool_execution_start":
        log_.info(
          { tool: e.toolName, args: truncate(JSON.stringify(e.args), 200) },
          `▸ tool start: ${e.toolName}`,
        );
        break;
      case "tool_execution_end": {
        const isError = e.isError === true;
        if (isError) {
          log_.warn({ tool: e.toolName, isError }, `◂ tool end: ${e.toolName}`);
        } else {
          log_.info({ tool: e.toolName, isError }, `◂ tool end: ${e.toolName}`);
        }
        break;
      }
      case "turn_start":
        log_.info("── turn start (agent wake-up)");
        break;
      default:
        // Other pi events (message_end, turn_end, compaction, …) are not logged
        // here — they live in the session file. Errors surface as tool errors.
    }
  });
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Swap the cooking → cooked status label on an issue. Removal of `cooking` is
 * best-effort: if it fails (transient API error, label already gone, etc.) we
 * still add `cooked` and log the removal error rather than aborting — the run
 * has already produced its PR/comment, and a stuck cooking tag is preferable to
 * losing the cooked tag and a clean failure signal.
 */
async function swapLabel(
  gh: GitHubClient,
  repo: string,
  issue: number,
  log_ = log,
): Promise<void> {
  try {
    await gh.removeIssueLabel(repo, issue, LABELS.cooking.name);
  } catch (e) {
    log_.warn({ err: e, label: LABELS.cooking.name }, "could not remove cooking label; cooked label will still be added");
  }
  await gh.addIssueLabel(repo, issue, LABELS.cooked.name);
}

// --- output builders (exported for testing) --------------------------------
// The agent's final message IS the comment/PR body — posted verbatim, with a
// one-line signature footer appended (who ran, on what model). When the agent
// produced no final message, a short deterministic fallback keeps the run
// useful instead of posting nothing.

/**
 * Build the PR body: the agent's message, the changed files, and a signature.
 * When `agentMessage` is missing, a short notice asks the reviewer to check the
 * diff directly.
 */
export function buildPrBody(
  profile: string,
  changedFiles: string[],
  issueUrl: string,
  agentMessage?: string,
): string {
  const lines: string[] = [];
  if (agentMessage) {
    lines.push(agentMessage.trim(), "");
  } else {
    lines.push("_The agent did not leave a summary. Please review the diff carefully._", "");
  }
  if (changedFiles.length) {
    lines.push("**Changed files:**", ...changedFiles.map((f) => `- \`${f}\``), "");
  }
  lines.push(
    "---",
    `🤖 Generated by **Noodle** — \`${profile}\` profile.`,
    "",
    `Closes ${issueUrl}`,
  );
  return lines.join("\n");
}

export interface CommentFooter {
  /** PR number, when a PR was opened. */
  prNumber?: number;
  /** PR URL, when a PR was opened. */
  prUrl?: string;
  /** Changed files, when a PR was opened. */
  changedFiles?: string[];
}

/**
 * Build the issue comment: the agent's message verbatim, then a one-line
 * signature footer recording the run info (profile + model + optional PR link).
 *
 * When the agent produced no message, a short generic note is used instead so
 * the issue still gets a response.
 */
export function buildIssueComment(
  profile: { name: string; provider: string; model: string },
  agentMessage: string | undefined,
  footer?: CommentFooter,
): string {
  const body = agentMessage?.trim() ||
    "_Noodle ran but made no code changes and left no message. The issue may need clarification, or it may not be a code change._";

  // One-line signature: who ran, on what model, and the PR link if any.
  const sigParts = [`🤖 **Noodle** · ${profile.name} (\`${profile.provider}/${profile.model}\`)`];
  if (footer?.prUrl && footer.prNumber) {
    sigParts.push(`· PR #${footer.prNumber}: ${footer.prUrl}`);
  }
  return `${body}\n\n---\n${sigParts.join(" ")}`;
}
