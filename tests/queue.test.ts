import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobQueue, QueueWorker, isRetryableError, backoffMs } from "../src/server/queue.js";

let dir: string;
let queue: JobQueue;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-queue-"));
  queue = new JobQueue(join(dir, "test.db"));
});

afterEach(() => {
  queue.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("JobQueue", () => {
  it("enqueues a job and reads it back", () => {
    const job = queue.enqueue({ repo: "owner/repo", issueNumber: 1, source: "webhook" });
    expect(job.repo).toBe("owner/repo");
    expect(job.issue_number).toBe(1);
    expect(job.status).toBe("queued");
    expect(job.source).toBe("webhook");
    expect(queue.countByStatus("queued")).toBe(1);
  });

  it("dedupes: a second enqueue for the same active (repo, issue) is a no-op", () => {
    queue.enqueue({ repo: "owner/repo", issueNumber: 1 });
    queue.enqueue({ repo: "owner/repo", issueNumber: 1 });
    expect(queue.countByStatus("queued")).toBe(1);
  });

  it("allows re-enqueue after the previous job finishes", () => {
    const j1 = queue.enqueue({ repo: "owner/repo", issueNumber: 1 });
    queue.markDone(j1.id);
    queue.enqueue({ repo: "owner/repo", issueNumber: 1 });
    expect(queue.countByStatus("queued")).toBe(1);
    expect(queue.countByStatus("done")).toBe(1);
  });

  it("allows different issues in the same repo concurrently", () => {
    queue.enqueue({ repo: "owner/repo", issueNumber: 1 });
    queue.enqueue({ repo: "owner/repo", issueNumber: 2 });
    expect(queue.countByStatus("queued")).toBe(2);
  });

  it("claimNext returns null on an empty queue", () => {
    expect(queue.claimNext()).toBeNull();
  });

  // --- per-profile concurrency gating ----------------------------------------
  it("stores a profile hint on enqueue", () => {
    const job = queue.enqueue({ repo: "o/r", issueNumber: 1, profile: "claude" });
    expect(job.profile).toBe("claude");
  });

  it("defaults profile to null when not supplied", () => {
    const job = queue.enqueue({ repo: "o/r", issueNumber: 1 });
    expect(job.profile).toBeNull();
  });

  it("runningCountForProfile counts only matching running jobs", () => {
    const a = queue.enqueue({ repo: "o/r", issueNumber: 1, profile: "claude" });
    const b = queue.enqueue({ repo: "o/r", issueNumber: 2, profile: "nim" });
    queue.claimNext(); // claims a (oldest)
    expect(queue.runningCountForProfile("claude")).toBe(1);
    expect(queue.runningCountForProfile("nim")).toBe(0);
    void a; void b;
  });

  it("claimNext skips a job whose profile is at capacity and takes the next", () => {
    // Two queued claude jobs + one queued nim job. capacityFor caps claude at 1.
    queue.enqueue({ repo: "o/r", issueNumber: 1, profile: "claude" });
    queue.enqueue({ repo: "o/r", issueNumber: 2, profile: "nim" });
    queue.enqueue({ repo: "o/r", issueNumber: 3, profile: "claude" });
    const cap = (p: string) => (p === "claude" ? 1 : 99);

    // First claim: claude #1 → running (claude now at capacity 1/1).
    const first = queue.claimNext(cap);
    expect(first?.issue_number).toBe(1);
    // Second claim: claude #3 is at capacity, so it skips to nim #2.
    const second = queue.claimNext(cap);
    expect(second?.issue_number).toBe(2);
    // Third claim: claude #3 still at capacity (claude #1 still running) → null.
    expect(queue.claimNext(cap)).toBeNull();
    // Once claude #1 finishes, claude #3 becomes claimable.
    queue.markDone(first!.id);
    const third = queue.claimNext(cap);
    expect(third?.issue_number).toBe(3);
  });

  it("claimNext without capacityFor ignores per-profile limits (back-compat)", () => {
    queue.enqueue({ repo: "o/r", issueNumber: 1, profile: "claude" });
    queue.enqueue({ repo: "o/r", issueNumber: 2, profile: "claude" });
    // No capacityFor → both claimable in age order, no gating.
    expect(queue.claimNext()?.issue_number).toBe(1);
    expect(queue.claimNext()?.issue_number).toBe(2);
  });

  it("setJobProfile updates a job's profile hint", () => {
    const job = queue.enqueue({ repo: "o/r", issueNumber: 1, profile: "claude" });
    queue.setJobProfile(job.id, "nim");
    expect(queue.getById(job.id).profile).toBe("nim");
  });

  it("migrates an existing DB adding the profile column", () => {
    // Simulate an old DB created before the profile column existed.
    queue.close();
    const dbPath = join(dir, "test.db");
    const Database = require("better-sqlite3");
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE jobs_old (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, issue_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', installation_id INTEGER, source TEXT NOT NULL DEFAULT 'webhook',
      attempts INTEGER NOT NULL DEFAULT 0, error TEXT, not_before TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT)`);
    raw.exec(`INSERT INTO jobs_old (repo, issue_number) VALUES ('o/r', 1)`);
    // SQLite table must be named `jobs` for the queue — drop the new one and rename.
    raw.exec(`DROP TABLE jobs; ALTER TABLE jobs_old RENAME TO jobs;`);
    raw.close();
    // Re-open: the constructor's migration should add `profile`.
    queue = new JobQueue(dbPath);
    const job = queue.enqueue({ repo: "o/r", issueNumber: 1 });
    expect(job.profile).toBeNull(); // profile column exists, defaults null
    // And the running-profile index is usable.
    queue.claimNext();
    expect(queue.runningCountForProfile("anything")).toBe(0);
  });

  it("claimNext moves the oldest queued job to running", () => {
    const j1 = queue.enqueue({ repo: "owner/repo", issueNumber: 1 });
    queue.enqueue({ repo: "owner/repo", issueNumber: 2 });
    const claimed = queue.claimNext();
    expect(claimed?.id).toBe(j1.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    // second claim gets the next one
    const claimed2 = queue.claimNext();
    expect(claimed2?.issue_number).toBe(2);
    expect(queue.claimNext()).toBeNull();
  });

  it("markFailed records the error and flips status", () => {
    const job = queue.enqueue({ repo: "o/r", issueNumber: 1 });
    const claimed = queue.claimNext()!;
    queue.markFailed(claimed.id, "boom");
    const after = queue.getById(job.id);
    expect(after.status).toBe("failed");
    expect(after.error).toBe("boom");
    expect(after.finished_at).toBeTruthy();
  });

  it("carries the installation id through to the row", () => {
    const job = queue.enqueue({ repo: "o/r", issueNumber: 1, installationId: 99 });
    expect(job.installation_id).toBe(99);
  });
});

describe("QueueWorker", () => {
  it("runs enqueued jobs through the injected runJobFn and marks them done", async () => {
    const seen: number[] = [];
    const worker = new QueueWorker(
      queue,
      async (job) => {
        seen.push(job.issue_number);
      },
      { pollIntervalMs: 5 },
    );
    queue.enqueue({ repo: "o/r", issueNumber: 10 });
    queue.enqueue({ repo: "o/r", issueNumber: 11 });

    // Give the worker time to drain both, then stop.
    const stop = setTimeout(() => worker.stop(), 30);
    await worker.run();
    clearTimeout(stop);

    expect(seen).toEqual([10, 11]);
    expect(queue.countByStatus("done")).toBe(2);
  });

  it("marks a job failed when runJobFn throws", async () => {
    const worker = new QueueWorker(
      queue,
      async () => {
        throw new Error("agent exploded");
      },
      { pollIntervalMs: 5, maxAttempts: 1 },
    );
    const job = queue.enqueue({ repo: "o/r", issueNumber: 1 });

    const stop = setTimeout(() => worker.stop(), 30);
    await worker.run();
    clearTimeout(stop);

    expect(queue.getById(job.id).status).toBe("failed");
    expect(queue.getById(job.id).error).toMatch(/agent exploded/);
  });
});

describe("requeue + not_before", () => {
  it("requeue flips status to queued and sets not_before", () => {
    const job = queue.enqueue({ repo: "o/r", issueNumber: 1 });
    const claimed = queue.claimNext()!;
    expect(claimed.status).toBe("running");

    queue.requeue(claimed.id, 60_000); // 60s backoff

    const after = queue.getById(job.id);
    expect(after.status).toBe("queued");
    expect(after.not_before).toBeTruthy();
    expect(after.finished_at).toBeNull();
  });

  it("claimNext skips a queued job whose not_before is in the future", () => {
    const job = queue.enqueue({ repo: "o/r", issueNumber: 1 });
    queue.requeue(job.id, 60_000); // 60s backoff → not claimable yet
    expect(queue.claimNext()).toBeNull();
  });

  it("claimNext claims a queued job whose not_before has passed", () => {
    const job = queue.enqueue({ repo: "o/r", issueNumber: 1 });
    queue.requeue(job.id, 0); // 0s backoff → immediately claimable
    const claimed = queue.claimNext();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("running");
  });
});

describe("QueueWorker retry", () => {
  it("requeues a retryable failure with a future not_before (backoff applied)", async () => {
    let attempts = 0;
    const worker = new QueueWorker(
      queue,
      async () => {
        attempts++;
        throw new Error("transient network blip"); // retryable
      },
      { pollIntervalMs: 5, maxAttempts: 3, retryBackoffSec: 60 },
    );
    const job = queue.enqueue({ repo: "o/r", issueNumber: 1 });

    // Stop quickly — after the first attempt fails and is requeued, but before
    // the 60s backoff elapses, so no second attempt happens.
    const stop = setTimeout(() => worker.stop(), 50);
    await worker.run();
    clearTimeout(stop);

    expect(attempts).toBe(1);
    const after = queue.getById(job.id);
    expect(after.status).toBe("queued");
    expect(after.attempts).toBe(1);
    // not_before is set (SQLite native format) and ~60s in the future. Compare
    // by re-parsing through SQLite so the format difference doesn't matter.
    const remaining = queue.getDb().prepare(
      "SELECT (julianday(not_before) - julianday('now')) * 86400 AS secs FROM jobs WHERE id = ?",
    ).get(after.id) as { secs: number };
    expect(remaining.secs).toBeGreaterThan(50); // ~60s backoff still pending
  });

  it("eventually succeeds after a retryable failure once runJobFn stops failing", async () => {
    let attempts = 0;
    const worker = new QueueWorker(
      queue,
      async () => {
        attempts++;
        if (attempts < 2) throw new Error("transient network blip");
        // attempt 2 succeeds
      },
      // Smallest valid backoff (1s) so the second attempt is claimable quickly.
      { pollIntervalMs: 5, maxAttempts: 3, retryBackoffSec: 1 },
    );
    const job = queue.enqueue({ repo: "o/r", issueNumber: 1 });

    const stop = setTimeout(() => worker.stop(), 2000);
    await worker.run();
    clearTimeout(stop);

    expect(attempts).toBe(2);
    expect(queue.getById(job.id).status).toBe("done");
  });

  it("does not retry a permanent (non-retryable) error", async () => {
    const calls: number[] = [];
    const worker = new QueueWorker(
      queue,
      async (job) => {
        calls.push(job.attempts);
        throw new Error("401 Unauthorized: bad token");
      },
      { pollIntervalMs: 5, maxAttempts: 3, retryBackoffSec: 1 },
    );
    const job = queue.enqueue({ repo: "o/r", issueNumber: 1 });

    const stop = setTimeout(() => worker.stop(), 50);
    await worker.run();
    clearTimeout(stop);

    expect(calls).toEqual([1]); // single attempt, no retry
    expect(queue.getById(job.id).status).toBe("failed");
  });
});

describe("isRetryableError + backoffMs", () => {
  it("treats auth/config/not-found errors as non-retryable", () => {
    expect(isRetryableError(new Error("401 Unauthorized"))).toBe(false);
    expect(isRetryableError(new Error("403 Forbidden"))).toBe(false);
    expect(isRetryableError(new Error("model claude-foo not found"))).toBe(false);
    expect(isRetryableError(new Error("invalid config: missing profile"))).toBe(false);
    expect(isRetryableError(new Error("agent run stalled: no activity"))).toBe(false);
  });

  it("treats network/server errors as retryable", () => {
    expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isRetryableError(new Error("500 Internal Server Error"))).toBe(true);
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
  });

  it("doubles backoff each attempt, capped at 10 min", () => {
    expect(backoffMs(1, 60)).toBe(60_000);
    expect(backoffMs(2, 60)).toBe(120_000);
    expect(backoffMs(3, 60)).toBe(240_000);
    expect(backoffMs(10, 60)).toBe(600_000); // cap
  });
});
