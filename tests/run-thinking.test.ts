import { describe, it, expect, vi } from "vitest";
import { NoodleConfigSchema } from "../src/config/schema.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeBootOptions, RuntimeSession } from "../src/engine/runtime.js";

/**
 * Verifies the profile's `thinking_level` actually reaches the agent runtime's
 * boot options (and thus the underlying session). This was previously dropped
 * silently (a config field that parsed + validated but was never forwarded).
 *
 * Heavy dependencies (git clone, skill install) are mocked so the run reaches
 * the runtime boot cheaply, then the injected `bootFn` stub captures the
 * resolved profile and returns a minimal no-op session.
 *
 * Post-runtime-abstraction: the test no longer mocks pi's createAgentSession
 * directly (that's now PiRuntime's job). Instead it injects a `bootFn` that
 * bypasses the runtime entirely and inspects the RuntimeBootOptions the run
 * loop would have passed to the runtime — which carries the resolved profile.
 */

// Stub the git/skill side so we don't need a real repo.
vi.mock("../src/util/paths.js", () => ({
  installSkills: vi.fn().mockResolvedValue(undefined),
  noodleSkillsDir: () => "/tmp/skills",
}));
vi.mock("../src/engine/workspace.js", () => ({
  Workspace: {
    clone: vi.fn().mockResolvedValue({
      path: mkdtempSync(join(tmpdir(), "noodle-test-")),
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

// Import AFTER mocks are registered.
const { runJob } = await import("../src/engine/run.js");

function makeConfig(thinkingLevel?: string) {
  const profile: Record<string, unknown> = { provider: "openai", model: "gpt-4o-mini" };
  if (thinkingLevel !== undefined) profile.thinking_level = thinkingLevel;
  return NoodleConfigSchema.parse({
    agent_name: "TestBot",
    default_profile: "p",
    profiles: { p: profile },
    routing: [],
  });
}

/** Minimal mock GitHubClient — returns enough for the run to reach session boot. */
function mockGh() {
  return {
    getIssue: async () => ({ number: 1, title: "t", body: "b", labels: [], html_url: "https://x/1" }),
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

/** A no-op RuntimeSession the bootFn returns — enough for the run loop to finish. */
function noopSession(): RuntimeSession {
  return {
    prompt: async () => {},
    subscribe: () => () => {},
    abort: async () => {},
    dispose: async () => {},
    getSessionStats: () => ({ tokens: { total: 0 }, cost: 0, toolCalls: 0, assistantMessages: 0 }),
    messages: [],
  };
}

describe("runJob forwards thinking_level to the runtime", () => {
  it("passes the profile's thinking_level through to the boot options", async () => {
    const config = makeConfig("high");
    let captured: Pick<RuntimeBootOptions, "profile"> | null = null;

    const bootFn = vi.fn((opts: RuntimeBootOptions) => {
      captured = { profile: opts.profile };
      return Promise.resolve(noopSession());
    });

    await runJob(config, mockGh(), { repo: "o/r", issueNumber: 1 }, {
      bootFn: bootFn as any,
      tokenProvider: async () => "fake-token",
    });

    expect(bootFn).toHaveBeenCalledOnce();
    expect(captured).not.toBeNull();
    expect(captured!.profile.thinking_level).toBe("high");
  });

  it("defaults to medium when thinking_level is omitted in config", async () => {
    const config = makeConfig(undefined); // no thinking_level in profile
    let captured: Pick<RuntimeBootOptions, "profile"> | null = null;

    const bootFn = vi.fn((opts: RuntimeBootOptions) => {
      captured = { profile: opts.profile };
      return Promise.resolve(noopSession());
    });

    await runJob(config, mockGh(), { repo: "o/r", issueNumber: 1 }, {
      bootFn: bootFn as any,
      tokenProvider: async () => "fake-token",
    });

    expect(captured!.profile.thinking_level).toBe("medium");
  });
});
