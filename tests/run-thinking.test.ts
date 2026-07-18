import { describe, it, expect, vi } from "vitest";
import { NoodleConfigSchema } from "../src/config/schema.js";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Verifies the profile's `thinking_level` actually reaches pi's
 * `createAgentSession`. This was previously dropped silently (a config field
 * that parsed + validated but was never forwarded).
 *
 * Heavy dependencies (git clone, skill install) are mocked so the run reaches
 * the createAgentSession call cheaply, then the injected stub captures the
 * options and aborts.
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
  const profile: Record<string, unknown> = { provider: "openai", model: "gpt-4o-mini", base_url: "https://api.openai.com/v1", api: "openai-completions", api_key: "sk-test" };
  if (thinkingLevel !== undefined) profile.thinking_level = thinkingLevel;
  return NoodleConfigSchema.parse({
    agent_name: "TestBot",
    default_profile: "p",
    profiles: { p: profile },
    routing: [],
  });
}

/** Minimal mock GitHubClient — returns enough for the run to reach session creation. */
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

describe("runJob forwards thinking_level to createAgentSession", () => {
  it("passes the profile's thinking_level through to pi", async () => {
    const config = makeConfig("high");
    let captured: { thinkingLevel?: string } | null = null;

    const createAgentSessionFn = vi.fn((opts: any) => {
      captured = { thinkingLevel: opts.thinkingLevel };
      // Return a minimal session object then resolve — the run will continue
      // but hit the no-changes path and post a comment. We just need the opts.
      return Promise.resolve({
        session: {
          subscribe: () => {},
          prompt: async () => {},
          dispose: async () => {},
          getSessionStats: () => ({ tokens: { total: 0 }, cost: 0, toolCalls: 0, assistantMessages: 0 }),
        },
      });
    });

    await runJob(config, mockGh(), { repo: "o/r", issueNumber: 1 }, {
      authStorage: AuthStorage.create(),
      createAgentSessionFn: createAgentSessionFn as any,
      tokenProvider: async () => "fake-token",
    });

    expect(createAgentSessionFn).toHaveBeenCalledOnce();
    expect(captured).not.toBeNull();
    expect(captured!.thinkingLevel).toBe("high");
  });

  it("defaults to medium when thinking_level is omitted in config", async () => {
    const config = makeConfig(undefined); // no thinking_level in profile
    let captured: { thinkingLevel?: string } | null = null;

    const createAgentSessionFn = vi.fn((opts: any) => {
      captured = { thinkingLevel: opts.thinkingLevel };
      return Promise.resolve({
        session: {
          subscribe: () => {},
          prompt: async () => {},
          dispose: async () => {},
          getSessionStats: () => ({ tokens: { total: 0 }, cost: 0, toolCalls: 0, assistantMessages: 0 }),
        },
      });
    });

    await runJob(config, mockGh(), { repo: "o/r", issueNumber: 1 }, {
      authStorage: AuthStorage.create(),
      createAgentSessionFn: createAgentSessionFn as any,
      tokenProvider: async () => "fake-token",
    });

    expect(captured!.thinkingLevel).toBe("medium");
  });
});
