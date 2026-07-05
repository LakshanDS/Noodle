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
