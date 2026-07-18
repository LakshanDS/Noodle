import { describe, it, expect, vi } from "vitest";
import { NoodleConfigSchema } from "../src/config/schema.js";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRow } from "../src/server/command-store.js";
import { defaultCommandPrompt } from "../src/engine/prompt.js";

/**
 * Verifies that a resolved slash command's `system_prompt` becomes the run's
 * framing (replacing the built-in default), and that template tags inside it
 * are expanded. Also checks the fallback: when no command matches, the default
 * framing is used byte-identically.
 *
 * Mirrors run-thinking.test.ts: git/skill side mocked, createAgentSession
 * stubbed so it captures the prompt and aborts cheaply.
 */

vi.mock("../src/util/paths.js", () => ({
  installSkills: vi.fn().mockResolvedValue(undefined),
  noodleSkillsDir: () => "/tmp/skills",
}));
vi.mock("../src/engine/workspace.js", () => ({
  Workspace: {
    clone: vi.fn().mockResolvedValue({
      path: mkdtempSync(join(tmpdir(), "noodle-cmd-test-")),
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

const { runJob } = await import("../src/engine/run.js");

function makeConfig() {
  return NoodleConfigSchema.parse({
    agent_name: "TestBot",
    default_profile: "p",
    profiles: { p: { provider: "openai", model: "gpt-4o-mini", base_url: "https://api.openai.com/v1", api: "openai-completions", api_key: "sk-test" } },
    routing: [],
  });
}

/** Minimal mock GitHubClient — issue body carries the command trigger. */
function mockGh(body = "b") {
  return {
    getIssue: async () => ({ number: 1, title: "t", body, labels: [], html_url: "https://x/1" }),
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

/** A fake command the resolver returns. */
function fakeCommand(overrides: Partial<CommandRow> = {}): CommandRow {
  return {
    id: 1,
    trigger: "review",
    description: "",
    system_prompt: "You are reviewing code on a {system.tier} box.",
    profile: null,
    runtime: null,
    enabled: 1,
    is_builtin: 0,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    ...overrides,
  };
}

/** Stub createAgentSession that captures the prompt string passed to session.prompt(). */
function capturePromptStub(): { stub: any; getPrompt: () => string | undefined } {
  let capturedPrompt: string | undefined;
  const stub = vi.fn((_opts: any) => {
    return Promise.resolve({
      session: {
        subscribe: () => {},
        // The prompt is passed here — capture the first attempt's text.
        prompt: async (text: string) => { if (capturedPrompt === undefined) capturedPrompt = text; },
        dispose: async () => {},
        getSessionStats: () => ({ tokens: { total: 0 }, cost: 0, toolCalls: 0, assistantMessages: 0 }),
      },
    });
  });
  return { stub, getPrompt: () => capturedPrompt };
}

describe("runJob command framing", () => {
  it("uses the resolved command's system_prompt as framing (not the default)", async () => {
    const config = makeConfig();
    const { stub, getPrompt } = capturePromptStub();
    const cmd = fakeCommand();

    await runJob(config, mockGh("Please /review this"), { repo: "o/r", issueNumber: 1 }, {
      authStorage: AuthStorage.create(),
      createAgentSessionFn: stub as any,
      tokenProvider: async () => "fake-token",
      resolveCommand: () => cmd,
    });

    const prompt = getPrompt()!;
    // The command's framing text appears…
    expect(prompt).toContain("You are reviewing code on a");
    // …the {system.tier} tag was expanded (not left literal)…
    expect(prompt).not.toContain("{system.tier}");
    // …and the default framing is NOT present.
    expect(prompt).not.toContain(defaultCommandPrompt("TestBot").split("\n")[0]);
  });

  it("expands {system.tier} to constrained or capable", async () => {
    const config = makeConfig();
    const { stub, getPrompt } = capturePromptStub();

    await runJob(config, mockGh("Please /review this"), { repo: "o/r", issueNumber: 1 }, {
      authStorage: AuthStorage.create(),
      createAgentSessionFn: stub as any,
      tokenProvider: async () => "fake-token",
      resolveCommand: () => fakeCommand(),
    });

    const prompt = getPrompt()!;
    expect(prompt).toMatch(/(constrained|capable)/);
  });

  it("falls back to defaultCommandPrompt when resolveCommand returns null", async () => {
    const config = makeConfig();
    const { stub, getPrompt } = capturePromptStub();

    await runJob(config, mockGh("no trigger here"), { repo: "o/r", issueNumber: 1 }, {
      authStorage: AuthStorage.create(),
      createAgentSessionFn: stub as any,
      tokenProvider: async () => "fake-token",
      resolveCommand: () => null,
    });

    const prompt = getPrompt()!;
    // The default framing's first line ("**Load both skills before starting:**") is present.
    expect(prompt).toContain(defaultCommandPrompt("TestBot"));
  });

  it("falls back to default when resolveCommand is not provided (CLI/test path)", async () => {
    const config = makeConfig();
    const { stub, getPrompt } = capturePromptStub();

    await runJob(config, mockGh("no trigger"), { repo: "o/r", issueNumber: 1 }, {
      authStorage: AuthStorage.create(),
      createAgentSessionFn: stub as any,
      tokenProvider: async () => "fake-token",
      // No resolveCommand dep — same as the CLI path.
    });

    expect(getPrompt()).toContain(defaultCommandPrompt("TestBot"));
  });
});
