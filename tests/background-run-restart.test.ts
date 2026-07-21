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

/**
 * Regression for the SUSTAINED-429 restart loop: when pi resolves with
 * stopReason=error on a RETRYABLE error (429 / rate limit), the fail-fast guard
 * correctly does NOT stop the loop (a single 429 is transient). But pi still
 * counts the errored turn in getSessionStats().assistantMessages, and the old
 * "made progress" reset fired whenever assistantMessages grew — so EVERY 429'd
 * turn reset the restart budget (attempt = -1), looping until the hard cap (9)
 * and then requeuing. A sustained 429 storm could loop for hours.
 *
 * The fix: the budget reset only fires when the last turn was NOT an error
 * (real progress). So a run stuck on 429s burns exactly its 3 restart attempts
 * (4 prompt calls total: 1 initial + 3 restarts) and then fails the job —
 * instead of looping to the hard cap of 9 (10 prompt calls).
 */
describe("runBackgroundJob restart loop — sustained 429 does not loop forever", () => {
  it("stops after SESSION_RESTART_ATTEMPTS+1 attempts on a retryable 429 (no budget reset)", async () => {
    // The restart loop sleeps SESSION_RESTART_DELAY_MS (120s) between attempts.
    // Use fake timers + advanceTimersByTimeAsync to fast-forward those sleeps so
    // the test runs in milliseconds instead of 6 real minutes. Scoped to this
    // test only; restored in finally.
    vi.useFakeTimers();
    try {
      const config = makeConfig();
      // 429 is retryable → fail-fast guard does NOT fire. assistantMessages grows
      // each call (pi counts errored turns) — the old code reset on this.
      const { stub, promptCalls } = errorStopStub(
        "error",
        'Upstream 429: {"status":429,"title":"Too Many Requests"}',
      );

      // Kick off the run (returns a rejecting promise once restarts are exhausted).
      let runError: unknown;
      const runP = runBackgroundJob(
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
      ).catch((e) => { runError = e; });

      // Drive the run to completion by advancing fake time past every 120s
      // restart backoff (SESSION_RESTART_DELAY_MS = 120_000 in background-run.ts).
      // advanceTimersByTimeAsync yields to microtasks between timer flushes, so
      // the run loop progresses through each prompt() → sleep → restart cycle as
      // time advances. Loop until the run settles.
      for (let i = 0; i < 20 && runError === undefined; i++) {
        await vi.advanceTimersByTimeAsync(120_000 + 1000);
      }
      await runP;
      expect(runError).toBeInstanceOf(Error);
      expect((runError as Error).message).toMatch(/429/);

      // 1 initial attempt + 3 restarts = 4 prompt calls. WITHOUT the fix this
      // would be 10 (hard cap 9 + 1) because every errored turn reset the budget.
      // Firmly below the hard-cap count of 10 that the bug produced.
      expect(promptCalls()).toBe(4);
      expect(promptCalls()).toBeLessThan(10);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});

/**
 * Regression for the task-prompt tag-expansion bug: the operator's freeform
 * task text (input.prompt) is author-controlled and may carry {issue}, {pr},
 * {system} tags exactly like the system prompt — but it used to be interpolated
 * raw into buildBackgroundPrompt without going through expandTags. So a task
 * like "skip these: {issue.0}" reached the agent as the literal string
 * "{issue.0}" instead of the issue title/URL.
 *
 * The fix runs input.prompt through expandTags in runBackgroundJob before
 * handing it to buildBackgroundPrompt. This test captures the actual prompt
 * delivered to session.prompt() and asserts the tag was expanded.
 */
describe("runBackgroundJob — task prompt tags are expanded", () => {
  /** Stub that captures the first prompt() argument and resolves cleanly. */
  function capturePromptStub(): { stub: any; captured: () => string } {
    let captured = "";
    const stub = vi.fn(() =>
      Promise.resolve({
        session: {
          subscribe: () => {},
          prompt: async (text: string) => {
            if (!captured) captured = text;
          },
          dispose: async () => {},
          getSessionStats: () => ({
            tokens: { total: 0 },
            cost: 0,
            toolCalls: 0,
            assistantMessages: 1,
          }),
          messages: [
            { role: "user", content: [{ type: "text", text: "go" }] },
            { role: "assistant", content: [{ type: "text", text: "done" }] },
          ],
        },
      }),
    );
    return { stub, captured: () => captured };
  }

/** GitHubClient mock that returns one known open issue for {issue.0}. */
  function mockGhWithIssue() {
    return {
      defaultBranch: async () => "main",
      findOpenPRByBranch: async () => null,
      ensureLabel: async () => {},
      addIssueLabel: async () => {},
      createIssue: async () => ({ number: 1, html_url: "https://x/issues/1" }),
      createPullRequest: async () => ({ html_url: "https://x/p/1", number: 1 }),
      listOpenIssues: async () => [
        { number: 42, title: "Known bug: off-by-one in foo", labels: [], html_url: "https://x/issues/42" },
      ],
      listOpenPRs: async () => [],
    } as any;
  }

  it("expands {issue.0} in the task prompt before sending to the agent", async () => {
    const config = makeConfig();
    const { stub, captured } = capturePromptStub();

    await runBackgroundJob(
      config,
      mockGhWithIssue(),
      {
        repo: "o/r",
        // The operator-authored task references the first known issue by tag.
        prompt: "find new bugs. skip the known one below:\n\n{issue.0}",
        branchName: "noodle/schedule-bug-hunt",
        displayName: "bug-hunt",
        runKind: "scheduler",
      },
      {
        authStorage: AuthStorage.create(),
        createAgentSessionFn: stub as any,
        tokenProvider: async () => "fake-token",
      },
    );

    const prompt = captured();
    // The tag must be replaced with the issue's title/URL — the literal
    // "{issue.0}" must NOT appear in what the agent receives.
    expect(prompt).not.toContain("{issue.0}");
    expect(prompt).toContain("Known bug: off-by-one in foo");
    expect(prompt).toContain("https://x/issues/42");
  });
});
