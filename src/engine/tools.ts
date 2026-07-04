import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { GitHubClient } from "../github/client.js";
import { log } from "../util/log.js";

/**
 * Noodle custom tool injected into pi via `createAgentSession({ customTools })`.
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
) {
  return defineTool({
    name: "comment_on_issue",
    label: "Comment on Issue",
    description:
      "Post a comment on the GitHub issue currently being worked on. " +
      "Use to ask the reporter a clarifying question or share progress. " +
      "This does not end the run — to finish, write your full final answer as " +
      "a normal text message and Noodle will handle the rest.",
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
