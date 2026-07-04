import { describe, it, expect } from "vitest";
import { buildPrBody, buildIssueComment } from "../src/engine/run.js";

const profile = { name: "claude", provider: "anthropic", model: "claude-sonnet-4-20250514" };
const changedFiles = ["src/auth.ts", "tests/auth.test.ts"];
const agentMessage =
  "Yes, the project has a dashboard. It lives at `/jasladmin/dashboard`, " +
  "gated by TOTP login at `/jasladmin/login`. The main page shows system stats " +
  "and there are per-section management pages for projects, roadmap, and skills.";

describe("buildPrBody", () => {
  it("uses the agent message verbatim as the body", () => {
    const body = buildPrBody(profile.name, changedFiles, "https://x/#42", agentMessage);
    expect(body).toContain(agentMessage);
    expect(body).toContain("- `src/auth.ts`");
    expect(body).toContain("Closes https://x/#42");
    expect(body).toContain("Noodle");
  });

  it("falls back to a notice when the agent left no message", () => {
    const body = buildPrBody(profile.name, changedFiles, "https://x/#42", undefined);
    expect(body).toMatch(/did not leave a summary/i);
    expect(body).toContain("- `src/auth.ts`"); // git facts still present
    expect(body).toContain("Closes https://x/#42");
  });
});

describe("buildIssueComment", () => {
  it("posts the agent message verbatim with a signature footer", () => {
    const c = buildIssueComment(profile, agentMessage);
    expect(c.startsWith(agentMessage)).toBe(true);
    // signature footer
    expect(c).toContain("Noodle");
    expect(c).toContain("claude");
    expect(c).toContain("anthropic/claude-sonnet-4-20250514");
    // no PR link when none provided
    expect(c).not.toContain("PR #");
  });

  it("includes the PR link in the signature when a PR was opened", () => {
    const c = buildIssueComment(profile, agentMessage, {
      prNumber: 58,
      prUrl: "https://x/pull/58",
      changedFiles,
    });
    expect(c).toContain("PR #58");
    expect(c).toContain("https://x/pull/58");
  });

  it("uses a generic note when the agent produced no message", () => {
    const c = buildIssueComment(profile, undefined);
    expect(c).toMatch(/made no code changes and left no message/i);
    // still has the signature
    expect(c).toContain("Noodle");
  });

  it("preserves the agent's markdown formatting (no reformatting)", () => {
    const msg = "## Answer\n\nYes — see `src/app/dashboard/page.tsx`.\n\n- bullet one\n- bullet two";
    const c = buildIssueComment(profile, msg);
    expect(c).toContain("## Answer");
    expect(c).toContain("- bullet one");
    expect(c).toContain("`src/app/dashboard/page.tsx`");
  });
});
