import { describe, it, expect, vi, beforeEach } from "vitest";
import { NoodleConfigSchema } from "../src/config/schema.js";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for runJob PR mode: when the wake target is a pull request (detected via
 * getIssue's `pull_request` flag), the agent clones the PR's own head branch,
 * makes changes, and force-pushes back to the SAME PR — no new PR is opened.
 *
 * Heavy deps (git/skills) mocked, mirroring run-gate.test.ts.
 */

vi.mock("../src/util/paths.js", () => ({
  installSkills: vi.fn().mockResolvedValue(undefined),
  noodleSkillsDir: () => "/tmp/skills",
}));

// Track the branch name handed to checkoutOrReuse + push so tests can assert
// the PR's head branch was used (not a fresh `<agent>/issue-<n>` branch).
const wsCalls: { checkoutOrReuse?: string; push?: string; pushReuse?: boolean } = {};
vi.mock("../src/engine/workspace.js", () => ({
  Workspace: {
    clone: vi.fn().mockResolvedValue({
      path: mkdtempSync(join(tmpdir(), "noodle-pr-")),
      branch: vi.fn(),
      checkoutOrReuse: vi.fn((branch: string) => { wsCalls.checkoutOrReuse = branch; }),
      removeInternals: vi.fn(),
      // commitAll returns true so the commit/push path (step 8) is exercised.
      commitAll: vi.fn().mockResolvedValue(true),
      push: vi.fn((branch: string, _url: string, reuse?: boolean) => {
        wsCalls.push = branch;
        wsCalls.pushReuse = reuse;
      }),
      changedFiles: vi.fn().mockResolvedValue(["src/foo.ts"]),
      dispose: vi.fn(),
    }),
  },
  cloneUrlFor: (repo: string, token: string) => `https://${token}@github.com/${repo}`,
}));

const { runJob } = await import("../src/engine/run.js");

function makeConfig(profiles = { p: { provider: "openai", model: "gpt-4o-mini", base_url: "https://api.openai.com/v1", api: "openai-completions", api_key: "sk-test" } }) {
  return NoodleConfigSchema.parse({
    agent_name: "Noodle",
    default_profile: "p",
    profiles,
    routing: [],
  });
}

function mockSessionFn() {
  return vi.fn(() =>
    Promise.resolve({
      session: {
        subscribe: () => {},
        prompt: async () => {},
        dispose: async () => {},
        getSessionStats: () => ({ tokens: { total: 0 }, cost: 0, toolCalls: 0, assistantMessages: 0 }),
      },
    }),
  );
}

describe("runJob PR mode", () => {
  beforeEach(() => {
    // The workspace mock captures calls into module-level state; reset between
    // tests so assertions don't see the previous test's branch name.
    delete wsCalls.checkoutOrReuse;
    delete wsCalls.push;
    delete wsCalls.pushReuse;
  });

  it("clones the PR's head branch and pushes back to it (no new PR)", async () => {
    const config = makeConfig();
    let createdPR = false;
    const gh = {
      getIssue: async () => ({
        number: 3, title: "feat: add thing", body: "PR description",
        labels: [], html_url: "https://x/pull/3", pull_request: true,
      }),
      getIssueComments: async () => [{ body: "/noodle change line 302 to rename the string", author: "reviewer" }],
      getPullRequest: async () => ({
        number: 3, title: "feat: add thing", body: "PR description",
        head_branch: "feature/thing", head_repo: "owner/name",
        base_branch: "main", is_fork: false, html_url: "https://x/pull/3", state: "open",
      }),
      ensureLabel: async () => {},
      addIssueLabel: async () => {},
      removeIssueLabel: async () => {},
      defaultBranch: async () => "main",
      createIssueComment: async () => "https://x#c1",
      findOpenPRForIssue: async () => null,
      createPullRequest: async () => { createdPR = true; return { html_url: "https://x/p/3", number: 3 }; },
    } as any;

    const result = await runJob(config, gh, { repo: "owner/name", issueNumber: 3 }, {
      authStorage: AuthStorage.create(),
      createAgentSessionFn: mockSessionFn() as any,
      tokenProvider: async () => "fake-token",
    });

    // The PR's head branch was checked out — NOT a fresh `noodle/issue-3`.
    expect(wsCalls.checkoutOrReuse).toBe("feature/thing");
    // Pushed back to the same PR branch with reuse (force-with-lease).
    expect(wsCalls.push).toBe("feature/thing");
    expect(wsCalls.pushReuse).toBe(true);
    // No new PR was created — the existing PR was updated in place.
    expect(createdPR).toBe(false);
    expect(result.prUrl).toBe("https://x/pull/3");
  });

  it("bails with a comment on a fork PR (can't push to the head repo)", async () => {
    const config = makeConfig();
    let commentPosted = "";
    const gh = {
      getIssue: async () => ({
        number: 5, title: "fix from contributor", body: "",
        labels: [], html_url: "https://x/pull/5", pull_request: true,
      }),
      getIssueComments: async () => [{ body: "/noodle fix the typo", author: "contributor" }],
      getPullRequest: async () => ({
        number: 5, title: "fix from contributor", body: "",
        head_branch: "fix-typo", head_repo: "contributor/name",
        base_branch: "main", is_fork: true, html_url: "https://x/pull/5", state: "open",
      }),
      ensureLabel: async () => {},
      addIssueLabel: async () => {},
      removeIssueLabel: async () => {},
      defaultBranch: async () => "main",
      createIssueComment: async (_r: string, _n: number, body: string) => { commentPosted = body; return "https://x#c1"; },
      findOpenPRForIssue: async () => null,
      createPullRequest: async () => ({ html_url: "https://x/p/5", number: 5 }),
    } as any;

    const result = await runJob(config, gh, { repo: "owner/name", issueNumber: 5 }, {
      authStorage: AuthStorage.create(),
      createAgentSessionFn: mockSessionFn() as any,
      tokenProvider: async () => "fake-token",
    });

    // Returned a clean empty result (no agent run started).
    expect(result.changedFiles).toEqual([]);
    // Posted a notice explaining the fork limitation.
    expect(commentPosted).toContain("can't push to this PR");
    expect(commentPosted).toContain("contributor/name");
  });

  it("issue mode still opens a PR (unchanged behavior)", async () => {
    const config = makeConfig();
    let createdPR = false;
    const gh = {
      getIssue: async () => ({
        number: 9, title: "bug: thing broke", body: "it broke",
        labels: [], html_url: "https://x/issues/9", pull_request: false,
      }),
      getIssueComments: async () => [],
      ensureLabel: async () => {},
      addIssueLabel: async () => {},
      removeIssueLabel: async () => {},
      defaultBranch: async () => "main",
      createIssueComment: async () => "https://x#c1",
      findOpenPRForIssue: async () => null,
      createPullRequest: async () => { createdPR = true; return { html_url: "https://x/p/9", number: 9 }; },
    } as any;

    const result = await runJob(config, gh, { repo: "owner/name", issueNumber: 9 }, {
      authStorage: AuthStorage.create(),
      createAgentSessionFn: mockSessionFn() as any,
      tokenProvider: async () => "fake-token",
    });

    // Issue mode: a fresh branch was created and a new PR was opened.
    expect(wsCalls.checkoutOrReuse).toBeUndefined(); // branch() was used, not checkoutOrReuse
    expect(createdPR).toBe(true);
    expect(result.prUrl).toBe("https://x/p/9");
  });
});
