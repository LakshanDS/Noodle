import { describe, it, expect } from "vitest";
import {
  buildPrompt,
  buildRunPrompt,
  defaultCommandPrompt,
} from "../src/engine/prompt.js";
import type { IssueData } from "../src/github/client.js";

const issue: IssueData = {
  number: 7,
  title: "Fix the login bug",
  body: "Login returns 500.",
  labels: [],
  html_url: "https://github.com/o/r/issues/7",
} as IssueData;

describe("prompt split: /noodle stays byte-identical", () => {
  it("buildPrompt equals buildRunPrompt(defaultCommandPrompt(...))", () => {
    const legacy = buildPrompt(issue, [], "o/r", "Noodle");
    const rebuilt = buildRunPrompt(
      defaultCommandPrompt("Noodle"),
      issue,
      [],
      "o/r",
    );
    expect(rebuilt).toBe(legacy);
  });

  it("the /noodle framing block is present verbatim in the rebuilt prompt", () => {
    const p = buildRunPrompt(defaultCommandPrompt("Noodle"), issue, [], "o/r");
    expect(p).toContain("Load the `noodle-default` skill before starting.");
    expect(p).toContain("Noodle posts the final answer as a normal text message");
    expect(p).toContain('your final message IS the deliverable.');
  });

  it("a custom command's framing replaces the default block but keeps the context", () => {
    const custom = "You are answering a question. Keep it to two sentences.";
    const p = buildRunPrompt(custom, issue, [], "o/r");
    expect(p).toContain(custom);
    expect(p.startsWith("You are working on an issue in the GitHub repository `o/r`.")).toBe(true);
    // The default skill-loading block must NOT leak into a custom command's prompt.
    expect(p).not.toContain("Load the `noodle-default` skill before starting.");
    // Context block is still appended.
    expect(p).toContain("## Issue");
    expect(p).toContain("Fix the login bug");
    expect(p).toContain("Issue URL: https://github.com/o/r/issues/7");
  });
});

describe("prompt PR mode", () => {
  it("framing switches to 'pull request' when isPR is true", () => {
    const p = buildRunPrompt(defaultCommandPrompt("Noodle"), issue, [], "o/r", undefined, true);
    expect(p).toContain("You are working on a pull request in the GitHub repository `o/r`.");
    expect(p).toContain("## Pull Request");
    expect(p).toContain("PR URL: https://github.com/o/r/issues/7");
    // The issue-mode wording must NOT appear.
    expect(p).not.toContain("You are working on an issue");
    expect(p).not.toContain("## Issue");
  });

  it("buildPrompt forwards isPR to buildRunPrompt", () => {
    const direct = buildRunPrompt(defaultCommandPrompt("Noodle"), issue, [], "o/r", undefined, true);
    const viaLegacy = buildPrompt(issue, [], "o/r", "Noodle", undefined, true);
    expect(viaLegacy).toBe(direct);
  });
});
