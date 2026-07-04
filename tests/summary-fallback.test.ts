import { describe, it, expect } from "vitest";
import { extractLastAssistantText } from "../src/engine/run.js";

/**
 * extractLastAssistantText pulls the agent's final answer out of the session —
 * posted verbatim as the issue comment / PR body. It must tolerate both pi
 * content shapes — a plain string, and an array of {type, text} parts — and
 * skip non-assistant messages.
 */

describe("extractLastAssistantText", () => {
  it("returns the last assistant message when content is a string", () => {
    const session = {
      messages: [
        { role: "user", content: "fix the bug" },
        { role: "assistant", content: "thinking about it" },
        { role: "assistant", content: "Yes, the project has a dashboard." },
      ],
    };
    expect(extractLastAssistantText(session)).toBe("Yes, the project has a dashboard.");
  });

  it("joins multiple text parts from an array content", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "## Summary" },
            { type: "text", text: "Answer: yes, it has a dashboard." },
          ],
        },
      ],
    };
    expect(extractLastAssistantText(session)).toBe("## Summary\nAnswer: yes, it has a dashboard.");
  });

  it("ignores non-text parts (e.g. tool_use) in an array content", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "bash", input: { command: "ls" } },
            { type: "text", text: "All done. No code changes needed." },
          ],
        },
      ],
    };
    expect(extractLastAssistantText(session)).toBe("All done. No code changes needed.");
  });

  it("skips assistant messages with empty/whitespace-only text", () => {
    const session = {
      messages: [
        { role: "assistant", content: "   " },
        { role: "assistant", content: [{ type: "text", text: "" }] },
        { role: "assistant", content: "real answer" },
      ],
    };
    expect(extractLastAssistantText(session)).toBe("real answer");
  });

  it("skips over trailing user messages to find the last assistant text", () => {
    const session = {
      messages: [
        { role: "assistant", content: "the answer" },
        { role: "user", content: "thanks" },
      ],
    };
    expect(extractLastAssistantText(session)).toBe("the answer");
  });

  it("returns undefined when there is no assistant message", () => {
    const session = { messages: [{ role: "user", content: "hi" }] };
    expect(extractLastAssistantText(session)).toBeUndefined();
  });

  it("returns undefined when messages is missing or not an array", () => {
    expect(extractLastAssistantText({})).toBeUndefined();
    expect(extractLastAssistantText({ messages: "nope" })).toBeUndefined();
    expect(extractLastAssistantText(undefined)).toBeUndefined();
  });

  it("returns undefined when the only assistant message has no text parts", () => {
    const session = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", name: "bash" }] },
      ],
    };
    expect(extractLastAssistantText(session)).toBeUndefined();
  });
});
