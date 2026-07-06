import { readFileSync, existsSync } from "node:fs";
import { log } from "../util/log.js";

/**
 * Parse a pi session JSONL file into the flat message list the chat UI renders.
 *
 * The session file (pointed to by `runs.session_path`) is one JSON object per
 * line, tagged by `type`. Only `type:"message"` rows carry conversation turns;
 * the rest (`session`, `model_change`, `thinking_level_change`) are bookkeeping
 * with no UI value and are skipped.
 *
 * A `message` row's `message.content` is an array of parts:
 *   - `{type:"text", text}`              — user or assistant prose
 *   - `{type:"toolCall", name, arguments}` — the assistant invoking a tool
 * Tool *results* arrive as their own `message` row with `role:"toolResult"`,
 * carrying `toolCallId` + `toolName` + a `content:[{type:"text"}]` payload.
 *
 * Output is a flat, in-order list the UI walks top-to-bottom. Empty assistant
 * turns (text "" and no tool calls — e.g. an error stub) are dropped as noise.
 *
 * Parsing is defensive: a malformed line is skipped with a debug log rather
 * than 500'ing the whole view, and a missing file yields `[]` (a run that
 * hasn't persisted a session yet).
 */

/** One assistant tool invocation. `args` is the raw arguments object. */
export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** A user or assistant turn. Assistant turns may carry tool calls alongside text. */
export interface ParsedChatMessage {
  role: "user" | "assistant";
  text: string;
  toolCalls?: ParsedToolCall[];
}

/** A tool result, rendered as a dim chip under the turn that produced it. */
export interface ParsedToolResult {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  text: string;
}

export type ParsedMessage = ParsedChatMessage | ParsedToolResult;

/**
 * Read + parse a session JSONL file. Returns `[]` when the file is missing or
 * unreadable (e.g. a run still in flight, or a session cleaned up). Malformed
 * lines are skipped individually so one bad line never blanks the view.
 */
export function readSession(filePath: string): ParsedMessage[] {
  if (!filePath || !existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    log.debug({ err: e, filePath }, "session file unreadable");
    return [];
  }

  const out: ParsedMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // A truncated/garbled line shouldn't hide the rest of the conversation.
      continue;
    }
    const rec = obj as Record<string, unknown>;
    if (rec?.type !== "message") continue;

    const msg = rec.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const role = msg.role as string | undefined;
    const content = msg.content as unknown[] | undefined;

    if (role === "toolResult") {
      const text = extractText(content);
      if (text === null) continue;
      out.push({
        role: "toolResult",
        toolCallId: String(msg.toolCallId ?? ""),
        toolName: String(msg.toolName ?? "tool"),
        text,
      });
      continue;
    }

    if (role !== "user" && role !== "assistant") continue;

    const text = extractText(content) ?? "";
    const toolCalls = extractToolCalls(content);
    // Drop empty assistant stubs (e.g. an errored turn with "" text and no calls).
    if (role === "assistant" && text === "" && toolCalls.length === 0) continue;

    const entry: ParsedChatMessage = { role, text };
    if (toolCalls.length > 0) entry.toolCalls = toolCalls;
    out.push(entry);
  }
  return out;
}

/** Join all `{type:"text"}` parts into one string, or null if none present. */
function extractText(content: unknown[] | undefined): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .filter((c) => c.type === "text")
    .map((c) => String(c.text ?? ""));
  if (parts.length === 0) return null;
  return parts.join("");
}

/** Pull `{type:"toolCall"}` parts into the trimmed shape the UI renders. */
function extractToolCalls(content: unknown[] | undefined): ParsedToolCall[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .filter((c) => c.type === "toolCall")
    .map((c) => ({
      name: String(c.name ?? "tool"),
      args: (c.arguments as Record<string, unknown>) ?? {},
    }));
}
