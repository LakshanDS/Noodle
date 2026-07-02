import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { GitHubClient } from "../github/client.js";
import { log } from "../util/log.js";

/**
 * Structured output the agent returns when it finishes a run.
 * Captured via the `finish_run` tool — see createFinishRunTool.
 */
export interface FinishRunResult {
  /** 1–3 sentences: what was changed and why. Shown in the PR body + issue comment. */
  summary: string;
  /** Brief rationale of the approach, for harder changes. Optional. */
  approach?: string;
  /** The agent's own confidence in the fix. */
  confidence?: "high" | "medium" | "low";
  /** True if the change is risky/uncertain and a human should look carefully. */
  needs_human_review?: boolean;
}

/**
 * Mutable per-run state shared between the tool layer and the runner.
 * The runner reads `result` after the agent run to build the PR/comment.
 */
export class RunState {
  result?: FinishRunResult;
}

/**
 * Noodle custom tools — injected into pi via `createAgentSession({ customTools })`.
 */

/**
 * `comment_on_issue(body)` — post a comment on the issue being worked on.
 * Lets pi ask the reporter a question or share progress without waiting for PR.
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
      "Do not use to report completion — use finish_run for that.",
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
 * `finish_run(summary, ...)` — the structured-output contract. The agent MUST
 * call this when done so Noodle can capture a clean, machine-readable result
 * for the PR body and issue comment. If the agent doesn't call it (errors,
 * max-tokens, etc.), the runner falls back to a deterministic template built
 * from git facts — see engine/run.ts.
 */
export function createFinishRunTool(state: RunState) {
  return defineTool({
    name: "finish_run",
    label: "Finish Run",
    description:
      "Call this when you have finished working on the issue. REQUIRED to end " +
      "the run — do not stop without calling it. Provide a concise summary of " +
      "what you changed and why; it will be used as the pull-request body.",
    parameters: Type.Object({
      summary: Type.String({
        description:
          "1–3 sentences: what you changed and why. Written for a human reviewer.",
      }),
      approach: Type.Optional(
        Type.String({
          description: "Optional one-line rationale of the approach taken.",
        }),
      ),
      confidence: Type.Optional(
        StringEnum(
          ["high", "medium", "low"],
          { description: "Your confidence that this fully resolves the issue." },
        ),
      ),
      needs_human_review: Type.Optional(
        Type.Boolean({
          description: "True if the change is risky, uncertain, or partial.",
        }),
      ),
    }),
    execute: async (_id, params) => {
      // params.confidence is typed as string (TypeBox enum inference widens);
      // coerce into the union, defaulting to undefined for unknown values.
      const confidence =
        params.confidence === "high" || params.confidence === "medium" || params.confidence === "low"
          ? params.confidence
          : undefined;
      state.result = {
        summary: params.summary,
        approach: params.approach,
        confidence,
        needs_human_review: params.needs_human_review,
      };
      log.info({ confidence: params.confidence, review: params.needs_human_review }, "agent called finish_run");
      return {
        content: [
          {
            type: "text" as const,
            text: "Summary recorded. The run will be finalized by Noodle.",
          },
        ],
        details: {},
      };
    },
  });
}
