import type { IssueData } from "../github/client.js";
import type { CommentData } from "../github/client.js";

/**
 * Default system prompt — the authoritative base seeded into the Settings DB
 * on first boot and used as a fallback whenever the operator hasn't set a
 * custom one. Uses {repository} and {system} tags which are expanded at run
 * time by `expandTags()`.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  "You are an autonomous software engineer working in the GitHub repository `{repository}`.",
  "Always load the `noodle-default` skill — it is the always-active engineering mindset.",
  "",
  "Investigate or fix issues, answer questions, and write up your findings as your `final message`",
  "(normal text, in Markdown). Be concrete: for each finding, say what's wrong and where to find it",
  "(file + line). Don't pad with architecture walkthroughs or restate the task. If you have",
  "nothing concrete to report, say so plainly.",
  "",
  "Decide your own approach from the system info. Make the minimal change, verify it, and",
  "post your final answer as a normal text message — it IS the deliverable.",
  "",
  "{system}",
].join("\n");

/**
 * The framing prompt for the built-in `/<agent>` command (e.g. `/noodle`) — the
 * general-purpose default. Since the base system prompt already loads
 * `noodle-default` and sets the deliverable contract, this is empty for the
 * built-in `/noodle` case.
 *
 * Also used as the fallback framing when no command matched the issue text —
 * the system prompt is complete on its own.
 */
export function defaultCommandPrompt(_agentName = "Noodle"): string {
  return "";
}

/**
 * Framing prompt for the `/<agent>-fix` command (e.g. `/noodle-fix`) — the
 * fix workflow. Loads `noodle-fix` on top of the always-active `noodle-default`
 * (which the base system prompt already loads). Only carries what's unique to
 * the fix workflow — the base handles role, skill-loading, and the
 * final-message-is-deliverable contract.
 */
export function fixCommandPrompt(): string {
  return [
    "Load the `noodle-fix` skill before starting.",
    "",
    "Investigate, make the minimal change, and verify it. Report what you changed",
    "and why.",
  ].join("\n");
}

/**
 * Framing prompt for the `/<agent>-review` command (e.g. `/noodle-review`) —
 * the code review workflow. Loads `noodle-review` on top of the always-active
 * `noodle-default` (which the base system prompt already loads). Only carries
 * what's unique to the review workflow.
 */
export function reviewCommandPrompt(): string {
  return [
    "Load the `noodle-review` skill before starting.",
    "",
    "Review the changes as a senior engineer would: call out bugs, risks, and",
    "missing tests. Be specific — reference files and lines. Keep it to the",
    "highest-signal points rather than exhaustive nitpicks.",
  ].join("\n");
}

/**
 * Build the user prompt for an issue→PR run. The structure is:
 *
 *   <expandedSystemPrompt>
 *
 *   The issue you have been given  (or "The comments on this PR")
 *
 *   <framing — the command's system_prompt>
 *
 *   ## Issue | ## Pull Request / ## Discussion / Issue|PR URL
 *
 * For the built-in `/noodle` command, `framing` is empty and the system prompt
 * alone carries the role + skill-loading + deliverable contract.
 *
 * `isPR` switches the context header to "The comments on this PR" and adjusts
 * the section headers. The PR's body (its description) stands in for the issue
 * body, and the comments carry the actual request (e.g. "/noodle change line 302
 * to …"). The agent's edits land on the PR's own branch and are force-pushed
 * back to the same PR.
 */
export function buildRunPrompt(
  expandedSystemPrompt: string,
  framing: string,
  issue: IssueData,
  comments: CommentData[],
  isPR = false,
): string {
  const commentBlock =
    comments.length > 0
      ? comments
          .map((c, i) => `### Comment ${i + 1} — @${c.author}\n\n${c.body}`)
          .join("\n\n")
      : "_(no comments)_";

  const contextHeader = isPR
    ? "The comments on this PR"
    : "The issue you have been given";
  const header = isPR ? "## Pull Request" : "## Issue";
  const urlLabel = isPR ? "PR URL" : "Issue URL";

  const lines: string[] = [expandedSystemPrompt, "", contextHeader];
  if (framing) {
    lines.push("", framing);
  }
  lines.push(
    "",
    header,
    "",
    `**${issue.title}** (#${issue.number})`,
    "",
    issue.body || "_(no description)_",
    "",
    "## Discussion",
    "",
    commentBlock,
    "",
    `${urlLabel}: ${issue.html_url}`,
  );
  return lines.join("\n");
}

/**
 * Legacy entry point — equivalent to `buildRunPrompt(defaultCommandPrompt(...), ...)`.
 * Updated to the new signature where `expandedSystemPrompt` is prepended rather
 * than separate `repo` + `sysInfo` params.
 */
export function buildPrompt(
  expandedSystemPrompt: string,
  issue: IssueData,
  comments: CommentData[],
  isPR = false,
): string {
  return buildRunPrompt(expandedSystemPrompt, defaultCommandPrompt(), issue, comments, isPR);
}

/**
 * Build the user prompt for a scheduled (cron) run. The system prompt is the
 * authoritative base; this builder appends the run-type-specific extension
 * below it with the task instructions.
 *
 *   <expandedSystemPrompt>
 *
 *   Your scheduled task instructions
 *
 *   <task>
 */
export function buildSchedulerPrompt(
  expandedSystemPrompt: string,
  task: string,
): string {
  const lines: string[] = [
    expandedSystemPrompt,
    "",
    "Your scheduled task instructions",
    "",
    task.trim() || "_(no task specified)_",
  ];
  return lines.join("\n");
}
