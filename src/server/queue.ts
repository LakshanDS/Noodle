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
  /**
   * Best-effort profile hint captured at enqueue time (from a `#tag` or the
   * default profile). Used to gate per-profile concurrency at claim time. May
   * be corrected by runJob after authoritative profile resolution. Null when
   * no hint was available (treated as "no per-profile cap").
   */
  profile: string | null;
  /**
   * The cron_jobs row that enqueued this job, or 0 for a normal issue-driven
   * job. Cron jobs carry no `issue_number` (they CREATE issues), so the dedupe
   * key was widened to `(repo, issue_number, cron_job_id)` to tell them apart
   * — different crons on the same repo can run concurrently, while a repeat
   * fire of the SAME cron (before its previous run finishes) is still deduped.
   */
  cron_job_id: number;
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
  profile TEXT,
  cron_job_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`;

/**
 * The dedupe index references `cron_job_id`, so it can ONLY be created after the
 * `migrateAddCronJobId` migration has run on pre-existing DBs (the column
 * wouldn't exist yet at SCHEMA time). On fresh DBs the column is in the CREATE
 * above, so this is a clean CREATE. On old DBs the migration adds the column
 * first, then this builds the index. Lives outside SCHEMA for the same reason
 * `IDX_RUNNING_PROFILE` does — see ensureRunningProfileIndex.
 */
const IDX_ACTIVE_DEDUP =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_dedup" +
  " ON jobs(repo, issue_number, cron_job_id) WHERE status IN ('queued', 'running')";

/**
 * Created AFTER migrations so the `profile` column exists on migrated DBs.
 * (Can't live in SCHEMA: that runs first, before the column is added to old
 * tables, and the index creation would fail with "no such column: profile".)
 */
const IDX_RUNNING_PROFILE =
  "CREATE INDEX IF NOT EXISTS idx_jobs_running_profile ON jobs(profile) WHERE status = 'running'";

/**
 * Idempotent migration: add `not_before` to pre-existing `jobs` tables (created
 * before the retry feature). SQLite ≥ 3.35 supports `ALTER TABLE ... ADD COLUMN
 * ... IF NOT EXISTS`, but older databases attached via older better-sqlite3 don't,
 * so we introspect `PRAGMA table_info` instead — runs once, then no-ops.
 */
function migrateAddNotBefore(db: Db): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "not_before")) {
    db.exec("ALTER TABLE jobs ADD COLUMN not_before TEXT");
  }
}

/**
 * Idempotent migration: add `profile` for per-profile concurrency gating. Same
 * PRAGMA-introspection pattern as `migrateAddNotBefore`.
 */
function migrateAddProfile(db: Db): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "profile")) {
    db.exec("ALTER TABLE jobs ADD COLUMN profile TEXT");
  }
}

/**
 * Idempotent migration: add `cron_job_id` so cron-originated jobs can be
 * distinguished from issue-driven ones. Same PRAGMA-introspection pattern.
 */
function migrateAddCronJobId(db: Db): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "cron_job_id")) {
    db.exec("ALTER TABLE jobs ADD COLUMN cron_job_id INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * Ensure the dedupe index exists with the `cron_job_id` column in its key.
 *
 * The original index (pre-cron) was on `(repo, issue_number)`. Cron jobs have
 * no issue_number (they create one), so the key was widened to
 * `(repo, issue_number, cron_job_id)` — each cron dedupes against itself while
 * normal jobs keep deduping on `(repo, issue, 0)`.
 *
 * Runs AFTER the `cron_job_id` migration so the column is guaranteed present.
 * Idempotent: introspects the existing index's SQL; only drops + recreates when
 * it's still the old 2-column shape. On fresh DBs (no index yet) and on
 * already-migrated DBs, it's a plain CREATE IF NOT EXISTS.
 */
function ensureDedupeIndex(db: Db): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_active_dedup'")
    .get() as { sql: string } | undefined;
  const sql = row?.sql ?? "";
  if (sql && !sql.includes("cron_job_id")) {
    // Old 2-column index — drop it so the new 3-column one can replace it.
    db.exec("DROP INDEX IF EXISTS idx_jobs_active_dedup");
  }
  db.exec(IDX_ACTIVE_DEDUP);
}

/**
 * Ensure the per-profile running-count index exists. Runs AFTER migrations so
 * the `profile` column is guaranteed present (created by SCHEMA on fresh DBs,
 * by migrateAddProfile on old ones).
 */
function ensureRunningProfileIndex(db: Db): void {
  db.exec(IDX_RUNNING_PROFILE);
}

export class JobQueue {
  private readonly db: Db;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    migrateAddNotBefore(this.db);
    migrateAddProfile(this.db);
    migrateAddCronJobId(this.db);
    ensureDedupeIndex(this.db);
    ensureRunningProfileIndex(this.db);
  }

  /** For tests that want to inject an in-memory DB. */
  static fromDb(db: Db): JobQueue {
    const q = Object.create(JobQueue.prototype) as JobQueue;
    (q as unknown as { db: Db }).db = db;
    db.exec(SCHEMA);
    migrateAddNotBefore(db);
    migrateAddProfile(db);
    migrateAddCronJobId(db);
    ensureDedupeIndex(db);
    ensureRunningProfileIndex(db);
    return q;
  }

  /**
   * Enqueue a job. No-op (returns existing) if an active job for this
   * (repo, issue) already exists — the unique partial index enforces this.
   * `profile` is a best-effort hint (from a #tag or default) used to gate
   * per-profile concurrency at claim time.
   */
  enqueue(opts: {
    repo: string;
    issueNumber: number;
    installationId?: number;
    source?: string;
    profile?: string | null;
  }): QueuedJob {
    const { repo, issueNumber, installationId = null, source = "webhook", profile = null } = opts;
    // INSERT OR IGNORE relies on the partial unique index over active statuses.
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO jobs (repo, issue_number, installation_id, source, profile)
       VALUES (@repo, @issueNumber, @installationId, @source, @profile)`,
    );
    ins.run({ repo, issueNumber, installationId, source, profile });
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE repo = ? AND issue_number = ? AND status IN ('queued','running')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(repo, issueNumber) as QueuedJob | undefined;
    if (!row) throw new Error("enqueue: insert returned no row");
    return row;
  }

  /**
   * Enqueue a cron-originated job. Cron runs have no issue_number (the agent
   * CREATES issues during the run), so `issue_number = 0` and dedupe is keyed on
   * `(repo, 0, cron_job_id)` instead — each cron job dedupes against itself, so
   * a repeat fire before the prior run finishes is a no-op, while different
   * crons on the same repo run concurrently. `profile` is the cron's configured
   * profile (or default) for per-profile concurrency gating.
   */
  enqueueCron(opts: {
    repo: string;
    cronJobId: number;
    installationId?: number;
    profile?: string | null;
    source?: string;
  }): QueuedJob {
    const { repo, cronJobId, installationId = null, profile = null, source = "cron" } = opts;
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO jobs (repo, issue_number, cron_job_id, installation_id, source, profile)
       VALUES (@repo, 0, @cronJobId, @installationId, @source, @profile)`,
    );
    ins.run({ repo, cronJobId, installationId, source, profile });
    const row = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE repo = ? AND cron_job_id = ? AND status IN ('queued','running')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(repo, cronJobId) as QueuedJob | undefined;
    if (!row) throw new Error("enqueueCron: insert returned no row");
    return row;
  }

  /** Count of jobs in a given status. */
  countByStatus(status: JobStatus): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = ?").get(status) as {
      n: number;
    };
    return row.n;
  }

  /** Number of running jobs whose profile hint matches `profile`. */
  runningCountForProfile(profile: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND profile = ?")
      .get(profile) as { n: number };
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
   * the queue is empty (or no queued job fits its profile's capacity). Uses a
   * transaction so two workers can't grab the same job.
   *
   * `capacityFor(profile)`, when supplied, returns the max concurrent jobs for
   * that profile. A queued job is only claimed if the number of running jobs
   * with the same profile hint is below its cap — this is what lets profiles on
   * separate API keys run in parallel while keeping a single key from being
   * split across N simultaneous runs. Jobs with a null profile hint skip the
   * per-profile check (the global worker pool size still bounds them).
   */
  claimNext(capacityFor?: (profile: string) => number): QueuedJob | null {
    return this.db.transaction((): QueuedJob | null => {
      const candidates = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE status = 'queued'
             AND (not_before IS NULL OR not_before <= datetime('now'))
           ORDER BY id ASC`,
        )
        .all() as QueuedJob[];
      for (const job of candidates) {
        if (job.profile && capacityFor) {
          const cap = capacityFor(job.profile);
          if (this.runningCountForProfile(job.profile) >= cap) continue; // at capacity, try the next
        }
        this.db
          .prepare(
            `UPDATE jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1
             WHERE id = ?`,
          )
          .run(job.id);
        return this.getById(job.id);
      }
      return null;
    })();
  }

  /**
   * Update a job's profile hint. When `capacityFor` is supplied, the UPDATE and
   * a count of currently-running rows for the new profile run inside one
   * SQLite transaction so the per-profile `max_concurrent` cap stays
   * race-safe. If the post-UPDATE running count exceeds the cap, the hint is
   * still committed (so subsequent `claimNext` calls see it and self-gate),
   * and an `Error` is thrown for the caller to handle — `QueueWorker` will
   * requeue with backoff, preserving the cap invariant.
   *
   * Note this closes a TOCTOU window in `claimNext`: null-hint webhook jobs
   * bypass the per-profile check at claim time, but `runJob` resolves the
   * authoritative profile and calls this method BEFORE any LLM traffic. The
   * cap is enforced authoritatively here, after the row is claimed.
   *
   * `capacityFor` is optional for backwards compat; without it the method
   * behaves as a plain UPDATE (used by tests that don't model concurrency).
   */
  setJobProfile(id: number, profile: string, capacityFor?: (profile: string) => number): void {
    if (!capacityFor) {
      this.db.prepare("UPDATE jobs SET profile = ? WHERE id = ?").run(profile, id);
      return;
    }
    const { count } = this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET profile = ? WHERE id = ?").run(profile, id);
      const row = this.db
        .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'running' AND profile = ?")
        .get(profile) as { count: number };
      return row;
    })();
    if (count > capacityFor(profile)) {
      throw new Error(
        `profile "${profile}" at capacity (max_concurrent exceeded while picking up ${id})`,
      );
    }
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
  /**
   * Max concurrent jobs for a profile. When set, `claimNext` skips a queued job
   * whose profile is already at capacity. Injected from config so the queue
   * stays config-agnostic.
   */
  capacityFor?: (profile: string) => number;
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
    this.capacityFor = opts.capacityFor;
    // Keep the event loop alive while waiting; cleared on stop.
    this.timer = setInterval(() => {}, 1 << 30);
  }
  private readonly capacityFor?: (profile: string) => number;

  /** Start the loop. Returns when `stop()` is called. */
  async run(): Promise<void> {
    this.running = true;
    log.info("queue worker started");
    while (this.running) {
      const job = this.queue.claimNext(this.capacityFor);
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
