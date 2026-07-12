import { describe, it, expect, vi } from "vitest";
import { NoodleConfigSchema } from "../src/config/schema.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeSession } from "../src/engine/runtime.js";

/**
 * Tests for the run.ts concurrency gate (cooking label) and #profile routing.
 * Heavy deps (git/skills) mocked, mirroring run-thinking.test.ts.
 *
 * Post-runtime-abstraction: tests inject a `bootFn` (bare RuntimeSession
 * factory) instead of the old `createAgentSessionFn` + `authStorage`. The gate
 * and routing logic live above the runtime, so the assertions are unchanged.
 */

vi.mock("../src/util/paths.js", () => ({
  installSkills: vi.fn().mockResolvedValue(undefined),
  noodleSkillsDir: () => "/tmp/skills",
}));
vi.mock("../src/engine/workspace.js", () => ({
  Workspace: {
    clone: vi.fn().mockResolvedValue({
      path: mkdtempSync(join(tmpdir(), "noodle-gate-")),
      branch: vi.fn(),
      checkoutOrReuse: vi.fn(),
      removeInternals: vi.fn(),
      commitAll: vi.fn().mockResolvedValue(false),
      push: vi.fn(),
      changedFiles: vi.fn().mockResolvedValue([]),
      dispose: vi.fn(),
    }),
  },
  cloneUrlFor: (repo: string, token: string) => `https://${token}@github.com/${repo}`,
}));

const { runJob } = await import("../src/engine/run.js");

function makeConfig(profiles = { p: { provider: "openai", model: "gpt-4o-mini" } }) {
  return NoodleConfigSchema.parse({
    agent_name: "Noodle",
    default_profile: "p",
    profiles,
    routing: [],
  });
}

/** Minimal mock GitHubClient. `labels` controls what getIssue returns. */
function mockGh(labels: string[] = []) {
  return {
    getIssue: async () => ({ number: 1, title: "t", body: "b", labels, html_url: "https://x/1" }),
    getIssueComments: async () => [],
    ensureLabel: async () => {},
    addIssueLabel: async () => {},
    removeIssueLabel: async () => {},
    defaultBranch: async () => "main",
    createIssueComment: async () => "https://x#c1",
    createPullRequest: async () => ({ html_url: "https://x/p/1", number: 1 }),
    findOpenPRForIssue: async () => null,
  } as any;
}

/** A bootFn stub returning a bare no-op RuntimeSession (the new contract). */
function mockBootFn() {
  return vi.fn(() =>
    Promise.resolve({
      prompt: async () => {},
      subscribe: () => () => {},
      abort: async () => {},
      dispose: async () => {},
      getSessionStats: () => ({ tokens: { total: 0 }, cost: 0, toolCalls: 0, assistantMessages: 0 }),
      messages: [],
    } as RuntimeSession),
  );
}

describe("runJob concurrency gate (cooking label)", () => {
  it("skips the run when the issue already has the cooking label", async () => {
    const config = makeConfig();
    const gh = mockGh(["Noodle is cooking"]);
    const bootFn = mockBootFn();

    const result = await runJob(config, gh, { repo: "o/r", issueNumber: 1 }, {
      bootFn: bootFn as any,
      tokenProvider: async () => "fake-token",
    });

    // Did NOT boot a session — the gate short-circuited.
    expect(bootFn).not.toHaveBeenCalled();
    // Returned a clean empty result (NOT a throw — worker won't retry).
    expect(result.profile).toBe("");
    expect(result.changedFiles).toEqual([]);
  });

  it("does NOT skip when only terminal labels are present (cooked/failed)", async () => {
    const config = makeConfig();
    const gh = mockGh(["Noodle cooked here"]);
    const bootFn = mockBootFn();

    await runJob(config, gh, { repo: "o/r", issueNumber: 1 }, {
      bootFn: bootFn as any,
      tokenProvider: async () => "fake-token",
    });

    // Terminal label present → run proceeded normally (booted a session).
    expect(bootFn).toHaveBeenCalledOnce();
  });
});

describe("runJob #profile routing", () => {
  it("routes to a #tagged profile over the default", async () => {
    const config = makeConfig({
      p: { provider: "openai", model: "gpt-4o-mini" },
      claude: { provider: "openai", model: "gpt-4o-mini" },
    });
    // Issue body carries a #claude tag.
    const gh = {
      ...mockGh(),
      getIssue: async () => ({
        number: 1, title: "t", body: "#claude fix this", labels: [], html_url: "https://x/1",
      }),
    };
    const bootFn = mockBootFn();
    // runStore spy captures which profile was routed to.
    const updates: { profile?: string }[] = [];
    const runStore = {
      createRun: () => {},
      updateRun: (_id: string, u: { profile?: string }) => { updates.push(u); },
    };

    await runJob(config, gh as any, { repo: "o/r", issueNumber: 1 }, {
      bootFn: bootFn as any,
      tokenProvider: async () => "fake-token",
      runStore: runStore as any,
    });

    // The #claude tag selected the claude profile, not the default "p".
    const profileUpdate = updates.find((u) => u.profile);
    expect(profileUpdate?.profile).toBe("claude");
  });
});
