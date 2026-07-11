import type { Database as Db } from "better-sqlite3";
import * as cronParser from "cron-parser";
import { log } from "../util/log.js";

/**
 * DB-backed store for scheduled cron jobs. Each row defines a recurring agent
 * run: a freeform prompt executed on a named branch, whose output is a single
 * new issue (opened by Noodle with the agent's final message as the body).
 *
 * Managed entirely through the web UI (create / edit / enable / delete / run
 * now) — there is no `cron` block in the YAML config. This keeps schedules
 * runtime-editable without redeploying or restarting the server.
 *
 * Mirrors RunStore / JobQueue's pattern: a class over a shared better-sqlite3
 * handle (the same one serve passes around), with `fromDb` for in-memory tests.
 *
 * `next_run_at` is the scheduling watermark. The CronScheduler polls every 60s
 * and enqueues any enabled cron whose `next_run_at <= now`, then advances it to
 * the next fire time computed from the cron expression. It is recomputed on
 * create / update / enable so an edited cron picks up its new schedule without
 * waiting for the prior `next_run_at` to lapse.
 */

export interface CronRow {
  id: number;
  name: string;
  /** "owner/name" — the single repo this cron targets. */
  repo: string;
  /** Freeform instructions the agent receives (its task prompt). */
  prompt: string;
  /** Branch the agent commits to (e.g. "wa-agent"). Reused across runs. */
  branch_name: string;
  /** Standard 5-field cron expression, e.g. "0 0 * * *" = daily at midnight. */
  cron_expression: string;
  /** Resolved profile name, or null for the config's default_profile. */
  profile: string | null;
  enabled: number; // 0 | 1 (SQLite has no native bool)
  /** ISO/SQLite timestamp of the last time this cron was enqueued. */
  last_run_at: string | null;
  /** When this cron should next fire. Set on create + after each run. */
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewCron {
  name: string;
  repo: string;
  prompt: string;
  branch_name: string;
  cron_expression: string;
  profile?: string | null;
  enabled?: number;
}

/**
 * Partial update for a cron job. `cron_expression` is special-cased: when
 * changed, `next_run_at` is recomputed from the new expression (see updateCron).
 * All fields optional.
 */
export type CronUpdate = Partial<
  Pick<NewCron, "name" | "repo" | "prompt" | "branch_name" | "cron_expression" | "profile" | "enabled">
>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cron_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repo TEXT NOT NULL,
  prompt TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  profile TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cron_enabled ON cron_jobs(enabled);
`;

export class CronStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  /** For tests that want to inject an in-memory DB. */
  static fromDb(db: Db): CronStore {
    return new CronStore(db);
  }

  /**
   * Compute the next fire time (as a SQLite-format UTC timestamp) for a cron
   * expression, counting from `from` (default: now). Throws on an invalid
   * expression — callers validate at the API boundary before persisting.
   *
   * cron-parser returns a JS Date; we render it as SQLite's `YYYY-MM-DD HH:MM:SSZ`
   * so it sorts correctly against `datetime('now')` comparisons in listDueCrons.
   */
  static nextRunFromExpr(expr: string, from?: Date): string {
    const opts = from ? { currentDate: from } : {};
    const next = cronParser.CronExpressionParser.parse(expr, opts).next().toDate();
    return sqliteUtc(next);
  }

  /** Create a cron job. `next_run_at` is seeded from the expression. */
  createCron(input: NewCron): CronRow {
    const enabled = input.enabled ?? 1;
    const nextRunAt = enabled ? CronStore.nextRunFromExpr(input.cron_expression) : null;
    this.db
      .prepare(
        `INSERT INTO cron_jobs (name, repo, prompt, branch_name, cron_expression, profile, enabled, next_run_at)
         VALUES (@name, @repo, @prompt, @branch_name, @cron_expression, @profile, @enabled, @next_run_at)`,
      )
      .run({
        name: input.name,
        repo: input.repo,
        prompt: input.prompt,
        branch_name: input.branch_name,
        cron_expression: input.cron_expression,
        profile: input.profile ?? null,
        enabled,
        next_run_at: nextRunAt,
      });
    const id = (this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    return this.getCron(id);
  }

  /**
   * Apply a partial update. When `enabled` flips to 1 and the job had no
   * next_run_at (was disabled), it's recomputed. When `cron_expression`
   * changes, next_run_at is recomputed too.
   */
  updateCron(id: number, update: CronUpdate): CronRow {
    const current = this.getCron(id);
    const cols: string[] = [];
    const params: Record<string, unknown> = { id };

    for (const key of ["name", "repo", "prompt", "branch_name", "cron_expression", "profile"] as const) {
      if (update[key] !== undefined) {
        cols.push(`${key} = @${key}`);
        params[key] = update[key];
      }
    }

    let recomputeNext = false;
    if (update.cron_expression !== undefined && update.cron_expression !== current.cron_expression) {
      recomputeNext = true;
    }
    if (update.enabled !== undefined) {
      cols.push("enabled = @enabled");
      params.enabled = update.enabled;
      // Re-enabling a disabled job (or disabling): recompute next_run so it
      // fires promptly when turned back on / clears the pending fire when off.
      if (update.enabled !== current.enabled) recomputeNext = true;
    }
    if (recomputeNext) {
      const expr = update.cron_expression ?? current.cron_expression;
      const nextRunAt = update.enabled === 0 ? null : CronStore.nextRunFromExpr(expr);
      cols.push("next_run_at = @next_run_at");
      params.next_run_at = nextRunAt;
    }
    if (cols.length === 0) return current;

    cols.push("updated_at = datetime('now')");
    this.db.prepare(`UPDATE cron_jobs SET ${cols.join(", ")} WHERE id = @id`).run(params);
    return this.getCron(id);
  }

  /** Delete a cron job definition. Does not affect already-running jobs. */
  deleteCron(id: number): void {
    this.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
  }

  /** Fetch one cron by id. Throws if missing. */
  getCron(id: number): CronRow {
    const row = this.db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(id) as CronRow | undefined;
    if (!row) throw new Error(`cron ${id} not found`);
    return row;
  }

  /** All cron jobs, newest-first (by id, which is monotonic with creation). */
  listCrons(): CronRow[] {
    return this.db
      .prepare("SELECT * FROM cron_jobs ORDER BY id DESC")
      .all() as CronRow[];
  }

  /**
   * Enabled cron jobs whose `next_run_at` is at or before `now`. The
   * CronScheduler calls this each tick and enqueues every match.
   *
   * `now` is accepted (rather than read inline) so tests can advance a fake
   * clock; production passes `new Date()`.
   */
  listDueCrons(now: Date = new Date()): CronRow[] {
    const ts = sqliteUtc(now);
    return this.db
      .prepare(
        `SELECT * FROM cron_jobs
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC`,
      )
      .all(ts) as CronRow[];
  }

  /**
   * Record that a cron was just enqueued: stamp `last_run_at = now` and advance
   * `next_run_at` to the expression's next fire after now. Called once per due
   * cron, right after a successful enqueue.
   */
  markScheduled(id: number, now: Date = new Date()): void {
    const cron = this.getCron(id);
    const nextRunAt = CronStore.nextRunFromExpr(cron.cron_expression, now);
    this.db
      .prepare(
        `UPDATE cron_jobs SET last_run_at = ?, next_run_at = ?
         WHERE id = ?`,
      )
      .run(sqliteUtc(now), nextRunAt, id);
    log.debug({ cronId: id, nextRunAt, expr: cron.cron_expression }, "cron scheduled for next run");
  }
}

/**
 * Render a Date as a SQLite-format UTC timestamp the same way `datetime('now')`
 * does: `YYYY-MM-DD HH:MM:SS`. We compare `next_run_at` against `datetime('now')`
 * via a string `<=`, so both sides must use this format (ISO-8601 `T`/`Z`
 * separators would sort wrong). UTC so it's independent of the server's locale.
 */
export function sqliteUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}
