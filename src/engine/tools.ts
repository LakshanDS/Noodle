import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { GitHubClient } from "../github/client.js";
import { log } from "../util/log.js";

/**
 * Noodle custom tools injected into pi via `createAgentSession({ customTools })`.
 *
 * `comment_on_issue` is the output path for issue→PR runs (the agent posts its
 * final answer, Noodle turns it into the issue comment + PR body). `open_issue`
 * is the output path for cron runs — the agent's deliverable IS a new issue, so
 * it opens as many as its findings warrant. Each tool is a factory capturing its
 * dependencies (gh client, repo, optional issue number) via closure.
 */

/**
 * `comment_on_issue(body)` — post a comment on the issue being worked on.
 * Lets the agent ask the reporter a question or share progress mid-run without
 * waiting for the run to finish.
 *
 * End-of-run reporting is not a tool: the agent posts its full final answer as
 * a normal text message, and Noodle phrases it into the issue comment via a
 * single post-run LLM call (see `./summarize.ts`).
 */
export function createCommentOnIssueTool(
  gh: GitHubClient,
  repo: string,
  issueNumber: number,
  agentName = "Noodle",
) {
  return defineTool({
    name: "comment_on_issue",
    label: "Comment on Issue",
    description:
      "Post a comment on the GitHub issue currently being worked on. " +
      "Use to ask the reporter a clarifying question or share progress. " +
      "This does not end the run — to finish, write your full final answer as " +
      `a normal text message and ${agentName} will handle the rest.`,
    parameters: Type.Object({
      body: Type.String({
        description: "The comment text, in Markdown.",
      }),
    }),
    execute: async (_id, params) => {
      try {
        const url = await gh.createIssueComment(repo, issueNumber, params.body);
        log.info({ repo, issueNumber }, "agent posted issue comment");
        return {
          content: [{ type: "text" as const, text: `Posted comment: ${url}` }],
          details: {},
        };
      } catch (e) {
        // Throwing signals an error to the model (pi reports it with isError).
        throw new Error(`Failed to post comment: ${(e as Error).message}`);
      }
    },
  });
}

/**
 * `open_issue(title, body, labels?)` — open a NEW issue in the repo. This is a
 * cron run's output mechanism: the agent is given a freeform prompt (e.g.
 * "find bugs") and reports each finding as its own issue, so the team gets
 * actionable, triageable tickets rather than a comment buried in a thread.
 *
 * `cronLabels` are ALWAYS applied (e.g. a tag identifying the cron source);
 * the agent may add more via the `labels` parameter.
 */
export function createOpenIssueTool(
  gh: GitHubClient,
  repo: string,
  cronLabels: string[] = [],
) {
  return defineTool({
    name: "open_issue",
    label: "Open Issue",
    description:
      "Open a new GitHub issue with a title and body. Use to report a finding " +
      "(a bug, a smell, a missing test) as its own triageable issue. Call once " +
      "per finding — don't lump unrelated problems into one issue. Each call " +
      "opens a separate issue. The title should be a concise summary; the body " +
      "should describe the problem and how to reproduce / locate it.",
    parameters: Type.Object({
      title: Type.String({
        description: "A concise issue title (1 line).",
      }),
      body: Type.String({
        description: "The issue body, in Markdown. Describe the finding clearly.",
      }),
      labels: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional extra labels to apply. Added on top of any fixed labels.",
        }),
      ),
    }),
    execute: async (_id, params) => {
      try {
        const allLabels = [...cronLabels, ...(params.labels ?? [])];
        const issue = await gh.createIssue(repo, params.title, params.body, allLabels);
        log.info({ repo, issue: issue.number }, "agent opened issue");
        return {
          content: [{ type: "text" as const, text: `Opened issue #${issue.number}: ${issue.html_url}` }],
          details: { issue_number: issue.number, url: issue.html_url },
        };
      } catch (e) {
        throw new Error(`Failed to open issue: ${(e as Error).message}`);
      }
    },
  });
}
