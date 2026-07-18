import type { Database as Db } from "better-sqlite3";
import { sqliteUtc } from "./scheduler-store.js";

/**
 * DB-backed store for event-driven triggers. Each row defines a GitHub event
 * (issues, pull_request, push, issue_comment) that, when matched by an incoming
 * webhook, enqueues an agent run on a named branch with a freeform prompt.
 *
 * Managed entirely through the web UI (create / edit / enable / delete / run
 * now) — mirrors CronStore's pattern but driven by webhooks instead of timers.
 */

export interface TriggerRow {
  id: number;
  name: string;
  /** "owner/name" — the single repo this trigger targets. */
  repo: string;
  /** GitHub event type: 'issues', 'pull_request', 'push', 'issue_comment'. */
  event_type: string;
  /** Event action filter (e.g. 'opened', 'created'). Null = all actions. */
  event_action: string | null;
  /** Optional branch filter for push events (e.g. 'main'). */
  branch_pattern: string | null;
  /** Freeform instructions the agent receives (its task prompt). */
  prompt: string;
  /** Resolved profile name, or null for the config's default_profile. */
  profile: string | null;
  /** Branch the agent commits to (e.g. "noodle/trigger"). Reused across runs. */
  branch_name: string;
  /** Custom label for the trigger (display-only). */
  label: string | null;
  enabled: number; // 0 | 1 (SQLite has no native bool)
  /** ISO/SQLite timestamp of the last time this trigger was enqueued. */
  last_triggered_at: string | null;
  /** Last run status: 'succeeded', 'failed', 'running'. */
  last_run_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewTrigger {
  name: string;
  repo: string;
  event_type: string;
  event_action?: string | null;
  branch_pattern?: string | null;
  prompt: string;
  profile?: string | null;
  branch_name: string;
  label?: string | null;
  enabled?: number;
}

export type TriggerUpdate = Partial<
  Pick<NewTrigger, "name" | "repo" | "event_type" | "event_action" | "branch_pattern" | "prompt" | "profile" | "branch_name" | "label" | "enabled">
>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repo TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_action TEXT,
  branch_pattern TEXT,
  prompt TEXT NOT NULL,
  profile TEXT,
  branch_name TEXT NOT NULL DEFAULT 'noodle/trigger',
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_triggered_at TEXT,
  last_run_status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_triggers_repo ON triggers(repo, enabled);
`;

export class TriggerStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  /** For tests that want to inject an in-memory DB. */
  static fromDb(db: Db): TriggerStore {
    return new TriggerStore(db);
  }

  createTrigger(input: NewTrigger): TriggerRow {
    const enabled = input.enabled ?? 1;
    this.db
      .prepare(
        `INSERT INTO triggers (name, repo, event_type, event_action, branch_pattern, prompt, profile, branch_name, label, enabled)
         VALUES (@name, @repo, @event_type, @event_action, @branch_pattern, @prompt, @profile, @branch_name, @label, @enabled)`,
      )
      .run({
        name: input.name,
        repo: input.repo,
        event_type: input.event_type,
        event_action: input.event_action ?? null,
        branch_pattern: input.branch_pattern ?? null,
        prompt: input.prompt,
        profile: input.profile ?? null,
        branch_name: input.branch_name,
        label: input.label ?? null,
        enabled,
      });
    const id = (this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    return this.getTrigger(id);
  }

  updateTrigger(id: number, update: TriggerUpdate): TriggerRow {
    const cols: string[] = [];
    const params: Record<string, unknown> = { id };

    for (const key of ["name", "repo", "event_type", "event_action", "branch_pattern", "prompt", "profile", "branch_name", "label"] as const) {
      if (update[key] !== undefined) {
        cols.push(`${key} = @${key}`);
        params[key] = update[key] ?? null;
      }
    }
    if (update.enabled !== undefined) {
      cols.push("enabled = @enabled");
      params.enabled = update.enabled;
    }
    if (cols.length === 0) return this.getTrigger(id);

    cols.push("updated_at = datetime('now')");
    this.db.prepare(`UPDATE triggers SET ${cols.join(", ")} WHERE id = @id`).run(params);
    return this.getTrigger(id);
  }

  deleteTrigger(id: number): void {
    this.db.prepare("DELETE FROM triggers WHERE id = ?").run(id);
  }

  getTrigger(id: number): TriggerRow {
    const row = this.db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as TriggerRow | undefined;
    if (!row) throw new Error(`trigger ${id} not found`);
    return row;
  }

  listTriggers(): TriggerRow[] {
    return this.db
      .prepare("SELECT * FROM triggers ORDER BY id DESC")
      .all() as TriggerRow[];
  }

  /**
   * Find all enabled triggers that match a given repo. The webhook handler
   * calls this on every incoming event to find which triggers should fire.
   */
  listByRepo(repo: string): TriggerRow[] {
    return this.db
      .prepare("SELECT * FROM triggers WHERE repo = ? AND enabled = 1")
      .all(repo) as TriggerRow[];
  }

  /** Record that a trigger just fired. */
  markTriggered(id: number, now: Date = new Date()): void {
    this.db
      .prepare("UPDATE triggers SET last_triggered_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(sqliteUtc(now), id);
  }

  /** Update the last run status for a trigger. */
  updateRunStatus(id: number, status: string): void {
    this.db
      .prepare("UPDATE triggers SET last_run_status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id);
  }
}
