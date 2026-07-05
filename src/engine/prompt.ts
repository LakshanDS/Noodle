import type { IssueData } from "../github/client.js";
import type { CommentData } from "../github/client.js";

/**
 * Build the user prompt pi receives. Keeps the mindset brief and delegates the
 * full lazy-senior-dev / grug-brain rules to the `noodle-fix` skill (loaded by
 * the agent), so the prompt stays short — tokens cost money.
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
