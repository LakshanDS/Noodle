import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobQueue, QueueWorker } from "../src/server/queue.js";

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
      5,
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
      5,
    );
    const job = queue.enqueue({ repo: "o/r", issueNumber: 1 });

    const stop = setTimeout(() => worker.stop(), 30);
    await worker.run();
    clearTimeout(stop);

    expect(queue.getById(job.id).status).toBe("failed");
    expect(queue.getById(job.id).error).toMatch(/agent exploded/);
  });
});
