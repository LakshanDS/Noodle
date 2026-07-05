import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { log } from "../util/log.js";

/**
 * SQLite-backed job queue. One table, statuses queued/running/done/failed.
 * Dedupe: a (repo, issue) pair can only have one *active* job (queued or
 * running) at a time — re-enqueuing while one is active is a no-op.
 *
 * Each worker is a single-consumer loop that pulls the oldest claimable queued
 * job and hands it to an injected `runJobFn`. Multiple workers may share one
 * queue (`claimNext` is transactional so two never grab the same job); the pool
 * size is configured via `queue.concurrency`. Injection mirrors the existing
 * `createAgentSessionFn` override pattern in `engine/run.ts`, so tests exercise
 * the queue without touching pi or the network.
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
  /** Earliest time (ISO) this queued job may be claimed (retry backoff). */
  not_before: string | null;
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
  not_before TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_dedup
  ON jobs(repo, issue_number) WHERE status IN ('queued', 'running');
`;

/**
 * Idempotent migration: add `not_before` to pre-existing `jobs` tables (created
 * before the retry feature). SQLite ≥ 3.35 supports `ALTER TABLE ... ADD COLUMN
 ... IF NOT EXISTS`, but older databases attached via older better-sqlite3 don't,
 * so we introspect `PRAGMA table_info` instead — runs once, then no-ops.
 */
function migrateAddNotBefore(db: Db): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "not_before")) {
    db.exec("ALTER TABLE jobs ADD COLUMN not_before TEXT");
  }
}

export class JobQueue {
  private readonly db: Db;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    migrateAddNotBefore(this.db);
  }

  /** For tests that want to inject an in-memory DB. */
  static fromDb(db: Db): JobQueue {
    const q = Object.create(JobQueue.prototype) as JobQueue;
    (q as unknown as { db: Db }).db = db;
    db.exec(SCHEMA);
    migrateAddNotBefore(db);
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

  /** Peek at the next claimable queued job without claiming it. */
  peekQueued(): QueuedJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'queued'
           AND (not_before IS NULL OR not_before <= datetime('now'))
         ORDER BY id ASC LIMIT 1`,
      )
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

  /**
   * Requeue a failed/running job for a later attempt after a backoff delay (in
   * ms). Flips status back to 'queued' and sets `not_before` to
   * `datetime('now', '+N seconds')` (SQLite-native UTC format) so `claimNext`'s
   * string comparison against `datetime('now')` works correctly — ISO-8601
   * strings would sort wrong against SQLite's `YYYY-MM-DD HH:MM:SS` format.
   * The dedupe partial index re-covers the job (status is 'queued' again).
   */
  requeue(id: number, backoffMs: number): void {
    const secs = Math.max(0, Math.round(backoffMs / 1000));
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'queued',
             not_before = datetime('now', '+' || ? || ' seconds'),
             finished_at = NULL,
             started_at = NULL
         WHERE id = ?`,
      )
      .run(secs, id);
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

/** Backoff cap. A single retry never waits longer than this. */
const BACKOFF_CAP_MS = 10 * 60_000;

/** Worker behavior knobs. Defaults match the queue config defaults. */
export interface WorkerOptions {
  /** Poll interval when idle, ms. */
  pollIntervalMs?: number;
  /** Total attempts per job (1 = no retry). */
  maxAttempts?: number;
  /** Base backoff seconds; doubles each attempt, capped at 10 min. */
  retryBackoffSec?: number;
}

/**
 * Decide whether a failed job is worth retrying. Uses a denylist of permanent
 * errors — anything auth/config/not-found is a waste of retries. Everything
 * else (network blips, transient 5xx, OOM kills) gets retried. Note: pi already
 * retries 429s internally with backoff, so what bubbles up here are bigger
 * failures. A StallTimeoutError is also non-retryable: a stalled run would just
 * stall again on the next attempt.
 */
export function isRetryableError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  return !/401|403|unauthor|forbidden|not found|model.*not.*found|config|invalid|StallTimeoutError|stalled/i.test(msg);
}

/**
 * Compute the backoff for `attempt` (1-indexed): base * 2^(attempt-1), capped.
 * attempt=1 → base; attempt=2 → 2*base; attempt=3 → 4*base; …
 */
export function backoffMs(attempt: number, baseSec: number): number {
  const ms = baseSec * 1000 * Math.pow(2, attempt - 1);
  return Math.min(ms, BACKOFF_CAP_MS);
}

/**
 * Worker loop. Polls the queue, claims jobs, and runs them via `runJobFn`.
 * Between polls it sleeps `pollIntervalMs`. `stop()` causes the loop to exit
 * after the current job finishes (graceful shutdown). Multiple workers may
 * share one queue — `claimNext` is transactional so two never grab the same job.
 */
export class QueueWorker {
  private running = false;
  private currentJob: QueuedJob | null = null;
  private readonly timer: NodeJS.Timeout;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffSec: number;

  constructor(
    private readonly queue: JobQueue,
    private readonly runJobFn: RunJobFn,
    opts: WorkerOptions = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.retryBackoffSec = opts.retryBackoffSec ?? 60;
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
      log_.info({ source: job.source, attempt: job.attempts }, "running job");
      try {
        await this.runJobFn(job);
        this.queue.markDone(job.id);
        log_.info("job done");
      } catch (e) {
        const errMsg = (e as Error).message ?? String(e);
        const canRetry = job.attempts < this.maxAttempts && isRetryableError(e);
        if (canRetry) {
          const waitMs = backoffMs(job.attempts, this.retryBackoffSec);
          this.queue.requeue(job.id, waitMs);
          log_.warn(
            { err: errMsg, attempt: job.attempts, maxAttempts: this.maxAttempts, backoffMs: waitMs },
            "job failed — requeueing after backoff",
          );
        } else {
          this.queue.markFailed(job.id, errMsg);
          log_.error({ err: e, attempt: job.attempts, maxAttempts: this.maxAttempts }, "job failed — giving up");
        }
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
