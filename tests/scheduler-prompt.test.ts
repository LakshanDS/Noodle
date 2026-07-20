import { describe, it, expect } from "vitest";
import { buildSchedulerPrompt, DEFAULT_SYSTEM_PROMPT } from "../src/engine/prompt.js";

const systemPrompt = DEFAULT_SYSTEM_PROMPT;

describe("buildSchedulerPrompt", () => {
  it("includes the system prompt as the base and the task as extension", () => {
    const prompt = buildSchedulerPrompt(systemPrompt, "Find bugs and open issues.");
    expect(prompt.startsWith(systemPrompt)).toBe(true);
    expect(prompt).toContain("Your scheduled task instructions");
    expect(prompt).toContain("Find bugs and open issues.");
  });

  it("uses the expanded system prompt at the top", () => {
    const prompt = buildSchedulerPrompt(systemPrompt, "sweep");
    // The system prompt starts the output
    expect(prompt.startsWith(systemPrompt)).toBe(true);
    // The extension follows after it
    const afterSys = prompt.substring(systemPrompt.length);
    expect(afterSys).toContain("Your scheduled task instructions");
    expect(afterSys).toContain("sweep");
  });

  it("falls back to a placeholder for an empty task", () => {
    const prompt = buildSchedulerPrompt(systemPrompt, "   ");
    expect(prompt).toContain("no task specified");
  });

  it("the system prompt contains {repository} and {system} tags for expansion", () => {
    // These tags should be in the raw DEFAULT_SYSTEM_PROMPT before expandTags runs
    expect(systemPrompt).toContain("{repository}");
    expect(systemPrompt).toContain("{system}");
  });
});
