import { describe, it, expect, vi } from "vitest";
import { NoodleConfigSchema } from "../src/config/schema.js";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRow } from "../src/server/command-store.js";

/**
 * Verifies the issue/PR prompt composition contract:
 *
 *  - The operator's global `systemPrompt` dep is always active (expanded and
 *    prepended to sysInfo), regardless of whether a command matched.
 *  - A matched command's `system_prompt` extends it as the framing slot.
 *  - A pure @mention (resolveCommand returns null, or not provided) leaves the
 *    framing slot EMPTY — the base system prompt alone is complete. No legacy
 *    default framing is injected.
 *  - Template tags ({system.tier}, etc.) inside both prompts are expanded.
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

/** A base system prompt matching the shape of the Settings default seed. */
const BASE_SYSTEM_PROMPT = [
  "You are an autonomous software engineer working on a GitHub repository.",
  "Always load the `noodle-default` skill.",
  "Post your final answer as a normal text message — it IS the deliverable.",
  "",
  "{system}",
].join("\n");

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

describe("runJob prompt composition", () => {
  it("uses the resolved command's system_prompt as framing, on top of the base", async () => {
    const config = makeConfig();
    const { stub, getPrompt } = capturePromptStub();
    const cmd = fakeCommand();

    await runJob(config, mockGh("Please /review this"), { repo: "o/r", issueNumber: 1 }, {
      authStorage: AuthStorage.create(),
      createAgentSessionFn: stub as any,
      tokenProvider: async () => "fake-token",
      systemPrompt: BASE_SYSTEM_PROMPT,
      resolveCommand: () => cmd,
    });

    const prompt = getPrompt()!;
    // The command's framing text appears…
    expect(prompt).toContain("You are reviewing code on a");
    // …the {system.tier} tag was expanded (not left literal)…
    expect(prompt).not.toContain("{system.tier}");
    // …the base system prompt is also present (always active)…
    expect(prompt).toContain("Always load the `noodle-default` skill.");
    // …and the issue context block is appended.
    expect(prompt).toContain("You are working on an issue in the GitHub repository `o/r`");
  });

  it("expands {system.tier} to constrained or capable", async () => {
    const config = makeConfig();
    const { stub, getPrompt } = capturePromptStub();

    await runJob(config, mockGh("Please /review this"), { repo: "o/r", issueNumber: 1 }, {
      authStorage: AuthStorage.create(),
      createAgentSessionFn: stub as any,
      tokenProvider: async () => "fake-token",
      systemPrompt: BASE_SYSTEM_PROMPT,
      resolveCommand: () => fakeCommand(),
    });

    const prompt = getPrompt()!;
    expect(prompt).toMatch(/(constrained|capable)/);
  });

  it("leaves the framing slot empty on a pure @mention (resolveCommand returns null)", async () => {
    const config = makeConfig();
    const { stub, getPrompt } = capturePromptStub();

    await runJob(config, mockGh("no trigger here"), { repo: "o/r", issueNumber: 1 }, {
      authStorage: AuthStorage.create(),
      createAgentSessionFn: stub as any,
      tokenProvider: async () => "fake-token",
      systemPrompt: BASE_SYSTEM_PROMPT,
      resolveCommand: () => null,
    });

    const prompt = getPrompt()!;
    // Base system prompt is present (always active)…
    expect(prompt).toContain("Always load the `noodle-default` skill.");
    // …issue context is appended…
    expect(prompt).toContain("You are working on an issue in the GitHub repository `o/r`");
    expect(prompt).toContain("Issue URL: https://x/1");
    // …and NO command framing leaked in (the review command's text is absent).
    expect(prompt).not.toContain("You are reviewing code");
  });

  it("falls back to empty framing when resolveCommand is not provided (CLI/test path)", async () => {
    const config = makeConfig();
    const { stub, getPrompt } = capturePromptStub();

    await runJob(config, mockGh("no trigger"), { repo: "o/r", issueNumber: 1 }, {
      authStorage: AuthStorage.create(),
      createAgentSessionFn: stub as any,
      tokenProvider: async () => "fake-token",
      systemPrompt: BASE_SYSTEM_PROMPT,
      // No resolveCommand dep — same as the CLI path.
    });

    const prompt = getPrompt()!;
    expect(prompt).toContain("Always load the `noodle-default` skill.");
    expect(prompt).toContain("You are working on an issue in the GitHub repository `o/r`");
    expect(prompt).not.toContain("You are reviewing code");
  });
});
