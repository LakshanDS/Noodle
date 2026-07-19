import { describe, it, expect } from "vitest";
import {
  buildPrBody,
  buildIssueComment,
  buildErrorComment,
  buildFooter,
  formatDuration,
  labelsFor,
  type RunStats,
} from "../src/engine/run.js";
import { buildCronIssueBody, buildCronErrorBody } from "../src/engine/scheduler-run.js";
import { buildTriggerIssueBody, buildTriggerErrorBody } from "../src/engine/trigger-run.js";

const profile = { name: "claude", provider: "anthropic", model: "claude-sonnet-4-20250514" };
const changedFiles = ["src/auth.ts", "tests/auth.test.ts"];
const agentMessage =
  "Yes, the project has a dashboard. It lives at `/jasladmin/dashboard`, " +
  "gated by TOTP login at `/jasladmin/login`. The main page shows system stats " +
  "and there are per-section management pages for projects, roadmap, and skills.";

const stats: RunStats = {
  durationMs: 252000, // 4m 12s
  tokens: { input: 45210, output: 3180, cacheRead: 0, cacheWrite: 0, total: 48390 },
  cost: 0.1834,
  toolCalls: 8,
  turns: 3,
};

describe("formatDuration", () => {
  it("formats sub-second as ms", () => {
    expect(formatDuration(500)).toBe("500ms");
  });
  it("formats seconds", () => {
    expect(formatDuration(42000)).toBe("42s");
  });
  it("formats minutes + seconds", () => {
    expect(formatDuration(252000)).toBe("4m 12s");
  });
});

describe("buildFooter", () => {
  it("puts the agent name alone on the first line", () => {
    const f = buildFooter(profile, "Noodle-Agent", stats);
    expect(f.split("\n")[0]).toBe("🤖 **Noodle-Agent**");
  });

  it("includes profile + model on the Profile line", () => {
    const f = buildFooter(profile, "Noodle-Agent", stats);
    expect(f).toContain("Profile: claude (`anthropic/claude-sonnet-4-20250514`)");
  });

  it("includes duration, tool calls, and turns on the Cooked-for line", () => {
    const f = buildFooter(profile, "Noodle-Agent", stats);
    expect(f).toContain("Cooked for: 4m 12s");
    expect(f).toContain("8 tool calls");
    expect(f).toContain("3 turns");
  });

  it("includes token usage with compact K/M/B suffixes", () => {
    const f = buildFooter(profile, "Noodle", stats);
    expect(f).toContain("45.21K in");
    expect(f).toContain("3.18K out");
    expect(f).toContain("48.39K total");
  });

  it("omits cache tokens when cacheRead/cacheWrite are 0", () => {
    const f = buildFooter(profile, "Noodle-Agent", stats);
    expect(f).not.toContain("cache read");
    expect(f).not.toContain("cache write");
  });

  it("includes cache tokens when non-zero (caching providers)", () => {
    const cacheStats: RunStats = {
      ...stats,
      tokens: { input: 45210, output: 3180, cacheRead: 12800, cacheWrite: 5000, total: 66190 },
    };
    const f = buildFooter(profile, "Noodle", cacheStats);
    // Cache tokens render as a percentage of input tokens (12800/45210 ≈ 28%).
    expect(f).toContain("28% cache read");
    expect(f).toContain("11% cache write");
    expect(f).toContain("66.19K total");
  });

  it("includes cost for priced providers", () => {
    const f = buildFooter(profile, "Noodle-Agent", stats);
    expect(f).toContain("$0.18");
  });

  it("omits cost line when cost is 0 (local/custom models)", () => {
    const localStats: RunStats = { ...stats, cost: 0 };
    const f = buildFooter(profile, "Noodle", localStats);
    expect(f).not.toMatch(/^Cost:/m);
    // tokens still present
    expect(f).toContain("48.39K total");
  });

  it("omits Cooked-for/Tokens/Cost lines when stats missing", () => {
    const f = buildFooter(profile, "Noodle", undefined);
    expect(f).not.toMatch(/Cooked for:/);
    expect(f).not.toMatch(/^Tokens:/m);
    expect(f).not.toMatch(/^Cost:/m);
    // identity lines + fun line still there
    expect(f).toContain("**Noodle-Agent**");
    expect(f).toContain("Profile:");
    expect(f).toMatch(/^\*.+\*$/m);
  });

  it("does not include a PR link (PR is shown in the issue timeline)", () => {
    const f = buildFooter(profile, "Noodle", stats);
    expect(f).not.toContain("PR #");
  });

  it("includes a fun one-liner in italics as the last line", () => {
    const f = buildFooter(profile, "Noodle", stats);
    expect(f).toMatch(/\*[^*]+\*$/m);
  });
});

describe("buildPrBody", () => {
  it("uses the agent message verbatim as the body", () => {
    const body = buildPrBody(profile, changedFiles, "https://x/#42", agentMessage, "Noodle", stats);
    expect(body).toContain(agentMessage);
    expect(body).toContain("- `src/auth.ts`");
    expect(body).toContain("Closes https://x/#42");
  });

  it("includes the footer with stats", () => {
    const body = buildPrBody(profile, changedFiles, "https://x/#42", agentMessage, "Noodle", stats);
    expect(body).toContain("4m 12s");
    expect(body).toContain("48.39K total");
    expect(body).toContain("$0.18");
  });

  it("falls back to a notice when the agent left no message", () => {
    const body = buildPrBody(profile, changedFiles, "https://x/#42", undefined);
    expect(body).toMatch(/did not leave a summary/i);
    expect(body).toContain("Closes https://x/#42");
  });

  it("accepts legacy callsites passing profile name as a string", () => {
    const body = buildPrBody("claude", changedFiles, "https://x/#42", agentMessage);
    expect(body).toContain(agentMessage);
    expect(body).toContain("**Noodle-Agent**");
  });
});

describe("buildIssueComment", () => {
  it("posts the agent message verbatim with the footer", () => {
    const c = buildIssueComment(profile, agentMessage, "Noodle", stats);
    expect(c.startsWith(agentMessage)).toBe(true);
    expect(c).toContain("**Noodle-Agent**");
    expect(c).toContain("claude-sonnet-4-20250514");
    expect(c).toContain("4m 12s");
    // no PR link — shown in the issue timeline, not the footer
    expect(c).not.toContain("PR #");
  });

  it("uses a generic note when the agent produced no message", () => {
    const c = buildIssueComment(profile, undefined);
    expect(c).toMatch(/made no code changes and left no message/i);
    expect(c).toContain("Noodle-Agent");
  });

  it("preserves the agent's markdown formatting", () => {
    const msg = "## Answer\n\nYes — see `src/app/dashboard/page.tsx`.\n\n- bullet one\n- bullet two";
    const c = buildIssueComment(profile, msg);
    expect(c).toContain("## Answer");
    expect(c).toContain("`src/app/dashboard/page.tsx`");
  });
});

describe("buildErrorComment", () => {
  it("posts a templated error notice quoting the actual error", () => {
    const c = buildErrorComment(profile, "insufficient_quota: monthly limit reached", "Noodle", stats);
    expect(c).toMatch(/errored out before finishing/i);
    expect(c).toContain("insufficient_quota: monthly limit reached");
    expect(c).toMatch(/No changes were made/);
  });

  it("includes the footer with stats captured up to failure", () => {
    const c = buildErrorComment(profile, "rate limited (429)", "Noodle", stats);
    expect(c).toContain("4m 12s");
    expect(c).toContain("48.39K total");
  });

  it("works without stats", () => {
    const c = buildErrorComment(profile, "boom");
    expect(c).toContain("boom");
    expect(c).toContain("**Noodle-Agent**");
    expect(c).not.toContain("📊");
  });

  it("falls back to 'unknown error' for empty messages", () => {
    const c = buildErrorComment(profile, "");
    expect(c).toContain("unknown error");
  });
});

describe("custom agent name", () => {
  it("uses the custom name (-Agent suffix) in PR body", () => {
    const body = buildPrBody(profile, changedFiles, "https://x/#42", agentMessage, "MyBot", stats);
    expect(body).toContain("**MyBot-Agent**");
    expect(body).not.toContain("**Noodle");
  });

  it("uses the custom name (-Agent suffix) in issue comment", () => {
    const c = buildIssueComment(profile, agentMessage, "MyBot");
    expect(c).toContain("**MyBot-Agent**");
    expect(c).not.toContain("**Noodle");
  });

  it("uses the custom name (-Agent suffix) in error comment", () => {
    const c = buildErrorComment(profile, "boom", "MyBot");
    expect(c).toContain("MyBot-Agent's run");
    expect(c).toContain("**MyBot-Agent**");
  });

  it("uses the custom name (-Agent suffix) in fallback message", () => {
    const c = buildIssueComment(profile, undefined, "MyBot");
    expect(c).toMatch(/MyBot-Agent ran but made no code changes/);
  });

  it("does not double-suffix a name that already ends in Agent", () => {
    const c = buildIssueComment(profile, agentMessage, "Noodle-Agent");
    expect(c).toContain("**Noodle-Agent**");
    expect(c).not.toContain("**Noodle-Agent-Agent**");
  });
});

describe("labelsFor (failed label)", () => {
  it("includes a red 'got Cooked' label for errored runs", () => {
    const labels = labelsFor("Noodle");
    expect(labels.failed.name).toBe("Noodle got Cooked");
    expect(labels.failed.color).toBe("b91c1c");
    expect(labels.failed.description).toMatch(/errored/i);
  });

  it("uses the passed agent name in the failed label", () => {
    const labels = labelsFor("MyBot");
    expect(labels.failed.name).toBe("MyBot got Cooked");
    expect(labels.failed.description).toContain("MyBot");
  });

  it("keeps the three labels distinct", () => {
    const labels = labelsFor("Noodle");
    const names = [labels.cooking.name, labels.cooked.name, labels.failed.name];
    expect(new Set(names).size).toBe(3);
    expect(labels.failed.color).not.toBe(labels.cooked.color);
  });
});

// --- cron / trigger output bodies -------------------------------------------
// These mirror buildErrorComment from run.ts. Every output path — success OR
// error — must carry the footer so a triage list sees the same stats block
// regardless of outcome. An LLM failure (errored run) routes through the error
// body and must still get the footer, never get phrased.

const footer = buildFooter(profile, "Noodle", stats);

describe("buildCronIssueBody", () => {
  it("puts the agent message before the footer", () => {
    const body = buildCronIssueBody(agentMessage, footer);
    expect(body.startsWith(agentMessage)).toBe(true);
    expect(body).toContain("---");
    expect(body).toContain("**Noodle-Agent**");
  });

  it("falls back to a no-findings notice when the message is missing", () => {
    const body = buildCronIssueBody(undefined, footer);
    expect(body).toMatch(/produced no findings/i);
    expect(body).toContain("---");
  });
});

describe("buildCronErrorBody", () => {
  it("posts a templated error notice quoting the actual error", () => {
    const body = buildCronErrorBody("Noodle", "insufficient_quota: monthly limit reached", footer);
    expect(body).toMatch(/scheduled run by Noodle errored out/i);
    expect(body).toContain("insufficient_quota: monthly limit reached");
    expect(body).toMatch(/No findings were produced/);
  });

  it("includes the footer with stats captured up to failure", () => {
    const body = buildCronErrorBody("Noodle", "rate limited (429)", footer);
    expect(body).toContain("4m 12s");
    expect(body).toContain("48.39K total");
  });

  it("falls back to 'unknown error' for empty messages", () => {
    const body = buildCronErrorBody("Noodle", "", footer);
    expect(body).toContain("unknown error");
  });
});

describe("buildTriggerIssueBody", () => {
  it("puts the agent message before the footer", () => {
    const body = buildTriggerIssueBody(agentMessage, footer);
    expect(body.startsWith(agentMessage)).toBe(true);
    expect(body).toContain("---");
    expect(body).toContain("**Noodle-Agent**");
  });

  it("falls back to a no-findings notice when the message is missing", () => {
    const body = buildTriggerIssueBody(undefined, footer);
    expect(body).toMatch(/produced no findings/i);
    expect(body).toContain("---");
  });
});

describe("buildTriggerErrorBody", () => {
  it("posts a templated error notice quoting the actual error", () => {
    const body = buildTriggerErrorBody("Noodle", "insufficient_quota: monthly limit reached", footer);
    expect(body).toMatch(/trigger run by Noodle errored out/i);
    expect(body).toContain("insufficient_quota: monthly limit reached");
    expect(body).toMatch(/No findings were produced/);
  });

  it("includes the footer with stats captured up to failure", () => {
    const body = buildTriggerErrorBody("Noodle", "rate limited (429)", footer);
    expect(body).toContain("4m 12s");
    expect(body).toContain("48.39K total");
  });

  it("falls back to 'unknown error' for empty messages", () => {
    const body = buildTriggerErrorBody("Noodle", "", footer);
    expect(body).toContain("unknown error");
  });
});
