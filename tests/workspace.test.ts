import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Workspace is exercised end-to-end only via runJob, which is too heavy to
 * stand up in a unit test (needs config + model registry + pi session). Mock
 * simple-git and assert push re-points origin before pushing — the actual fix
 * for the "2h agent run pushes with an expired 1h token" bug.
 */
const spies = vi.hoisted(() => ({
  clone: vi.fn(),
  remote: vi.fn(),
  push: vi.fn(),
  checkoutLocalBranch: vi.fn(),
  add: vi.fn(),
  status: vi.fn(),
  commit: vi.fn(),
  diff: vi.fn(),
  fetch: vi.fn(),
  raw: vi.fn(),
  checkout: vi.fn(),
  merge: vi.fn(),
}));

vi.mock("simple-git", () => ({
  // Singleton: simpleGit() in static clone and simpleGit(path) in the ctor
  // both resolve to the same spy object so call order is comparable.
  simpleGit: () => spies,
}));

import { Workspace } from "../src/engine/workspace.js";

describe("Workspace.push token refresh + push mode", () => {
  beforeEach(() => {
    Object.values(spies).forEach((s) => s.mockReset());
    spies.clone.mockResolvedValue(undefined);
    spies.remote.mockResolvedValue(undefined);
    spies.push.mockResolvedValue(undefined);
    spies.fetch.mockResolvedValue(undefined);
    spies.raw.mockResolvedValue(undefined);
    spies.checkout.mockResolvedValue(undefined);
  });

  it("re-points origin to the fresh clone URL before pushing", async () => {
    const ws = await Workspace.clone("https://example.com/repo.git", "job-test");
    const fresh = "https://x-access-token:FRESH-TOKEN@github.com/o/r.git";
    await ws.push("feature", fresh, true);

    expect(spies.remote).toHaveBeenCalledWith(["set-url", "origin", fresh]);
    expect(spies.push).toHaveBeenCalledWith("origin", "feature", ["--force-with-lease", "--set-upstream"]);
    // Ordering matters: origin must be re-pointed BEFORE the push fires,
    // otherwise the push still carries the expired token.
    expect(spies.remote.mock.invocationCallOrder[0]).toBeLessThan(
      spies.push.mock.invocationCallOrder[0],
    );
  });

  it("uses plain push for a fresh branch (no remote-tracking ref to lease against)", async () => {
    const ws = await Workspace.clone("https://example.com/repo.git", "job-test");
    const fresh = "https://x-access-token:FRESH-TOKEN@github.com/o/r.git";
    await ws.push("feature", fresh, false);

    expect(spies.push).toHaveBeenCalledWith("origin", "feature", ["--set-upstream"]);
    expect(spies.push).not.toHaveBeenCalledWith(
      "origin", "feature", ["--force-with-lease", "--set-upstream"],
    );
  });

  it("leaves origin untouched when no fresh URL is supplied (legacy/CLI path)", async () => {
    const ws = await Workspace.clone("https://example.com/repo.git", "job-test");
    await ws.push("feature");

    expect(spies.remote).not.toHaveBeenCalled();
    // Default reuse=false → plain push.
    expect(spies.push).toHaveBeenCalledWith("origin", "feature", ["--set-upstream"]);
  });
});

describe("Workspace.checkoutOrReuse", () => {
  beforeEach(() => {
    Object.values(spies).forEach((s) => s.mockReset());
    spies.clone.mockResolvedValue(undefined);
    spies.fetch.mockResolvedValue(undefined);
    spies.raw.mockResolvedValue(undefined);
    spies.checkout.mockResolvedValue(undefined);
  });

  it("fetches the remote branch, then checks out -B at FETCH_HEAD", async () => {
    const ws = await Workspace.clone("https://example.com/repo.git", "job-test");
    const fresh = "https://x-access-token:FRESH-TOKEN@github.com/o/r.git";
    await ws.checkoutOrReuse("noodle/issue-42", fresh);

    // Fetch pulls the single feature ref from the tokenized URL (not origin,
    // which still carries the clone-time token). Fetching from a raw URL only
    // sets FETCH_HEAD — no refs/remotes/origin/<name> tracking ref.
    expect(spies.fetch).toHaveBeenCalledWith(fresh, "noodle/issue-42");
    // checkout -B creates/resets the local branch at FETCH_HEAD in one step.
    // The old sequence (reset --hard FETCH_HEAD; checkout name) left HEAD
    // detached with no local branch, so the checkout failed with
    // "pathspec did not match".
    expect(spies.checkout).toHaveBeenCalledWith(["-B", "noodle/issue-42", "FETCH_HEAD"]);
    // Ordering: fetch → checkout. No raw reset anymore.
    expect(spies.fetch.mock.invocationCallOrder[0]).toBeLessThan(
      spies.checkout.mock.invocationCallOrder[0],
    );
    expect(spies.raw).not.toHaveBeenCalled();
  });
});

describe("Workspace.mergeMain", () => {
  beforeEach(() => {
    Object.values(spies).forEach((s) => s.mockReset());
    spies.clone.mockResolvedValue(undefined);
    spies.remote.mockResolvedValue(undefined);
    spies.fetch.mockResolvedValue(undefined);
    spies.merge.mockResolvedValue(undefined);
  });

  it("fetches the base branch and merges origin/<base> (single token, not two args)", async () => {
    const ws = await Workspace.clone("https://example.com/repo.git", "job-test");
    const fresh = "https://x-access-token:FRESH@github.com/o/r.git";
    const r = await ws.mergeMain("main", fresh);

    // Re-point origin to the fresh URL before fetching (token refresh).
    expect(spies.remote).toHaveBeenCalledWith(["set-url", "origin", fresh]);
    expect(spies.fetch).toHaveBeenCalledWith("origin", "main");
    // CRITICAL: the ref must be a single `origin/main` token, NOT two args.
    // `git merge origin main` would be misread as merging two unrelated refs
    // (this bug was caught while building the scheduler trunk-sync flow).
    expect(spies.merge).toHaveBeenCalledWith(["origin/main"]);
    expect(r).toEqual({ conflicted: false, files: [] });
  });

  it("detects conflicts when simple-git rejects with err.git.conflicts", async () => {
    const ws = await Workspace.clone("https://example.com/repo.git", "job-test");
    // simple-git REJECTS the merge promise when git exits non-zero with
    // conflicts; the conflict list lives on err.git.conflicts as [{file,reason}].
    spies.merge.mockRejectedValue({
      message: "CONFLICTS: f.txt:content",
      git: { conflicts: [{ file: "f.txt", reason: "content" }] },
    });
    const r = await ws.mergeMain("main");
    expect(r).toEqual({ conflicted: true, files: ["f.txt"] });
  });

  it("re-throws non-conflict errors (network/auth) instead of swallowing them", async () => {
    const ws = await Workspace.clone("https://example.com/repo.git", "job-test");
    spies.merge.mockRejectedValue(new Error("fatal: unable to access 'https://...': Could not resolve host"));
    await expect(ws.mergeMain("main")).rejects.toThrow(/Could not resolve host/);
  });
});

describe("Workspace.hasConflictMarkers + abortMerge", () => {
  beforeEach(() => {
    Object.values(spies).forEach((s) => s.mockReset());
    spies.clone.mockResolvedValue(undefined);
    spies.merge.mockResolvedValue(undefined);
  });

  it("returns true when git status reports conflicted paths", async () => {
    const ws = await Workspace.clone("https://example.com/repo.git", "job-test");
    spies.status.mockResolvedValue({ conflicted: ["src/a.ts", "src/b.ts"] });
    expect(await ws.hasConflictMarkers()).toBe(true);
  });

  it("returns false when conflicted list is empty", async () => {
    const ws = await Workspace.clone("https://example.com/repo.git", "job-test");
    spies.status.mockResolvedValue({ conflicted: [] });
    expect(await ws.hasConflictMarkers()).toBe(false);
  });

  it("forwards to git merge --abort", async () => {
    const ws = await Workspace.clone("https://example.com/repo.git", "job-test");
    await ws.abortMerge();
    expect(spies.merge).toHaveBeenCalledWith(["--abort"]);
  });
});

/**
 * Regression test for the production cron/trigger bug: `tryFetchBranch`'s
 * "branch does not exist" detector must match git's actual error message
 * (`fatal: couldn't find remote ref <name>`). The original regex
 * `/ fatal:/i` required a LEADING SPACE before `fatal:`, which git does NOT
 * emit — so every first cron run on a fresh branch failed all 5 retries.
 *
 * This test documents the exact regex used by scheduler-run.ts:493 and
 * trigger-run.ts:495 so a future edit can't silently re-break it. It mirrors
 * the inline pattern rather than importing the private function (the function
 * also does git I/O, which is covered by the workspace tests above).
 */
describe("tryFetchBranch 'branch not found' regex (production cron bug regression)", () => {
  // MUST stay byte-identical to the regex in scheduler-run.ts:493 and
  // trigger-run.ts:495. If either changes, update both call sites + this test.
  // Note: we deliberately do NOT use a bare `fatal:` alternative — git's
  // network errors also start with `fatal:` (e.g. "fatal: unable to access"),
  // and matching those would silently treat a network blip as "branch missing"
  // and break the timeline. The `fatal:.*remote ref` form only matches the
  // actual missing-ref error.
  const BRANCH_NOT_FOUND_RE = /not found|doesn't exist|couldn't find|could not find|does not exist|fatal:.*remote ref/i;

  it.each([
    ["fatal: couldn't find remote ref noodle/master", "git's actual missing-branch error (the production case)"],
    ["fatal: couldn't find remote ref noodle/schedules", "the schedule branch from the production logs"],
    ["fatal: could not find remote ref foo", "long-form 'could not find'"],
    ["error: branch 'foo' not found", "alternative 'not found' phrasing"],
    ["refs/heads/foo does not exist", "'does not exist' phrasing"],
  ])("matches %s (%s)", (msg) => {
    expect(BRANCH_NOT_FOUND_RE.test(msg)).toBe(true);
  });

  it.each([
    ["fatal: unable to access 'https://...': Could not resolve host", "network error — must re-throw, not treat as missing branch"],
    ["error: pathspec 'foo' did not match any file(s) known to git", "pathspec error — unrelated to branch existence"],
    ["remote: Invalid username or token", "auth error — must surface, not silently create a fresh branch"],
  ])("does NOT match %s (%s)", (msg) => {
    expect(BRANCH_NOT_FOUND_RE.test(msg)).toBe(false);
  });
});
