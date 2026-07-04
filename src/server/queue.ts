import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { log } from "../util/log.js";

/**
 * SQLite-backed job queue. One table, statuses queued/running/done/failed.
 * Dedupe: a (repo, issue) pair can only have one *active* job (queued or
 * running) at a time — re-enqueuing while one is active is a no-op.
 *
 * The worker is a single-consumer loop (concurrency 1) that pulls the oldest
 * queued job and hands it to an injected `runJobFn`. That injection mirrors the
 * existing `createAgentSessionFn` override pattern in `engine/run.ts`, so tests
 * exercise the queue without touching pi or the network.
 */

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface QueuedJob {
  id: number;
  repo: string;
  issue_number: number;
  status: JobStatus;
  /** GitHub App installation id, when available (App mode). */
  installation_id: number | null;
  /** Origin of the job, for logging. */
  source: string;
  attempts: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** What the worker calls to actually run a job. */
export type RunJobFn = (job: QueuedJob) => Promise<void>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  installation_id INTEGER,
  source TEXT NOT NULL DEFAULT 'webhook',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_dedup
  ON jobs(repo, issue_number) WHERE status IN ('queued', 'running');
`;

export class JobQueue {
  private readonly db: Db;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  /** For tests that want to inject an in-memory DB. */
  static fromDb(db: Db): JobQueue {
    const q = Object.create(JobQueue.prototype) as JobQueue;
    (q as unknown as { db: Db }).db = db;
    db.exec(SCHEMA);
    return q;
  }

  /**
   * Enqueue a job. No-op (returns existing) if an active job for this
   * (repo, issue) already exists — the unique partial index enforces this.
   */
  enqueue(opts: {
    repo: string;
    issueNumber: number;
    installationId?: number;
    source?: string;
  }): QueuedJob {
    const { repo, issueNumber, installationId = null, source = "webhook" } = opts;
    // INSERT OR IGNORE relies on the partial unique index over active statuses.
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO jobs (repo, issue_number, installation_id, source)
       VALUES (@repo, @issueNumber, @installationId, @source)`,
    );
    ins.run({ repo, issueNumber, installationId, source });
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE repo = ? AND issue_number = ? AND status IN ('queued','running')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(repo, issueNumber) as QueuedJob | undefined;
    if (!row) throw new Error("enqueue: insert returned no row");
    return row;
  }

  /** Count of jobs in a given status. */
  countByStatus(status: JobStatus): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = ?").get(status) as {
      n: number;
    };
    return row.n;
  }

  /** Peek at the next queued job without claiming it. */
  peekQueued(): QueuedJob | null {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1")
      .get() as QueuedJob | undefined;
    return row ?? null;
  }

  /**
   * Atomically claim the next queued job (→ running) and return it, or null if
   * the queue is empty. Uses a transaction so two workers can't grab the same
   * job (defense for future concurrency > 1).
   */
  claimNext(): QueuedJob | null {
    return this.db.transaction((): QueuedJob | null => {
      const job = this.peekQueued();
      if (!job) return null;
      this.db
        .prepare(
          `UPDATE jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1
           WHERE id = ?`,
        )
        .run(job.id);
      return this.getById(job.id);
    })();
  }

  /** Mark a job successfully done. */
  markDone(id: number): void {
    this.db
      .prepare("UPDATE jobs SET status = 'done', finished_at = datetime('now'), error = NULL WHERE id = ?")
      .run(id);
  }

  /** Mark a job failed with an error message. */
  markFailed(id: number, error: string): void {
    this.db
      .prepare(
        "UPDATE jobs SET status = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?",
      )
      .run(error, id);
  }

  getById(id: number): QueuedJob {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as QueuedJob | undefined;
    if (!row) throw new Error(`job ${id} not found`);
    return row;
  }

  close(): void {
    this.db.close();
  }

  /** The underlying DB handle — shared with the scheduler's scan_state table. */
  getDb(): Db {
    return this.db;
  }
}

/**
 * Single-consumer worker loop. Polls the queue, claims jobs, and runs them via
 * `runJobFn`. Between polls it sleeps `pollIntervalMs`. `stop()` causes the
 * loop to exit after the current job finishes (graceful shutdown).
 */
export class QueueWorker {
  private running = false;
  private currentJob: QueuedJob | null = null;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly queue: JobQueue,
    private readonly runJobFn: RunJobFn,
    private readonly pollIntervalMs: number = 1000,
  ) {
    // Keep the event loop alive while waiting; cleared on stop.
    this.timer = setInterval(() => {}, 1 << 30);
  }

  /** Start the loop. Returns when `stop()` is called. */
  async run(): Promise<void> {
    this.running = true;
    log.info("queue worker started");
    while (this.running) {
      const job = this.queue.claimNext();
      if (!job) {
        await sleep(this.pollIntervalMs);
        continue;
      }
      this.currentJob = job;
      const log_ = log.child({ jobId: job.id, repo: job.repo, issue: job.issue_number });
      log_.info({ source: job.source }, "running job");
      try {
        await this.runJobFn(job);
        this.queue.markDone(job.id);
        log_.info("job done");
      } catch (e) {
        this.queue.markFailed(job.id, (e as Error).message ?? String(e));
        log_.error({ err: e }, "job failed");
      } finally {
        this.currentJob = null;
      }
    }
    clearInterval(this.timer);
    log.info("queue worker stopped");
  }

  /** Request graceful stop. The current job (if any) finishes first. */
  stop(): void {
    this.running = false;
  }

  /** True if a job is currently executing. */
  get isBusy(): boolean {
    return this.currentJob !== null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
