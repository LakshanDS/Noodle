import { describe, it, expect, vi } from "vitest";
import { NoodleConfigSchema } from "../src/config/schema.js";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression test for the restart-loop bug: when pi resolves a prompt with
 * stopReason=error on a NON-retryable error (e.g. 404 Not Found, auth, quota),
 * the run must stop after the first attempt — not loop forever.
 *
 * Background: pi still counts an errored assistant turn in
 * getSessionStats().assistantMessages. The old loop misread that increment as
 * "the agent made real progress" and used it to reset the restart budget every
 * cycle, so a 404 (a fatal config error: wrong base_url / model name) looped
 * until the SESSION_RESTART_HARD_CAP with a 2-minute backoff between each.
 *
 * The fix: break the loop when the last assistant stop reason is an error AND
 * isRetryableAssistantError() returns false (reusing pi's own classifier so the
 * fail-fast list stays in sync with pi's retryable list).
 *
 * Same mock pattern as run-thinking.test.ts / run-command.test.ts: git/skill
 * side mocked, createAgentSession stubbed so we control the stop reason.
 */

vi.mock("../src/util/paths.js", () => ({
  installSkills: vi.fn().mockResolvedValue(undefined),
  noodleSkillsDir: () => "/tmp/skills",
}));
vi.mock("../src/engine/workspace.js", () => ({
  Workspace: {
    clone: vi.fn().mockResolvedValue({
      path: mkdtempSync(join(tmpdir(), "noodle-bg-test-")),
      branch: vi.fn(),
      branchFrom: vi.fn(),
      checkoutOrReuse: vi.fn(),
      mergeMain: vi.fn().mockResolvedValue({ conflicted: false, files: [] }),
      hasConflictMarkers: vi.fn().mockResolvedValue(false),
      removeInternals: vi.fn(),
      commitAll: vi.fn().mockResolvedValue(false),
      push: vi.fn(),
      changedFiles: vi.fn().mockResolvedValue([]),
      dispose: vi.fn(),
      // tryFetchBranch casts ws to { git: { fetch } } and calls it. Throwing a
      // "not found"-style error makes the run take the "create fresh branch"
      // path — same as a first run on a new schedule.
      git: {
        fetch: async () => {
          throw new Error("couldn't find remote ref");
        },
      },
    }),
  },
  cloneUrlFor: (repo: string, token: string) => `https://${token}@github.com/${repo}`,
}));

// Import AFTER mocks are registered.
const { runBackgroundJob } = await import("../src/engine/background-run.js");

function makeConfig() {
  return NoodleConfigSchema.parse({
    agent_name: "TestBot",
    default_profile: "p",
    profiles: {
      p: {
        provider: "openai",
        model: "gpt-4o-mini",
        base_url: "https://api.openai.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
      },
    },
    routing: [],
  });
}

/** Minimal mock GitHubClient for the background-run output path. */
function mockGh() {
  return {
    defaultBranch: async () => "main",
    findOpenPRByBranch: async () => null,
    ensureLabel: async () => {},
    addIssueLabel: async () => {},
    createIssue: async () => ({ number: 1, html_url: "https://x/issues/1" }),
    createPullRequest: async () => ({ html_url: "https://x/p/1", number: 1 }),
  } as any;
}

/**
 * Builds a createAgentSession stub that resolves every prompt with the given
 * stopReason/errorMessage — and counts how many times prompt() was called so the
 * test can assert the loop did NOT retry.
 */
function errorStopStub(stopReason: string, errorMessage: string): {
  stub: any;
  promptCalls: () => number;
} {
  let promptCalls = 0;
  const stub = vi.fn(() =>
    Promise.resolve({
      session: {
        subscribe: () => {},
        prompt: async () => {
          promptCalls++;
          // No throw — pi resolves gracefully with stopReason=error. The run
          // reads this via lastAssistantStopReason(session).
        },
        dispose: async () => {},
        getSessionStats: () => ({
          // pi counts the errored assistant turn here — this is what the old
          // loop misread as progress.
          tokens: { total: 0 },
          cost: 0,
          toolCalls: 0,
          assistantMessages: promptCalls,
        }),
        // The run inspects the last assistant message's stopReason/errorMessage
        // via lastAssistantStopReason(session), which reads session.messages.
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "go" }],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stopReason,
            errorMessage,
          },
        ],
      },
    }),
  );
  return { stub, promptCalls: () => promptCalls };
}

describe("runBackgroundJob restart loop — fail-fast on non-retryable errors", () => {
  it("stops after one attempt on a 404 (wrong base_url / model name)", async () => {
    const config = makeConfig();
    const { stub, promptCalls } = errorStopStub("error", '404 "Not Found"');

    // The run surfaces the error by throwing after breaking the loop. We assert
    // both: it threw (the error wasn't swallowed) AND it only called prompt()
    // once (did not loop). Without the fix this would loop 4+ times with a
    // 2-minute backoff between each.
    await expect(
      runBackgroundJob(
        config,
        mockGh(),
        {
          repo: "o/r",
          prompt: "find bugs",
          branchName: "noodle/schedule-test",
          displayName: "test",
          runKind: "scheduler",
        },
        {
          authStorage: AuthStorage.create(),
          createAgentSessionFn: stub as any,
          tokenProvider: async () => "fake-token",
        },
      ),
    ).rejects.toThrow(/404/);

    expect(promptCalls()).toBe(1);
  });

  it("stops after one attempt on an auth error (401 / 403)", async () => {
    const config = makeConfig();
    const { stub, promptCalls } = errorStopStub("error", "401 Unauthorized: invalid API key");

    await expect(
      runBackgroundJob(
        config,
        mockGh(),
        {
          repo: "o/r",
          prompt: "find bugs",
          branchName: "noodle/schedule-test",
          displayName: "test",
          runKind: "scheduler",
        },
        {
          authStorage: AuthStorage.create(),
          createAgentSessionFn: stub as any,
          tokenProvider: async () => "fake-token",
        },
      ),
    ).rejects.toThrow(/401/);

    expect(promptCalls()).toBe(1);
  });

  it("stops after one attempt on a quota / billing error", async () => {
    const config = makeConfig();
    const { stub, promptCalls } = errorStopStub("error", "insufficient_quota: you have run out of budget");

    await expect(
      runBackgroundJob(
        config,
        mockGh(),
        {
          repo: "o/r",
          prompt: "find bugs",
          branchName: "noodle/schedule-test",
          displayName: "test",
          runKind: "scheduler",
        },
        {
          authStorage: AuthStorage.create(),
          createAgentSessionFn: stub as any,
          tokenProvider: async () => "fake-token",
        },
      ),
    ).rejects.toThrow(/insufficient_quota/);

    expect(promptCalls()).toBe(1);
  });
});
