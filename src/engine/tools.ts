import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { GitHubClient } from "../github/client.js";
import { log } from "../util/log.js";
import type { RuntimeCustomTool } from "./runtime.js";

/**
 * Runtime-neutral custom tools built by `runJob`. Each `RuntimeCustomTool` is a
 * plain descriptor (name, description, JSON-Schema parameters, async execute
 * returning text); the active runtime's adapter translates it into its native
 * tool format. `PiRuntime` wraps each in pi's `defineTool(...)`.
 *
 * `comment_on_issue` is the mid-run output path for issue→PR runs (the agent
 * asks the reporter a question or shares progress). The agent's END-of-run
 * answer is never a tool call: it writes a normal final text message, and
 * Noodle turns it into the issue comment + PR body (issue→PR runs) or into a
 * newly-opened issue (cron runs).
 */

/**
 * `comment_on_issue(body)` — post a comment on the issue being worked on.
 * Lets the agent ask the reporter a clarifying question or share progress
 * mid-run without waiting for the run to finish.
 *
 * End-of-run reporting is not a tool: the agent posts its full final answer as
 * a normal text message, and Noodle phrases it into the issue comment / PR body
 * after the run.
 *
 * Returns a runtime-neutral `RuntimeCustomTool`; `PiRuntime` adapts it to pi's
 * `defineTool` at boot time.
 */
export function createCommentOnIssueTool(
  gh: GitHubClient,
  repo: string,
  issueNumber: number,
  agentName = "Noodle",
): RuntimeCustomTool {
  return {
    name: "comment_on_issue",
    label: "Comment on Issue",
    description:
      "Post a comment on the GitHub issue currently being worked on. " +
      "Use to ask the reporter a clarifying question or share progress. " +
      "This does not end the run — to finish, write your full final answer as " +
      `a normal text message and ${agentName} will handle the rest.`,
    parameters: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description: "The comment text, in Markdown.",
        },
      },
      required: ["body"],
    },
    execute: async (params) => {
      try {
        const body = String(params.body ?? "");
        const url = await gh.createIssueComment(repo, issueNumber, body);
        log.info({ repo, issueNumber }, "agent posted issue comment");
        return `Posted comment: ${url}`;
      } catch (e) {
        // Throwing signals an error to the model (the adapter reports it with isError).
        throw new Error(`Failed to post comment: ${(e as Error).message}`);
      }
    },
  };
}

/**
 * Adapt a runtime-neutral `RuntimeCustomTool` to pi's `defineTool(...)` shape.
 * Used by `PiRuntime.boot()` for each entry in `opts.customTools`.
 *
 * The tool's JSON-Schema `parameters` become a typebox `Type.Object` via a
 * shallow mapping (the schemas we build are simple — `Type.Object({ body:
 * Type.String(...) })` shape). pi's `execute` returns `{ content: [{type:"text",
 * text}], details: {} }` on success and throws on error (pi reports it with
 * `isError`).
 */
export function toPiTool(tool: RuntimeCustomTool) {
  return defineTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: jsonSchemaToTypebox(tool.parameters),
    execute: async (_id, params) => {
      const text = await tool.execute(params as Record<string, unknown>);
      return {
        content: [{ type: "text" as const, text }],
        details: {},
      };
    },
  });
}

/**
 * Translate a plain JSON-Schema object (as carried by `RuntimeCustomTool`) into
 * a typebox `Type.Object(...)`. Noodle's custom tools use only simple shapes
 * (string/number/boolean properties with descriptions), so a shallow mapping
 * suffices — nested objects/arrays are passed through opaquely. Any unhandled
 * JSON-Schema keyword is dropped; the properties that matter (type, description)
 * are preserved.
 */
function jsonSchemaToTypebox(schema: Record<string, unknown>) {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const typeboxProps: Record<string, TSchema> = {};
  for (const [key, def] of Object.entries(props)) {
    const t = typeof def === "object" && def !== null ? (def as { type?: string }).type : undefined;
    const desc = typeof def === "object" && def !== null ? (def as { description?: string }).description : undefined;
    let node: TSchema;
    switch (t) {
      case "string":  node = Type.String({ description: desc }); break;
      case "number":
      case "integer": node = Type.Number({ description: desc }); break;
      case "boolean": node = Type.Boolean({ description: desc }); break;
      default:        node = Type.Any();
    }
    if (!required.has(key)) {
      node = Type.Optional(node);
    }
    typeboxProps[key] = node;
  }
  return Type.Object(typeboxProps);
}
