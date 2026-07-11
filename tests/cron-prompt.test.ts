import { describe, it, expect } from "vitest";
import { buildCronPrompt } from "../src/engine/prompt.js";

describe("buildCronPrompt", () => {
  it("includes the repo context and the task", () => {
    const prompt = buildCronPrompt("Find bugs and open issues.", "owner/repo");
    expect(prompt).toContain("owner/repo");
    expect(prompt).toContain("Find bugs and open issues.");
  });

  it("instructs the agent to write findings as a final message", () => {
    const prompt = buildCronPrompt("sweep", "o/r");
    expect(prompt.toLowerCase()).toContain("final message");
  });

  it("instructs the agent NOT to open a pull request", () => {
    const prompt = buildCronPrompt("sweep", "o/r");
    // The deliverable is an issue Noodle opens, not a PR.
    expect(prompt.toLowerCase()).toContain("no pull request");
  });

  it("loads only noodle-default, not noodle-fix", () => {
    const prompt = buildCronPrompt("sweep", "o/r");
    expect(prompt).toContain("noodle-default");
    expect(prompt).not.toContain("noodle-fix");
  });

  it("does not include an Issue or Discussion section (no source issue)", () => {
    const prompt = buildCronPrompt("sweep", "o/r");
    expect(prompt).not.toContain("## Issue");
    expect(prompt).not.toContain("## Discussion");
    expect(prompt).toContain("## Task");
  });

  it("prepends sysInfo when supplied", () => {
    const prompt = buildCronPrompt("sweep", "o/r", "Noodle", "## System info\nconstrained");
    expect(prompt.startsWith("## System info")).toBe(true);
  });

  it("uses the agent name in the instructions", () => {
    const prompt = buildCronPrompt("sweep", "o/r", "MyBot");
    expect(prompt).toContain("MyBot");
  });

  it("falls back to a placeholder for an empty task", () => {
    const prompt = buildCronPrompt("   ", "o/r");
    expect(prompt).toContain("no task specified");
  });
});
