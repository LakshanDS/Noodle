import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession } from "../src/server/session-reader.js";

/**
 * readSession parses pi's session JSONL into the flat message list the chat UI
 * renders. Fixtures mirror the real on-disk record shapes (verified against the
 * sessions dir): type-tagged lines, message rows with role + content[],
 * toolResult rows carrying toolCallId + toolName.
 */

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-session-"));
  path = join(dir, "session.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Real-shaped records, one per line — exactly what pi writes to disk.
const SESSION_LINE = `{"type":"session","version":3,"id":"abc","cwd":"/tmp/x"}`;
const MODEL_LINE = `{"type":"model_change","provider":"nvidia","modelId":"minimaxi/minimax-m3"}`;
const USER_LINE = (text: string) =>
  `{"type":"message","message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;
const ASSISTANT_TEXT_LINE = (text: string) =>
  `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;
const ASSISTANT_TOOLCALL_LINE = (text: string, calls: { name: string; args: object }[]) =>
  `{"type":"message","message":{"role":"assistant","content":[${JSON.stringify({ type: "text", text })},${calls
    .map((c) => JSON.stringify({ type: "toolCall", name: c.name, arguments: c.args }))
    .join(",")}]}}`;
const TOOL_RESULT_LINE = (callId: string, name: string, text: string) =>
  `{"type":"message","message":{"role":"toolResult","toolCallId":${JSON.stringify(
    callId,
  )},"toolName":${JSON.stringify(name)},"content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;

function write(lines: string[]) {
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

describe("readSession", () => {
  it("returns [] for a missing file (run with no persisted session yet)", () => {
    expect(readSession(join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("returns [] for an empty path", () => {
    expect(readSession("")).toEqual([]);
  });

  it("skips non-message records (session/model_change/thinking_level_change)", () => {
    write([SESSION_LINE, MODEL_LINE]);
    expect(readSession(path)).toEqual([]);
  });

  it("parses a user + assistant text exchange", () => {
    write([SESSION_LINE, USER_LINE("Fix the bug"), ASSISTANT_TEXT_LINE("On it.")]);
    const got = readSession(path);
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({ role: "user", text: "Fix the bug" });
    expect(got[1]).toEqual({ role: "assistant", text: "On it." });
  });

  it("parses assistant tool calls alongside text", () => {
    write([
      ASSISTANT_TOOLCALL_LINE("I'll read the file.", [{ name: "read", args: { path: "src/x.ts" } }]),
    ]);
    const got = readSession(path);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ role: "assistant", text: "I'll read the file." });
    expect((got[0] as { toolCalls?: unknown }).toolCalls).toEqual([
      { name: "read", args: { path: "src/x.ts" } },
    ]);
  });

  it("parses multiple tool calls in one assistant turn", () => {
    write([
      ASSISTANT_TOOLCALL_LINE("loading skills", [
        { name: "read", args: { path: "a.md" } },
        { name: "read", args: { path: "b.md" } },
        { name: "bash", args: { command: "ls" } },
      ]),
    ]);
    const got = readSession(path) as Array<{ toolCalls?: unknown[] }>;
    expect(got[0].toolCalls).toHaveLength(3);
  });

  it("parses a toolResult row", () => {
    write([TOOL_RESULT_LINE("call-1", "read", "--- name: skill ---\ncontent")]);
    const got = readSession(path);
    expect(got).toEqual([
      { role: "toolResult", toolCallId: "call-1", toolName: "read", text: "--- name: skill ---\ncontent" },
    ]);
  });

  it("keeps message order across a full exchange", () => {
    write([
      SESSION_LINE,
      USER_LINE("the issue body"),
      ASSISTANT_TOOLCALL_LINE("investigating", [{ name: "read", args: { path: "f" } }]),
      TOOL_RESULT_LINE("c1", "read", "file contents"),
      ASSISTANT_TEXT_LINE("Done, here's what I changed."),
    ]);
    const got = readSession(path);
    expect(got.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });

  it("drops empty assistant stubs (empty text, no tool calls)", () => {
    write([
      ASSISTANT_TEXT_LINE(""), // stub — dropped
      ASSISTANT_TEXT_LINE("real reply"), // kept
    ]);
    const got = readSession(path);
    expect(got).toEqual([{ role: "assistant", text: "real reply" }]);
  });

  it("skips malformed JSON lines without failing the whole file", () => {
    write([
      USER_LINE("first"),
      "{not valid json", // skipped
      ASSISTANT_TEXT_LINE("second"),
    ]);
    const got = readSession(path);
    expect(got.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("tolerates CRLF line endings", () => {
    writeFileSync(path, [USER_LINE("hi"), ASSISTANT_TEXT_LINE("yo")].join("\r\n") + "\r\n", "utf8");
    const got = readSession(path);
    expect(got).toHaveLength(2);
  });

  it("keeps an assistant turn whose text is empty but has tool calls", () => {
    write([ASSISTANT_TOOLCALL_LINE("", [{ name: "bash", args: { command: "ls" } }])]);
    const got = readSession(path) as Array<{ toolCalls?: unknown[] }>;
    expect(got).toHaveLength(1);
    expect(got[0].toolCalls).toHaveLength(1);
  });
});
