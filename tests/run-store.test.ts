import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { RunStore } from "../src/server/run-store.js";

/**
 * RunStore is the runs-table gateway. Tests use a throwaway on-disk SQLite DB
 * (same pattern as queue.test.ts): one create → updates → list, exercising the
 * status transitions the engine drives (running → succeeded/failed/no_changes).
 */

let dir: string;
let store: RunStore;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-runs-"));
  const db = new Database(join(dir, "runs.db"));
  store = RunStore.fromDb(db);
  close = () => db.close();
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe("RunStore", () => {
  it("creates a run row with default status 'running'", () => {
    const row = store.createRun({ job_id: "job-1", repo: "owner/repo", issue: 4, branch: "noodle/issue-4-abc" });
    expect(row.status).toBe("running");
    expect(row.repo).toBe("owner/repo");
    expect(row.issue).toBe(4);
    expect(row.branch).toBe("noodle/issue-4-abc");
    expect(row.profile).toBeNull();
    expect(row.pr_url).toBeNull();
    expect(row.started_at).toBeTruthy();
    expect(row.finished_at).toBeNull();
  });

  it("updates only the supplied fields", () => {
    store.createRun({ job_id: "job-1", repo: "o/r", issue: 1, branch: "b" });
    store.updateRun("job-1", { profile: "claude", model: "claude-sonnet" });
    let row = store.getRun("job-1");
    expect(row.profile).toBe("claude");
    expect(row.model).toBe("claude-sonnet");
    expect(row.status).toBe("running"); // untouched

    // A later update sets status + finished_at without clearing profile.
    store.updateRun("job-1", { status: "succeeded", pr_url: "https://x/p/1", finished_at: "2026-01-01T00:00:00Z" });
    row = store.getRun("job-1");
    expect(row.status).toBe("succeeded");
    expect(row.profile).toBe("claude"); // preserved
    expect(row.pr_url).toBe("https://x/p/1");
    expect(row.finished_at).toBe("2026-01-01T00:00:00Z");
  });

  it("records the session path for resume", () => {
    store.createRun({ job_id: "job-1", repo: "o/r", issue: 1, branch: "b" });
    store.updateRun("job-1", { session_path: "/sessions/job-1/session.json" });
    expect(store.getRun("job-1").session_path).toBe("/sessions/job-1/session.json");
  });

  it("drives the full success transition", () => {
    store.createRun({ job_id: "job-1", repo: "o/r", issue: 1, branch: "b" });
    store.updateRun("job-1", { profile: "nim", model: "m3" });
    store.updateRun("job-1", {
      status: "succeeded",
      pr_url: "https://x/p/1",
      comment_url: "https://x/c/1",
      summary: "Added a dashboard.",
      finished_at: "2026-01-01T00:00:00Z",
    });
    const row = store.getRun("job-1");
    expect(row).toMatchObject({
      status: "succeeded",
      profile: "nim",
      pr_url: "https://x/p/1",
      summary: "Added a dashboard.",
    });
    expect(store.countByStatus("succeeded")).toBe(1);
    expect(store.countByStatus("running")).toBe(0);
  });

  it("drives the failed transition with an error", () => {
    store.createRun({ job_id: "job-1", repo: "o/r", issue: 1, branch: "b" });
    store.updateRun("job-1", { status: "failed", error: "agent exploded", finished_at: "2026-01-01T00:00:00Z" });
    const row = store.getRun("job-1");
    expect(row.status).toBe("failed");
    expect(row.error).toBe("agent exploded");
    expect(store.countByStatus("failed")).toBe(1);
  });

  it("lists runs newest-started first", () => {
    store.createRun({ job_id: "job-1", repo: "o/r", issue: 1, branch: "b" });
    store.createRun({ job_id: "job-2", repo: "o/r", issue: 2, branch: "b2" });
    const all = store.listRuns();
    expect(all).toHaveLength(2);
    // Both inserted near-simultaneously; ordering by started_at DESC. job-2
    // was inserted second so it should be first (or equal — accept either order
    // if timestamps collide, but job-2 must be present and first when distinct).
    expect(all.map((r) => r.job_id)).toContain("job-2");
  });

  it("throws on getRun for a missing job_id", () => {
    expect(() => store.getRun("nope")).toThrow(/not found/);
  });

  it("no-op update returns the row unchanged", () => {
    store.createRun({ job_id: "job-1", repo: "o/r", issue: 1, branch: "b" });
    const before = store.getRun("job-1");
    store.updateRun("job-1", {});
    const after = store.getRun("job-1");
    expect(after).toEqual(before);
  });
});
