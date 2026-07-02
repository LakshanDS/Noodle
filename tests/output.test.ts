import { describe, it, expect } from "vitest";
import { buildPrBody, buildIssueComment } from "../src/engine/run.js";
import type { FinishRunResult } from "../src/engine/tools.js";

const profile = { name: "claude", provider: "anthropic", model: "claude-sonnet-4-20250514" };
const changedFiles = ["src/auth.ts", "tests/auth.test.ts"];
const summary: FinishRunResult = {
  summary: "Fixed verifyToken to check the exp claim; added a regression test.",
  confidence: "high",
  needs_human_review: false,
};

describe("buildPrBody", () => {
  it("uses the agent summary when present", () => {
    const body = buildPrBody(profile.name, changedFiles, "https://x/#42", summary);
    expect(body).toContain(summary.summary);
    expect(body).toContain("Closes https://x/#42");
    expect(body).toContain("- `src/auth.ts`");
  });

  it("falls back to a notice when no summary (agent didn't call finish_run)", () => {
    const body = buildPrBody(profile.name, changedFiles, "https://x/#42", undefined);
    expect(body).toMatch(/did not return a structured summary/i);
    expect(body).toContain("- `src/auth.ts`"); // git facts still present
    expect(body).toContain("Closes https://x/#42");
  });

  it("flags needs_human_review", () => {
    const body = buildPrBody(profile.name, changedFiles, "https://x/#42", {
      ...summary,
      needs_human_review: true,
    });
    expect(body).toMatch(/human review/i);
  });
});

describe("buildIssueComment", () => {
  it("links the PR and quotes the summary when changes were committed", () => {
    const c = buildIssueComment(profile, 58, "https://x/pull/58", changedFiles, summary, true);
    expect(c).toContain("opened #58");
    expect(c).toContain("https://x/pull/58");
    expect(c).toContain("> "); // summary is quoted
    expect(c).toContain("Confidence: high");
    expect(c).toContain("`src/auth.ts`");
  });

  it("explains no-change runs and includes summary if the agent reported one", () => {
    const c = buildIssueComment(profile, undefined, undefined, [], summary, false);
    expect(c).toMatch(/made no code changes/);
    expect(c).toContain(summary.summary.slice(0, 20)); // still quoted
  });

  it("explains no-change runs with the generic message when no summary", () => {
    const c = buildIssueComment(profile, undefined, undefined, [], undefined, false);
    expect(c).toMatch(/may mean the issue needs clarification/);
  });
});
