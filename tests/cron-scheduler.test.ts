import { describe, it, expect } from "vitest";
import { runCronTick, type CronSchedulerDeps } from "../src/server/cron-scheduler.js";
import type { CronRow } from "../src/server/cron-store.js";

/**
 * Fake deps for runCronTick — no DB, no network. Tracks what was enqueued and
 * what was markScheduled'd so tests assert on the observable effects.
 */
function makeFakeDeps(over: Partial<{
  due: CronRow[];
  enqueueThrow: Map<number, Error>;
}> = {}): {
  deps: CronSchedulerDeps;
  enqueued: { repo: string; cronJobId: number; profile: string | null }[];
  marked: number[];
} {
  const enqueued: { repo: string; cronJobId: number; profile: string | null }[] = [];
  const marked: number[] = [];
  const enqueueThrow = over.enqueueThrow ?? new Map();
  const deps: CronSchedulerDeps = {
    listDueCrons: () => over.due ?? [],
    enqueueCron: async (repo, cronJobId, _instId, profile) => {
      const err = enqueueThrow.get(cronJobId);
      if (err) throw err;
      enqueued.push({ repo, cronJobId, profile });
    },
    markScheduled: (id) => marked.push(id),
  };
  return { deps, enqueued, marked };
}

const cronRow = (over: Partial<CronRow> = {}): CronRow => ({
  id: 1,
  name: "test",
  repo: "owner/repo",
  prompt: "find bugs",
  branch_name: "wa-agent",
  cron_expression: "0 0 * * *",
  profile: null,
  enabled: 1,
  last_run_at: null,
  next_run_at: "2026-01-01 00:00:00",
  created_at: "2026-01-01 00:00:00",
  updated_at: "2026-01-01 00:00:00",
  ...over,
});

describe("runCronTick", () => {
  it("enqueues nothing when no crons are due", async () => {
    const { deps, enqueued, marked } = makeFakeDeps({ due: [] });
    const n = await runCronTick(deps);
    expect(n).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it("enqueues each due cron and marks it scheduled", async () => {
    const due = [cronRow({ id: 1 }), cronRow({ id: 2, repo: "other/repo" })];
    const { deps, enqueued, marked } = makeFakeDeps({ due });
    const n = await runCronTick(deps);
    expect(n).toBe(2);
    expect(enqueued.map((e) => e.cronJobId)).toEqual([1, 2]);
    expect(marked).toEqual([1, 2]);
  });

  it("passes the cron's profile through to enqueue", async () => {
    const due = [cronRow({ id: 1, profile: "glm" })];
    const { deps, enqueued } = makeFakeDeps({ due });
    await runCronTick(deps);
    expect(enqueued[0].profile).toBe("glm");
  });

  it("passes null profile through when unset", async () => {
    const due = [cronRow({ id: 1, profile: null })];
    const { deps, enqueued } = makeFakeDeps({ due });
    await runCronTick(deps);
    expect(enqueued[0].profile).toBeNull();
  });

  it("continues past a failing cron (one bad cron doesn't abort the tick)", async () => {
    const due = [cronRow({ id: 1 }), cronRow({ id: 2 }), cronRow({ id: 3 })];
    const { deps, enqueued, marked } = makeFakeDeps({
      due,
      enqueueThrow: new Map([[2, new Error("installation not found")]]),
    });
    const n = await runCronTick(deps);
    // Only 2 of 3 enqueued (id 2 threw).
    expect(n).toBe(2);
    expect(enqueued.map((e) => e.cronJobId)).toEqual([1, 3]);
    // The failed cron is NOT marked scheduled (so it retries next tick).
    expect(marked).toEqual([1, 3]);
  });
});
