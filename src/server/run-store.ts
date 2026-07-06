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
  issue: number;
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
}

/** Subset needed to create a row (the rest defaults/NULLs at insert time). */
export interface NewRun {
  job_id: string;
  repo: string;
  issue: number;
  branch: string;
  session_path?: string | null;
}

/** Partial update applied by `updateRun` — only set fields are written. */
export type RunUpdate = Partial<
  Pick<
    RunRow,
    | "profile" | "model" | "status" | "pr_url" | "comment_url" | "summary" | "error" | "session_path" | "finished_at"
  >
>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  job_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  issue INTEGER NOT NULL,
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
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
`;

export class RunStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    this.db.exec(SCHEMA);
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
        `INSERT INTO runs (job_id, repo, issue, branch, session_path, status)
         VALUES (@job_id, @repo, @issue, @branch, @session_path, 'running')
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
           started_at = datetime('now'),
           finished_at = NULL`,
      )
      .run({ session_path: null, ...run });
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

  /** Count runs by status (for dashboard stats). */
  countByStatus(status: RunStatus): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = ?").get(status) as { n: number };
    return row.n;
  }
}
