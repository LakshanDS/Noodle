import type { Database as Db } from "better-sqlite3";

/**
 * Persistent record of every agent run — one row per run, keyed by job id.
 * This is the dashboard's source of truth: status, PR, summary, error, and the
 * path to pi's persisted session file (for resume / inspection).
 *
 * The agent's full conversation (messages, tool calls, tool results) does NOT
 * live here — it lives in the session file pi writes to disk. The runs row only
 * holds operational metadata + a pointer to that session. See engine/run.ts.
 *
 * Mirrors JobQueue's pattern: a class over a shared better-sqlite3 handle (the
 * same one serve passes around), with `fromDb` for in-memory tests.
 */

export type RunStatus = "running" | "succeeded" | "failed" | "no_changes";

export interface RunRow {
  job_id: string;
  repo: string;
  /**
   * The source issue number for normal runs; NULL for cron runs (which create
   * issues rather than fixing one). Migrated to nullable for the cron feature.
   */
  issue: number | null;
  branch: string;
  profile: string | null;
  model: string | null;
  status: RunStatus;
  pr_url: string | null;
  comment_url: string | null;
  summary: string | null;
  error: string | null;
  session_path: string | null;
  started_at: string;
  finished_at: string | null;
  /** The scheduler_jobs row that produced this run, or NULL for issue-driven runs. */
  cron_job_id: number | null;
  /** The triggers row that produced this run, or NULL for non-trigger runs. */
  trigger_id: number | null;
  /** URL of an issue a cron/trigger run opened (its output). NULL for normal runs. */
  output_issue_url: string | null;
}

/** Subset needed to create a row (the rest defaults/NULLs at insert time). */
export interface NewRun {
  job_id: string;
  repo: string;
  /** Source issue for normal runs. Omit/leave null for cron runs. */
  issue?: number | null;
  branch: string;
  session_path?: string | null;
  /** Set for cron runs so the dashboard can group runs by their cron. */
  cron_job_id?: number | null;
  /** Set for trigger runs so the dashboard can group runs by their trigger. */
  trigger_id?: number | null;
}

/** Partial update applied by `updateRun` — only set fields are written. */
export type RunUpdate = Partial<
  Pick<
    RunRow,
    | "profile" | "model" | "status" | "pr_url" | "comment_url" | "summary" | "error" | "session_path" | "finished_at" | "output_issue_url"
  >
>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  job_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  issue INTEGER,
  branch TEXT NOT NULL,
  profile TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  pr_url TEXT,
  comment_url TEXT,
  summary TEXT,
  error TEXT,
  session_path TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  cron_job_id INTEGER,
  trigger_id INTEGER,
  output_issue_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
`;

/**
 * The cron_job_id index references a column that doesn't exist on pre-existing
 * `runs` tables, so it can only be created AFTER the migration adds the column.
 * On fresh DBs the column is in the CREATE above; on old DBs the migration adds
 * it first. Same pattern as the queue's `ensureDedupeIndex`.
 */
const IDX_CRON_JOB_ID =
  "CREATE INDEX IF NOT EXISTS idx_runs_cron_job_id ON runs(cron_job_id)";

/**
 * Idempotent migrations for the cron feature. On pre-existing DBs the `runs`
 * table predates these columns; add them so cron runs (which carry no source
 * issue) can store NULL. Same PRAGMA-introspection pattern as the queue migrations.
 *
 * Also relaxes the historical NOT NULL on `issue`: the column was
 * `INTEGER NOT NULL`, but cron runs have no source issue and need to store NULL.
 * SQLite cannot drop a NOT NULL constraint in place (no `ALTER ... DROP NOT NULL`
 * without a full table rebuild), so we rebuild the table to the nullable shape.
 * On a fresh DB the CREATE above already allows NULL, so the rebuild is skipped.
 */
function migrateAddCronColumns(db: Db): void {
  const cols = db.prepare("PRAGMA table_info(runs)").all() as { name: string; notnull: number }[];
  const hasCronJobId = cols.some((c) => c.name === "cron_job_id");
  const hasTriggerId = cols.some((c) => c.name === "trigger_id");
  const hasOutputIssueUrl = cols.some((c) => c.name === "output_issue_url");
  const issueCol = cols.find((c) => c.name === "issue");

  // Fast path: table already has all columns + nullable issue. Nothing to do.
  if (hasCronJobId && hasTriggerId && hasOutputIssueUrl && (!issueCol || issueCol.notnull === 0)) {
    db.exec(IDX_CRON_JOB_ID);
    return;
  }

  // Add the new columns if missing (works on existing tables via ALTER).
  if (!hasCronJobId) db.exec("ALTER TABLE runs ADD COLUMN cron_job_id INTEGER");
  if (!hasTriggerId) db.exec("ALTER TABLE runs ADD COLUMN trigger_id INTEGER");
  if (!hasOutputIssueUrl) db.exec("ALTER TABLE runs ADD COLUMN output_issue_url TEXT");

  // Relax NOT NULL on `issue` via a table rebuild when it's still constrained.
  if (issueCol && issueCol.notnull === 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs_new (
        job_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        issue INTEGER,
        branch TEXT NOT NULL,
        profile TEXT,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        pr_url TEXT,
        comment_url TEXT,
        summary TEXT,
        error TEXT,
        session_path TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        cron_job_id INTEGER,
        trigger_id INTEGER,
        output_issue_url TEXT
      );
      INSERT INTO runs_new (job_id, repo, issue, branch, profile, model, status, pr_url, comment_url, summary, error, session_path, started_at, finished_at, cron_job_id, trigger_id, output_issue_url)
      SELECT job_id, repo, issue, branch, profile, model, status, pr_url, comment_url, summary, error, session_path, started_at, finished_at, cron_job_id, trigger_id, output_issue_url FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_new RENAME TO runs;
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
    `);
  }
  db.exec(IDX_CRON_JOB_ID);
}

export class RunStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    this.db.exec(SCHEMA);
    migrateAddCronColumns(this.db);
  }

  /** For tests that want to inject an in-memory DB. */
  static fromDb(db: Db): RunStore {
    return new RunStore(db);
  }

  /**
   * Insert a new run row (status 'running', started_at = now). Idempotent on
   * job_id: a retried job reuses the same job row (and thus the same job_id),
   * so a retry calls createRun again with the same key. ON CONFLICT resets the
   * row to 'running' and clears the prior attempt's terminal fields instead of
   * throwing a PRIMARY KEY violation — without this every retried job would die
   * at the first DB write.
   */
  createRun(run: NewRun): RunRow {
    this.db
      .prepare(
        `INSERT INTO runs (job_id, repo, issue, branch, session_path, status, cron_job_id)
         VALUES (@job_id, @repo, @issue, @branch, @session_path, 'running', @cron_job_id)
         ON CONFLICT(job_id) DO UPDATE SET
           repo = excluded.repo,
           issue = excluded.issue,
           branch = excluded.branch,
           profile = NULL,
           model = NULL,
           status = 'running',
           pr_url = NULL,
           comment_url = NULL,
           summary = NULL,
           error = NULL,
           session_path = NULL,
           cron_job_id = excluded.cron_job_id,
           output_issue_url = NULL,
           started_at = datetime('now'),
           finished_at = NULL`,
      )
      .run({ session_path: null, cron_job_id: null, ...run });
    return this.getRun(run.job_id);
  }

  /**
   * Apply a partial update. Only the supplied fields are written. Returns the
   * updated row (or throws if the job_id isn't found).
   */
  updateRun(jobId: string, update: RunUpdate): RunRow {
    const cols = Object.keys(update).filter((k) => (update as Record<string, unknown>)[k] !== undefined);
    if (cols.length === 0) return this.getRun(jobId);
    const setClause = cols.map((c) => `${c} = @${c}`).join(", ");
    this.db
      .prepare(`UPDATE runs SET ${setClause} WHERE job_id = @jobId`)
      .run({ ...update, jobId } as Record<string, unknown>);
    return this.getRun(jobId);
  }

  /** Fetch one run by job id. Throws if missing. */
  getRun(jobId: string): RunRow {
    const row = this.db.prepare("SELECT * FROM runs WHERE job_id = ?").get(jobId) as RunRow | undefined;
    if (!row) throw new Error(`run ${jobId} not found`);
    return row;
  }

  /** List runs, newest-started first. `limit` defaults to 50. */
  listRuns(limit = 50): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as RunRow[];
  }

  /** Runs belonging to one cron job, newest-first (for the cron detail view). */
  listRunsForCron(cronJobId: number, limit = 20): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE cron_job_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(cronJobId, limit) as RunRow[];
  }

  /** Runs belonging to one trigger, newest-first (for the trigger detail view). */
  listRunsForTrigger(triggerId: number, limit = 20): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE trigger_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(triggerId, limit) as RunRow[];
  }

  /** Count runs by status (for dashboard stats). */
  countByStatus(status: RunStatus): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = ?").get(status) as { n: number };
    return row.n;
  }
}
