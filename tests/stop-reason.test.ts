import { describe, it, expect } from "vitest";
import { lastAssistantStopReason } from "../src/engine/run.js";

/**
 * lastAssistantStopReason reads the stopReason of the last assistant message.
 * pi records an error-stopped turn as { stopReason: "error", errorMessage },
 * and the runner uses this to detect runs that ended in failure — so it can
 * post an honest error comment instead of treating an opening utterance
 * ("I'll load the skills first…") as if it were the agent's answer.
 *
 * The fixture below mirrors a real captured session (Portfolio issue #6 run):
 * the last assistant message has empty text + stopReason "error".
 */

describe("lastAssistantStopReason", () => {
  it("returns stopReason 'error' + errorMessage when the run ended in failure", () => {
    // Real shape from the Portfolio#6 session: the agent errored mid-run.
    const session = {
      messages: [
        { role: "user", content: "..." },
        {
          role: "assistant",
          content: [{ type: "text", text: "I'll load the required skills first…" }],
          stopReason: "toolUse",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "error",
          errorMessage: "Cannot read properties of undefined (reading 'Symbol(pino.msgPrefix)')",
        },
      ],
    };
    const result = lastAssistantStopReason(session);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/Symbol\(pino.msgPrefix\)/);
  });

  it("returns the normal stopReason ('stop') for a successful run", () => {
    const session = {
      messages: [
        { role: "user", content: "..." },
        {
          role: "assistant",
          content: [{ type: "text", text: "Here is the answer." }],
          stopReason: "stop",
        },
      ],
    };
    expect(lastAssistantStopReason(session).stopReason).toBe("stop");
    expect(lastAssistantStopReason(session).errorMessage).toBeUndefined();
  });

  it("returns the toolUse stopReason when the last turn made tool calls", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", name: "read" }],
          stopReason: "toolUse",
        },
      ],
    };
    expect(lastAssistantStopReason(session).stopReason).toBe("toolUse");
  });

  it("skips trailing non-assistant messages (toolResult) to find the last assistant", () => {
    const session = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
        { role: "toolResult", content: "result" },
      ],
    };
    expect(lastAssistantStopReason(session).stopReason).toBe("stop");
  });

  it("returns { stopReason: undefined } when there are no assistant messages", () => {
    expect(lastAssistantStopReason({ messages: [{ role: "user", content: "hi" }] }).stopReason).toBeUndefined();
  });

  it("returns { stopReason: undefined } when messages is missing or not an array", () => {
    expect(lastAssistantStopReason({}).stopReason).toBeUndefined();
    expect(lastAssistantStopReason({ messages: "nope" }).stopReason).toBeUndefined();
    expect(lastAssistantStopReason(undefined).stopReason).toBeUndefined();
  });
});
