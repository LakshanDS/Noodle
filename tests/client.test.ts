import { describe, it, expect } from "vitest";
import { GitHubClient } from "../src/github/client.js";

/**
 * `ensureLabel` is the only client method with non-trivial logic (idempotent
 * create, race tolerance). The other methods are 1:1 REST wrappers, so we test
 * just this one with a stubbed octokit that records the calls.
 */

/** An Error carrying an HTTP-style status code, the way octokit does. */
function httpError(message: string, status: number): Error {
  const e = new Error(message);
  (e as { status: number }).status = status;
  return e;
}

/**
 * Build a stubbed octokit whose rest.issues.* calls are recorded in `calls`,
 * and whose behavior is controlled by the callbacks. Only the methods under
 * test are stubbed; others fall back to a default no-op response.
 */
function makeStub(opts: {
  getLabel?: (name: string) => unknown;
  createLabel?: (params: unknown) => unknown;
  removeLabel?: (params: unknown) => unknown;
  addLabels?: (params: unknown) => unknown;
} = {}) {
  const calls: { method: string; args: unknown }[] = [];
  const getLabel =
    opts.getLabel ?? (() => {
      throw httpError("not found", 404);
    });
  const createLabel = opts.createLabel ?? (() => ({}));
  const removeLabel = opts.removeLabel ?? (() => ({}));
  const addLabels = opts.addLabels ?? (() => ({}));
  const client = new GitHubClient({
    rest: {
      issues: {
        getLabel: async (args: unknown) => {
          calls.push({ method: "getLabel", args });
          return { data: getLabel((args as { name: string }).name) };
        },
        createLabel: async (args: unknown) => {
          calls.push({ method: "createLabel", args });
          return { data: createLabel(args) };
        },
        removeLabel: async (args: unknown) => {
          calls.push({ method: "removeLabel", args });
          return { data: removeLabel(args) };
        },
        addLabels: async (args: unknown) => {
          calls.push({ method: "addLabels", args });
          return { data: addLabels(args) };
        },
      },
    },
  } as unknown as import("octokit").Octokit);
  return { client, calls };
}

describe("GitHubClient.ensureLabel", () => {
  it("creates the label with color + description when it is missing (404)", async () => {
    const { client, calls } = makeStub();
    await client.ensureLabel("owner/repo", "Noodle is cooking", "d4a942", "Noodle agent is working on this");

    expect(calls.map((c) => c.method)).toEqual(["getLabel", "createLabel"]);
    expect(calls[1].args).toMatchObject({
      owner: "owner",
      repo: "repo",
      name: "Noodle is cooking",
      color: "d4a942",
      description: "Noodle agent is working on this",
    });
  });

  it("does nothing when the label already exists", async () => {
    const { client, calls } = makeStub({ getLabel: () => ({ name: "exists", color: "ffffff" }) });
    await client.ensureLabel("owner/repo", "Noodle cooked here", "6fae6f", "Noodle agent run finished");
    expect(calls.map((c) => c.method)).toEqual(["getLabel"]); // no createLabel
  });

  it("creates the failed (red) label when missing", async () => {
    const { client, calls } = makeStub();
    await client.ensureLabel("owner/repo", "Noodle got Cooked", "c76b6b", "Noodle agent run errored out");
    expect(calls.map((c) => c.method)).toEqual(["getLabel", "createLabel"]);
    expect(calls[1].args).toMatchObject({
      owner: "owner",
      repo: "repo",
      name: "Noodle got Cooked",
      color: "c76b6b",
      description: "Noodle agent run errored out",
    });
  });

  it("rethrows non-404 errors from getLabel", async () => {
    const { client } = makeStub({ getLabel: () => { throw httpError("boom", 500); } });
    await expect(client.ensureLabel("owner/repo", "x", "ffffff", "d")).rejects.toThrow("boom");
  });

  it("tolerates a create-after-404 race (422 already exists)", async () => {
    const { client, calls } = makeStub({
      getLabel: () => { throw httpError("not found", 404); },
      createLabel: () => { throw httpError("already exists", 422); },
    });
    // Should not throw — the 422 means another process won the race.
    await client.ensureLabel("owner/repo", "racy", "ffffff", "d");
    expect(calls.map((c) => c.method)).toEqual(["getLabel", "createLabel"]);
  });

  it("rethrows non-422 errors from createLabel", async () => {
    const { client } = makeStub({
      getLabel: () => { throw httpError("not found", 404); },
      createLabel: () => { throw httpError("forbidden", 403); },
    });
    await expect(client.ensureLabel("owner/repo", "x", "ffffff", "d")).rejects.toThrow("forbidden");
  });
});

describe("GitHubClient.removeIssueLabel", () => {
  it("sends the label name (spaces are fine — octokit encodes the path)", async () => {
    const { client, calls } = makeStub();
    await client.removeIssueLabel("owner/repo", 7, "Noodle is cooking");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("removeLabel");
    expect(calls[0].args).toMatchObject({
      owner: "owner",
      repo: "repo",
      issue_number: 7,
      name: "Noodle is cooking",
    });
  });

  it("treats 404 as benign (label already absent from the issue)", async () => {
    const { client, calls } = makeStub({
      removeLabel: () => { throw httpError("not found", 404); },
    });
    // Should NOT throw — 404 means nothing to remove.
    await expect(client.removeIssueLabel("owner/repo", 7, "x")).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("rethrows non-404 errors instead of swallowing them", async () => {
    const { client } = makeStub({
      removeLabel: () => { throw httpError("boom", 500); },
    });
    await expect(client.removeIssueLabel("owner/repo", 7, "x")).rejects.toThrow("boom");
  });
});

describe("GitHubClient.findOpenPRForIssue", () => {
  /** Build a stubbed octokit whose `pulls.list` returns the given PR shapes. */
  function makePrStub(prs: Array<{ head: { ref: string } | null; number: number; html_url: string }>) {
    const calls: { method: string; args: unknown }[] = [];
    const client = new GitHubClient({
      rest: {
        pulls: {
          list: async (args: unknown) => {
            calls.push({ method: "list", args });
            return { data: prs };
          },
        },
      },
    } as unknown as import("octokit").Octokit);
    return { client, calls };
  }

  it("matches the bare first-attempt branch name", async () => {
    const { client, calls } = makePrStub([
      { head: { ref: "main" }, number: 1, html_url: "https://x/p/1" },
      { head: { ref: "noodle/issue-42" }, number: 7, html_url: "https://x/p/7" },
    ]);
    const pr = await client.findOpenPRForIssue("owner/repo", 42, "noodle");
    expect(pr).toEqual({ branch: "noodle/issue-42", number: 7, html_url: "https://x/p/7" });
    expect(calls[0].args).toMatchObject({ owner: "owner", repo: "repo", state: "open", per_page: 100 });
  });

  it("matches a suffixed retry branch (noodle/issue-42-abc123)", async () => {
    const { client } = makePrStub([
      { head: { ref: "noodle/issue-42-k7m2xa" }, number: 9, html_url: "https://x/p/9" },
    ]);
    const pr = await client.findOpenPRForIssue("owner/repo", 42, "noodle");
    expect(pr?.branch).toBe("noodle/issue-42-k7m2xa");
  });

  it("returns null when no open PR matches the issue", async () => {
    const { client } = makePrStub([
      { head: { ref: "noodle/issue-43" }, number: 5, html_url: "https://x/p/5" }, // different issue
      { head: { ref: "feature/x" }, number: 6, html_url: "https://x/p/6" },       // unrelated
    ]);
    const pr = await client.findOpenPRForIssue("owner/repo", 42, "noodle");
    expect(pr).toBeNull();
  });

  it("does not match a different agent's branch for the same issue number", async () => {
    const { client } = makePrStub([
      { head: { ref: "otherbot/issue-42" }, number: 8, html_url: "https://x/p/8" },
    ]);
    const pr = await client.findOpenPRForIssue("owner/repo", 42, "noodle");
    expect(pr).toBeNull();
  });

  it("does not match a leading-substring issue (issue-42 vs issue-423)", async () => {
    const { client } = makePrStub([
      { head: { ref: "noodle/issue-423" }, number: 10, html_url: "https://x/p/10" },
    ]);
    const pr = await client.findOpenPRForIssue("owner/repo", 42, "noodle");
    expect(pr).toBeNull(); // pattern anchors with ($|-), so 423 ≠ 42
  });

  it("returns null for an empty PR list", async () => {
    const { client } = makePrStub([]);
    const pr = await client.findOpenPRForIssue("owner/repo", 42, "noodle");
    expect(pr).toBeNull();
  });
});
