import { describe, it, expect, vi } from "vitest";
import { NoodleConfigSchema } from "../src/config/schema.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, RuntimeSession } from "../src/engine/runtime.js";

/**
 * Verifies `runJob` records the resolved runtime name on the run store — the
 * load-bearing piece of runtime dispatch. The actual runtime selection
 * (`resolveRuntimeName`) is tested in runtime-select.test.ts; this test confirms
 * the engine wires it through to the store so the dashboard can show which
 * engine ran each run.
 *
 * The run itself is mocked end-to-end (git, skills, session) — we only assert
 * on the store updates, not on agent behavior.
 */

vi.mock("../src/util/paths.js", () => ({
  installSkills: vi.fn().mockResolvedValue(undefined),
  noodleSkillsDir: () => "/tmp/skills",
}));
vi.mock("../src/engine/workspace.js", () => ({
  Workspace: {
    clone: vi.fn().mockResolvedValue({
      path: mkdtempSync(join(tmpdir(), "noodle-rt-")),
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

function makeConfig(profileRuntime?: "pi" | "opencode", defaultRuntime?: "pi" | "opencode") {
  return NoodleConfigSchema.parse({
    agent_name: "Noodle",
    default_profile: "p",
    ...(defaultRuntime ? { default_runtime: defaultRuntime } : {}),
    profiles: { p: { provider: "openai", model: "gpt-4o-mini", ...(profileRuntime ? { runtime: profileRuntime } : {}) } },
    routing: [],
  });
}

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

/** A fake runtime that records its name and returns a no-op session. */
function fakeRuntime(name: "pi" | "opencode"): AgentRuntime {
  const noopSession: RuntimeSession = {
    prompt: async () => {},
    subscribe: () => () => {},
    abort: async () => {},
    dispose: async () => {},
    getSessionStats: () => ({ tokens: { total: 0 }, cost: 0, toolCalls: 0, assistantMessages: 0 }),
    messages: [],
  };
  return {
    name,
    boot: async () => ({
      session: noopSession,
      sessionPath: `/tmp/${name}-session`,
      watcher: { dispose() {}, attach() { return undefined; }, didStall: false, activeBudget: "idle" as const, enabled: true } as never,
      unsubscribeStall: undefined,
    }),
    resume: async () => ({
      session: noopSession,
      sessionPath: `/tmp/${name}-session`,
      watcher: { dispose() {}, attach() { return undefined; }, didStall: false, activeBudget: "idle" as const, enabled: true } as never,
      unsubscribeStall: undefined,
    }),
  };
}

describe("runJob runtime dispatch", () => {
  it("records the profile's runtime on the run store (pi)", async () => {
    const config = makeConfig("pi");
    const updates: { runtime?: string }[] = [];
    const runStore = { createRun: () => {}, updateRun: (_id: string, u: { runtime?: string }) => { updates.push(u); } };

    await runJob(config, mockGh(), { repo: "o/r", issueNumber: 1 }, {
      runtime: fakeRuntime("pi"),
      tokenProvider: async () => "fake-token",
      runStore: runStore as any,
    });

    const runtimeUpdate = updates.find((u) => u.runtime);
    expect(runtimeUpdate?.runtime).toBe("pi");
  });

  it("records the profile's runtime on the run store (opencode)", async () => {
    const config = makeConfig("opencode");
    const updates: { runtime?: string }[] = [];
    const runStore = { createRun: () => {}, updateRun: (_id: string, u: { runtime?: string }) => { updates.push(u); } };

    await runJob(config, mockGh(), { repo: "o/r", issueNumber: 1 }, {
      runtime: fakeRuntime("opencode"),
      tokenProvider: async () => "fake-token",
      runStore: runStore as any,
    });

    const runtimeUpdate = updates.find((u) => u.runtime);
    expect(runtimeUpdate?.runtime).toBe("opencode");
  });
});
