import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobQueue } from "../src/server/queue.js";

let dir: string;
let queue: JobQueue;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-qcron-"));
  queue = new JobQueue(join(dir, "test.db"));
});

afterEach(() => {
  queue.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("JobQueue.enqueueCron", () => {
  it("enqueues a cron job with issue_number=0 and the given cron_job_id", () => {
    const job = queue.enqueueCron({ repo: "owner/repo", cronJobId: 5, profile: "glm" });
    expect(job.repo).toBe("owner/repo");
    expect(job.issue_number).toBe(0);
    expect(job.cron_job_id).toBe(5);
    expect(job.status).toBe("queued");
    expect(job.source).toBe("cron");
    expect(job.profile).toBe("glm");
  });

  it("dedupes: a second enqueueCron for the same (repo, cron_job_id) is a no-op", () => {
    queue.enqueueCron({ repo: "owner/repo", cronJobId: 1 });
    queue.enqueueCron({ repo: "owner/repo", cronJobId: 1 });
    expect(queue.countByStatus("queued")).toBe(1);
  });

  it("allows re-enqueue after the previous cron job finishes", () => {
    const j1 = queue.enqueueCron({ repo: "owner/repo", cronJobId: 1 });
    queue.markDone(j1.id);
    queue.enqueueCron({ repo: "owner/repo", cronJobId: 1 });
    expect(queue.countByStatus("queued")).toBe(1);
    expect(queue.countByStatus("done")).toBe(1);
  });

  it("different cron jobs on the same repo run concurrently", () => {
    queue.enqueueCron({ repo: "owner/repo", cronJobId: 1 });
    queue.enqueueCron({ repo: "owner/repo", cronJobId: 2 });
    expect(queue.countByStatus("queued")).toBe(2);
  });

  it("does not collide with a normal issue job for the same repo", () => {
    // A normal job (issue 1) and a cron job (cronJobId 1) on the same repo.
    queue.enqueue({ repo: "owner/repo", issueNumber: 1 });
    queue.enqueueCron({ repo: "owner/repo", cronJobId: 1 });
    expect(queue.countByStatus("queued")).toBe(2);
  });

  it("cron jobs are claimable by the worker", () => {
    queue.enqueueCron({ repo: "owner/repo", cronJobId: 7, profile: "glm" });
    const claimed = queue.claimNext();
    expect(claimed).not.toBeNull();
    expect(claimed!.cron_job_id).toBe(7);
    expect(claimed!.status).toBe("running");
  });

  it("QueuedJob carries cron_job_id=0 for normal issue jobs", () => {
    const job = queue.enqueue({ repo: "owner/repo", issueNumber: 3 });
    expect(job.cron_job_id).toBe(0);
  });
});
