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
}));

vi.mock("simple-git", () => ({
  // Singleton: simpleGit() in static clone and simpleGit(path) in the ctor
  // both resolve to the same spy object so call order is comparable.
  simpleGit: () => spies,
}));

import { Workspace } from "../src/engine/workspace.js";

describe("Workspace.push token refresh", () => {
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
    await ws.push("feature", fresh);

    expect(spies.remote).toHaveBeenCalledWith(["set-url", "origin", fresh]);
    expect(spies.push).toHaveBeenCalledWith("origin", "feature", ["--force-with-lease", "--set-upstream"]);
    // Ordering matters: origin must be re-pointed BEFORE the push fires,
    // otherwise the push still carries the expired token.
    expect(spies.remote.mock.invocationCallOrder[0]).toBeLessThan(
      spies.push.mock.invocationCallOrder[0],
    );
  });

  it("leaves origin untouched when no fresh URL is supplied (legacy/CLI path)", async () => {
    const ws = await Workspace.clone("https://example.com/repo.git", "job-test");
    await ws.push("feature");

    expect(spies.remote).not.toHaveBeenCalled();
    expect(spies.push).toHaveBeenCalledWith("origin", "feature", ["--force-with-lease", "--set-upstream"]);
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

  it("fetches the remote branch, hard-resets to FETCH_HEAD, then checks it out", async () => {
    const ws = await Workspace.clone("https://example.com/repo.git", "job-test");
    const fresh = "https://x-access-token:FRESH-TOKEN@github.com/o/r.git";
    await ws.checkoutOrReuse("noodle/issue-42", fresh);

    // Fetch pulls the single feature ref from the tokenized URL (not origin,
    // which still carries the clone-time token).
    expect(spies.fetch).toHaveBeenCalledWith(fresh, "noodle/issue-42");
    // Reset onto the fetched tip so the agent's work stacks on the previous
    // attempt's commits.
    expect(spies.raw).toHaveBeenCalledWith(["reset", "--hard", "FETCH_HEAD"]);
    expect(spies.checkout).toHaveBeenCalledWith("noodle/issue-42");
    // Ordering: fetch → reset → checkout. Reset before checkout means the
    // working tree already reflects the reused tip when we switch onto it.
    expect(spies.fetch.mock.invocationCallOrder[0]).toBeLessThan(
      spies.raw.mock.invocationCallOrder[0],
    );
    expect(spies.raw.mock.invocationCallOrder[0]).toBeLessThan(
      spies.checkout.mock.invocationCallOrder[0],
    );
  });
});
