import { describe, it, expect } from "vitest";
import { piEventToRuntimeEvent } from "../src/engine/runtimes/pi.js";
import type { RuntimeEvent } from "../src/engine/runtime.js";

/**
 * Unit tests for the pi → RuntimeEvent translator (piEventToRuntimeEvent).
 *
 * This mapper is the load-bearing piece of the pi adapter: it converts pi's
 * native AgentSessionEvent shapes into the normalized RuntimeEvent union so the
 * stall watcher + log subscriber consume one shape regardless of runtime.
 *
 * Each case maps a representative pi event to its RuntimeEvent counterpart.
 * Unknown event types collapse to `activity` (the catch-all that pokes the stall
 * watcher without a log line).
 */

describe("piEventToRuntimeEvent", () => {
  it("maps agent_start", () => {
    expect(piEventToRuntimeEvent({ type: "agent_start" })).toEqual<RuntimeEvent>({ type: "agent_start" });
  });

  it("maps agent_end with willRetry", () => {
    expect(piEventToRuntimeEvent({ type: "agent_end", willRetry: true }))
      .toEqual<RuntimeEvent>({ type: "agent_end", willRetry: true });
    expect(piEventToRuntimeEvent({ type: "agent_end" }))
      .toEqual<RuntimeEvent>({ type: "agent_end", willRetry: undefined });
  });

  it("maps message_end for assistant messages (concatenating text parts)", () => {
    const ev = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "world" },
        ],
      },
    };
    expect(piEventToRuntimeEvent(ev)).toEqual<RuntimeEvent>({
      type: "message_end",
      role: "assistant",
      text: "Hello\nworld",
    });
  });

  it("drops message_end for non-assistant roles (tool/user)", () => {
    expect(piEventToRuntimeEvent({ type: "message_end", message: { role: "tool", content: [] } }))
      .toBeNull();
    expect(piEventToRuntimeEvent({ type: "message_end", message: { role: "user", content: [] } }))
      .toBeNull();
  });

  it("maps tool_execution_start with tool name + args", () => {
    const ev = { type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } };
    expect(piEventToRuntimeEvent(ev)).toEqual<RuntimeEvent>({
      type: "tool_start",
      tool: "bash",
      args: { command: "npm test" },
    });
  });

  it("maps tool_execution_end (ok and error), concatenating result text", () => {
    const ok = {
      type: "tool_execution_end",
      toolName: "grep",
      isError: false,
      result: { content: [{ type: "text", text: "match found" }] },
    };
    expect(piEventToRuntimeEvent(ok)).toEqual<RuntimeEvent>({
      type: "tool_end",
      tool: "grep",
      isError: false,
      output: "match found",
    });

    const err = {
      type: "tool_execution_end",
      toolName: "bash",
      isError: true,
      result: { content: [{ type: "text", text: "command failed" }] },
    };
    expect(piEventToRuntimeEvent(err)).toEqual<RuntimeEvent>({
      type: "tool_end",
      tool: "bash",
      isError: true,
      output: "command failed",
    });
  });

  it("maps auto_retry_start", () => {
    const ev = { type: "auto_retry_start", attempt: 2, maxAttempts: 3, errorMessage: "429 Too Many Requests" };
    expect(piEventToRuntimeEvent(ev)).toEqual<RuntimeEvent>({
      type: "retry",
      attempt: 2,
      maxAttempts: 3,
      error: "429 Too Many Requests",
    });
  });

  it("maps compaction_start and compaction_end (with optional error)", () => {
    expect(piEventToRuntimeEvent({ type: "compaction_start" }))
      .toEqual<RuntimeEvent>({ type: "compaction", phase: "start" });
    expect(piEventToRuntimeEvent({ type: "compaction_end" }))
      .toEqual<RuntimeEvent>({ type: "compaction", phase: "end", error: undefined });
    expect(piEventToRuntimeEvent({ type: "compaction_end", errorMessage: "context too large" }))
      .toEqual<RuntimeEvent>({ type: "compaction", phase: "end", error: "context too large" });
  });

  it("collapses unknown event types to activity (the stall-watcher poke)", () => {
    expect(piEventToRuntimeEvent({ type: "turn_start" })).toEqual<RuntimeEvent>({ type: "activity" });
    expect(piEventToRuntimeEvent({ type: "tool_execution_update", partialResult: {} }))
      .toEqual<RuntimeEvent>({ type: "activity" });
    expect(piEventToRuntimeEvent({ type: "message_update" })).toEqual<RuntimeEvent>({ type: "activity" });
    expect(piEventToRuntimeEvent({ type: "queue_update" })).toEqual<RuntimeEvent>({ type: "activity" });
  });

  it("returns null for non-object / null input", () => {
    expect(piEventToRuntimeEvent(null)).toBeNull();
    expect(piEventToRuntimeEvent(undefined)).toBeNull();
    expect(piEventToRuntimeEvent("not an object")).toBeNull();
  });

  it("defaults missing toolName to '?'", () => {
    expect(piEventToRuntimeEvent({ type: "tool_execution_start" }))
      .toEqual<RuntimeEvent>({ type: "tool_start", tool: "?", args: undefined });
  });
});
