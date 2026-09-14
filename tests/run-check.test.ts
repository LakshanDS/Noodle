import { describe, it, expect, vi, afterEach } from "vitest";
import { NoodleConfigSchema } from "../src/config/schema.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunCheck, runCheckName } from "../src/engine/run-check.js";

/**
 * Tests for the live "cooking" check run (App mode only):
 *  1. RunCheck unit behavior — gating, stale sweep, throttling, idempotent
 *     completion — against a stub gh client.
 *  2. runJob integration — the check is created on the target PR's head SHA in
 *     PR mode, skipped for fresh issues (no PR surface), and completed
 *     failure when the agent errors.
 *
 * Heavy deps mocked, mirroring run-pr-mode.test.ts.
 */

// --- unit: stub gh client ---------------------------------------------------

interface GhCall {
  method: string;
  args: Record<string, unknown>;
}

function stubGh(opts: { stale?: Array<{ id: number; externalId: string | null }>; failCreate?: boolean } = {}) {
  const calls: GhCall[] = [];
  let nextId = 100;
  const gh = {
    listInProgressCheckRuns: async (repo: string, ref: string, checkName: string) => {
      calls.push({ method: "list", args: { repo, ref, checkName } });
      return opts.stale ?? [];
    },
    createCheckRun: async (repo: string, o: Record<string, unknown>) => {
      calls.push({ method: "create", args: { repo, ...o } });
      if (opts.failCreate) {
        throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
      }
      return nextId++;
    },
    updateCheckRun: async (repo: string, id: number, o: Record<string, unknown>) => {
      calls.push({ method: "update", args: { repo, id, ...o } });
    },
    completeCheckRun: async (repo: string, id: number, o: Record<string, unknown>) => {
      calls.push({ method: "complete", args: { repo, id, ...o } });
    },
  };
  return { gh: gh as unknown as import("../src/github/client.js").GitHubClient, calls };
}

describe("RunCheck", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is disabled without enabled or a sha to attach to", async () => {
    const { gh, calls } = stubGh();
    expect(
      await RunCheck.start({ gh, repo: "o/r", sha: "abc", jobId: "job-1", agentName: "Noodle", context: "x", enabled: false }),
    ).toBeNull();
    expect(
      await RunCheck.start({ gh, repo: "o/r", sha: null, jobId: "job-1", agentName: "Noodle", context: "x", enabled: true }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("sweeps stale in-progress checks (cancelled) before creating its own", async () => {
    const { gh, calls } = stubGh({ stale: [{ id: 9, externalId: "job-0" }, { id: 8, externalId: null }] });
    const check = await RunCheck.start({
      gh, repo: "o/r", sha: "abc123", jobId: "job-1", agentName: "Noodle", context: "PR #3", enabled: true,
    });
    expect(check).not.toBeNull();
    // Both stale checks were cancelled...
    const cancels = calls.filter((c) => c.method === "complete" && (c.args.conclusion as string) === "cancelled");
    expect(cancels.map((c) => c.args.id).sort()).toEqual([8, 9]);
    // ...and the sweep ran BEFORE the create.
    const lastCancelIdx = calls.map((c) => c.method).lastIndexOf("complete");
    const createIdx = calls.findIndex((c) => c.method === "create");
    expect(lastCancelIdx).toBeLessThan(createIdx);
    const create = calls[createIdx];
    expect(create.args.name).toBe("Noodle is cooking");
    expect(create.args.headSha).toBe("abc123");
    expect(create.args.externalId).toBe("job-1");
    expect(create.args.title).toBe("Run started");
  });

  it("returns null (never throws) when the Checks API rejects the create", async () => {
    const { gh } = stubGh({ failCreate: true });
    const check = await RunCheck.start({
      gh, repo: "o/r", sha: "abc", jobId: "job-1", agentName: "Noodle", context: "x", enabled: true,
    });
    expect(check).toBeNull();
  });

  it("throttles mid-run stage updates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { gh, calls } = stubGh();
    const check = await RunCheck.start({
      gh, repo: "o/r", sha: "abc", jobId: "job-1", agentName: "Noodle", context: "x", enabled: true,
    });
    // Within the 30s window → skipped (only the create call so far).
    vi.setSystemTime(10_000);
    await check!.stage("Agent working…");
    expect(calls.some((c) => c.method === "update")).toBe(false);
    // After the window → goes through.
    vi.setSystemTime(40_000);
    await check!.stage("Agent working…");
    expect(calls.filter((c) => c.method === "update")).toHaveLength(1);
  });

  it("completes exactly once — later calls are no-ops", async () => {
    const { gh, calls } = stubGh();
    const check = await RunCheck.start({
      gh, repo: "o/r", sha: "abc", jobId: "job-1", agentName: "Noodle", context: "x", enabled: true,
    });
    await check!.complete("success", "Opened PR #4", "done");
    await check!.complete("failure", "Run failed");
    await check!.stage("late stage after completion");
    const completes = calls.filter((c) => c.method === "complete" && c.args.conclusion !== "cancelled");
    expect(completes).toHaveLength(1);
    expect(completes[0].args.conclusion).toBe("success");
    expect(calls.some((c) => c.method === "update")).toBe(false);
  });

  it("truncates over-long completion summaries", async () => {
    const { gh, calls } = stubGh();
    const check = await RunCheck.start({
      gh, repo: "o/r", sha: "abc", jobId: "job-1", agentName: "Noodle", context: "x", enabled: true,
    });
    await check!.complete("success", "done", "x".repeat(10_000));
    const summary = calls.find((c) => c.method === "complete")!.args.summary as string;
    expect(summary.length).toBeLessThanOrEqual(4_000);
  });

  it("check name follows the agent name", () => {
    expect(runCheckName("Noodle")).toBe("Noodle is cooking");
  });
});

// --- integration: runJob wires the check to the target PR -------------------

vi.mock("../src/util/paths.js", () => ({
  installSkills: vi.fn().mockResolvedValue(undefined),
  noodleSkillsDir: () => "/tmp/skills",
}));

vi.mock("../src/engine/final-pass.js", () => ({
  phraseOutput: vi.fn(async (m: string) => m),
  generateIssueTitle: vi.fn(async (_m: string, task: string) => `Noodle PR - ${task}`),
}));

vi.mock("../src/engine/workspace.js", () => ({
  Workspace: {
    clone: vi.fn().mockResolvedValue({
      path: mkdtempSync(join(tmpdir(), "noodle-check-")),
      branch: vi.fn(),
      branchFrom: vi.fn(),
      removeInternals: vi.fn(),
      commitAll: vi.fn().mockResolvedValue(true),
      push: vi.fn(),
      changedFiles: vi.fn().mockResolvedValue(["src/foo.ts"]),
      dispose: vi.fn(),
    }),
  },
  cloneUrlFor: (repo: string, token: string) => `https://${token}@github.com/${repo}`,
}));

const { runJob } = await import("../src/engine/run.js");

function makeConfig() {
  return NoodleConfigSchema.parse({
    agent_name: "Noodle",
    default_profile: "p",
    profiles: { p: { provider: "openai", model: "gpt-4o-mini", base_url: "https://api.openai.com/v1", api: "openai-completions", api_key: "sk-test" } },
    routing: [],
  });
}

function mockSessionFn(sessionOverrides: Record<string, unknown> = {}) {
  return vi.fn(() =>
    Promise.resolve({
      session: {
        subscribe: () => {},
        prompt: async () => {},
        dispose: async () => {},
        getSessionStats: () => ({ tokens: { total: 0 }, cost: 0, toolCalls: 0, assistantMessages: 0 }),
        ...sessionOverrides,
      },
    }),
  );
}

/** gh stub covering the issue/PR surface runJob touches, plus check-run recording. */
function makeGh(opts: { isPR: boolean; withOpenPR?: { head_sha?: string }; promptErrorSession?: boolean }) {
  const checkCalls: GhCall[] = [];
  const gh = {
    getIssue: async () => ({
      number: 3, title: "feat: add thing", body: "PR description",
      labels: [], html_url: opts.isPR ? "https://x/pull/3" : "https://x/issues/3",
      pull_request: opts.isPR,
    }),
    getIssueComments: async () => [{ body: "/noodle do it", author: "reviewer" }],
    getPullRequest: async () => ({
      number: 3, title: "feat: add thing", body: "PR description",
      head_branch: "feature/thing", head_sha: "abc123", head_repo: "owner/name",
      base_branch: "main", is_fork: false, html_url: "https://x/pull/3", state: "open",
    }),
    ensureLabel: async () => {},
    addIssueLabel: async () => {},
    removeIssueLabel: async () => {},
    defaultBranch: async () => "main",
    createIssueComment: async () => "https://x#c1",
    findOpenPRForIssue: async () => opts.withOpenPR ?? null,
    createPullRequest: async () => ({ html_url: "https://x/p/99", number: 99 }),
    listInProgressCheckRuns: async () => [],
    createCheckRun: async (_repo: string, o: Record<string, unknown>) => {
      checkCalls.push({ method: "create", args: o });
      return 555;
    },
    updateCheckRun: async (_repo: string, id: number, o: Record<string, unknown>) => {
      checkCalls.push({ method: "update", args: { id, ...o } });
    },
    completeCheckRun: async (_repo: string, id: number, o: Record<string, unknown>) => {
      checkCalls.push({ method: "complete", args: { id, ...o } });
    },
  };
  return { gh: gh as any, checkCalls };
}

describe("runJob check-run integration", () => {
  it("PR mode: creates the check on the PR's head SHA and completes success", async () => {
    const config = makeConfig();
    const { gh, checkCalls } = makeGh({ isPR: true });
    await runJob(config, gh, { repo: "owner/name", issueNumber: 3 }, {
      createAgentSessionFn: mockSessionFn() as any,
      tokenProvider: async () => "fake-token",
      checksEnabled: true,
    });
    const create = checkCalls.find((c) => c.method === "create")!;
    expect(create.args.headSha).toBe("abc123");
    expect(create.args.name).toBe("Noodle is cooking");
    const complete = checkCalls.find((c) => c.method === "complete")!;
    expect(complete.args.conclusion).toBe("success");
    expect(complete.args.title).toContain("Opened PR #99");
  });

  it("issue mode without an open PR: no check run (nothing to attach to)", async () => {
    const config = makeConfig();
    const { gh, checkCalls } = makeGh({ isPR: false });
    await runJob(config, gh, { repo: "owner/name", issueNumber: 3 }, {
      createAgentSessionFn: mockSessionFn() as any,
      tokenProvider: async () => "fake-token",
      checksEnabled: true,
    });
    expect(checkCalls).toEqual([]);
  });

  it("issue mode with an open PR: check attaches to that PR's head SHA", async () => {
    const config = makeConfig();
    const { gh, checkCalls } = makeGh({ isPR: false, withOpenPR: { branch: "noodle/issue-3", number: 7, html_url: "https://x/pull/7", head_sha: "def456" } });
    await runJob(config, gh, { repo: "owner/name", issueNumber: 3 }, {
      createAgentSessionFn: mockSessionFn() as any,
      tokenProvider: async () => "fake-token",
      checksEnabled: true,
    });
    const create = checkCalls.find((c) => c.method === "create")!;
    expect(create.args.headSha).toBe("def456");
    expect(checkCalls.some((c) => c.method === "complete")).toBe(true);
  });

  it("agent error: check completes as failure with the error message", async () => {
    const config = makeConfig();
    const { gh, checkCalls } = makeGh({ isPR: true });
    // pi records an errored turn as the last assistant message; the message
    // text is non-retryable (401) so the restart loop breaks immediately
    // instead of sleeping through its 2-minute backoff. runJob rethrows the
    // error after cleaning up — the check run must already be completed failed.
    await expect(runJob(config, gh, { repo: "owner/name", issueNumber: 3 }, {
      createAgentSessionFn: mockSessionFn({
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 401: unauthorized" }],
      }) as any,
      tokenProvider: async () => "fake-token",
      checksEnabled: true,
    })).rejects.toThrow("401");
    const complete = checkCalls.find((c) => c.method === "complete")!;
    expect(complete.args.conclusion).toBe("failure");
    expect(complete.args.summary).toContain("401");
  });
});
