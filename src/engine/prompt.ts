import type { IssueData } from "../github/client.js";
import type { CommentData } from "../github/client.js";

/**
 * Build the user prompt pi receives. Keeps the mindset brief and delegates the
 * full lazy-senior-dev / grug-brain rules to the `noodle-fix` skill (loaded by
 * the agent), so the prompt stays short — tokens cost money.
 */
export function buildPrompt(issue: IssueData, comments: CommentData[], repo: string): string {
  const commentBlock =
    comments.length > 0
      ? comments
          .map((c, i) => `### Comment ${i + 1} — @${c.author}\n\n${c.body}`)
          .join("\n\n")
      : "_(no comments)_";

  return [
    `You are working on an issue in the GitHub repository \`${repo}\`.`,
    "",
    "**Load both skills before starting:**",
    "- `noodle-default` — the always-active engineering mindset (lazy senior dev:",
    "  minimal diff, stdlib first, no over-engineering).",
    "- `noodle-fix` — the fix workflow for this task (pairs with the default).",
    "",
    "Then follow `noodle-fix`: investigate, make the minimal change, verify, and",
    "**call `finish_run` when done** (required) — summary of what you changed and",
    "what you deliberately didn't. Noodle commits and opens the PR after that.",
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
  ].join("\n");
}
