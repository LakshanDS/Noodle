import { describe, it, expect } from "vitest";
import {
  buildPrompt,
  buildRunPrompt,
  defaultCommandPrompt,
  DEFAULT_SYSTEM_PROMPT,
} from "../src/engine/prompt.js";
import type { IssueData } from "../src/github/client.js";

const issue: IssueData = {
  number: 7,
  title: "Fix the login bug",
  body: "Login returns 500.",
  labels: [],
  html_url: "https://github.com/o/r/issues/7",
} as IssueData;

const sysPrompt = DEFAULT_SYSTEM_PROMPT;

describe("prompt split: /noodle stays byte-identical", () => {
  it("buildPrompt equals buildRunPrompt(defaultCommandPrompt(...))", () => {
    const legacy = buildPrompt(sysPrompt, issue, []);
    const rebuilt = buildRunPrompt(
      sysPrompt,
      defaultCommandPrompt(),
      issue,
      [],
    );
    expect(rebuilt).toBe(legacy);
  });

  it("the system prompt is always at the top", () => {
    const p = buildRunPrompt(sysPrompt, defaultCommandPrompt(), issue, []);
    expect(p.startsWith(sysPrompt)).toBe(true);
  });

  it("includes 'The issue you have been given' context header for issue mode", () => {
    const p = buildRunPrompt(sysPrompt, defaultCommandPrompt(), issue, []);
    expect(p).toContain("The issue you have been given");
  });

  it("a custom command's framing appears after the context header", () => {
    const custom = "You are answering a question. Keep it to two sentences.";
    const p = buildRunPrompt(sysPrompt, custom, issue, []);
    expect(p).toContain("The issue you have been given");
    expect(p).toContain(custom);
    // Context block is still appended after the framing.
    expect(p).toContain("## Issue");
    expect(p).toContain("Fix the login bug");
    expect(p).toContain("Issue URL: https://github.com/o/r/issues/7");
  });
});

describe("prompt PR mode", () => {
  it("framing switches to 'The comments on this PR' when isPR is true", () => {
    const p = buildRunPrompt(sysPrompt, defaultCommandPrompt(), issue, [], true);
    expect(p.startsWith(sysPrompt)).toBe(true);
    expect(p).toContain("The comments on this PR");
    expect(p).toContain("## Pull Request");
    expect(p).toContain("PR URL: https://github.com/o/r/issues/7");
    // The issue-mode wording must NOT appear.
    expect(p).not.toContain("The issue you have been given");
    expect(p).not.toContain("## Issue");
  });

  it("buildPrompt forwards isPR to buildRunPrompt", () => {
    const direct = buildRunPrompt(sysPrompt, defaultCommandPrompt(), issue, [], true);
    const viaLegacy = buildPrompt(sysPrompt, issue, [], true);
    expect(viaLegacy).toBe(direct);
  });
});
