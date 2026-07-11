import type { IssueData } from "../github/client.js";
import type { CommentData } from "../github/client.js";

/**
 * Build the user prompt pi receives for an issue→PR run. Keeps the mindset
 * brief and delegates the full lazy-senior-dev / grug-brain rules to the
 * `noodle-fix` skill (loaded by the agent), so the prompt stays short — tokens
 * cost money.
 *
 * `sysInfo` is an optional pre-rendered block describing the host's hardware
 * (collected at run time) plus the verification guidance that follows from it.
 * When supplied it's prepended so the agent knows — before it touches anything —
 * whether this box can survive a build/test run or must verify by reasoning.
 */
export function buildPrompt(
  issue: IssueData,
  comments: CommentData[],
  repo: string,
  agentName = "Noodle",
  sysInfo?: string,
): string {
  const commentBlock =
    comments.length > 0
      ? comments
          .map((c, i) => `### Comment ${i + 1} — @${c.author}\n\n${c.body}`)
          .join("\n\n")
      : "_(no comments)_";

  const lines: string[] = [];
  if (sysInfo) {
    lines.push(sysInfo, "", "---", "");
  }
  lines.push(
    `You are working on an issue in the GitHub repository \`${repo}\`.`,
    "",
    "**Load both skills before starting:**",
    "- `noodle-default` — the always-active engineering mindset (lazy senior dev:",
    "  minimal diff, stdlib first, no over-engineering).",
    "- `noodle-fix` — the fix workflow for this task (pairs with the default).",
    "",
    "Then follow the skills. If the issue is a **question** (not a bug or feature",
    "request), just answer it — a few sentences at most. Don't restate the problem,",
    "don't walk through the codebase architecture, don't pad. For bugs/fixes, follow",
    "`noodle-fix`: investigate, make the minimal change, verify, and end by posting",
    "your final answer as a normal text message — what you changed and why.",
    `${agentName} phrases that message into the issue comment and PR body, then commits`,
    "and opens the PR. Do not just say \"done\" — your final message IS the deliverable.",
    "",
    "## Issue",
    "",
    `**${issue.title}** (#${issue.number})`,
    "",
    issue.body || "_(no description)_",
    "",
    "## Discussion",
    "",
    commentBlock,
    "",
    `Issue URL: ${issue.html_url}`,
  );
  return lines.join("\n");
}

/**
 * Build the user prompt for a scheduled (cron) run. Unlike `buildPrompt`, there
 * is no source issue — the agent is given a freeform task (e.g. "find bugs and
 * open issues") and works the repo. Its deliverable is a final text message:
 * its findings, written up clearly. Noodle opens a single issue in the repo
 * with that message as the body (plus a footer), mirroring how an issue→PR run
 * turns the agent's final message into the issue comment + PR body.
 *
 * Only `noodle-default` is loaded: cron runs are investigative/sweeps, not the
 * fix workflow (which assumes a single issue to resolve). `noodle-fix` would
 * push the agent toward opening a PR, which is the wrong output shape here.
 *
 * `sysInfo` (host hardware + verification guidance) is prepended when supplied,
 * same as `buildPrompt`.
 */
export function buildCronPrompt(
  task: string,
  repo: string,
  agentName = "Noodle",
  sysInfo?: string,
): string {
  const lines: string[] = [];
  if (sysInfo) {
    lines.push(sysInfo, "", "---", "");
  }
  lines.push(
    `You are running a scheduled task in the GitHub repository \`${repo}\`.`,
    "",
    "**Load the skill before starting:**",
    "- `noodle-default` — the always-active engineering mindset (lazy senior dev:",
    "  minimal diff, stdlib first, no over-engineering). It governs how you reason",
    "  about the code you inspect.",
    "",
    "This is a **cron run** — there is no issue to fix. Investigate the task, then",
    "write up your findings as your **final message** (normal text, in Markdown).",
    "Be concrete: for each finding, say what's wrong and where to find it (file +",
    "line). Don't pad with architecture walkthroughs or restate the task. If you",
    "have nothing concrete to report, say so plainly.",
    "",
    `${agentName} opens a single GitHub issue with your final message as the body,`,
    "and commits any exploratory changes to the cron's branch (for traceability).",
    "No pull request is opened — your final message IS the deliverable.",
    "",
    "## Task",
    "",
    task.trim() || "_(no task specified)_",
  );
  return lines.join("\n");
}
