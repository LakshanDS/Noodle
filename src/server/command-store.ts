import type { Database as Db } from "better-sqlite3";
import { defaultCommandPrompt } from "../engine/prompt.js";
import { slugify } from "../util/slugify.js";

/**
 * DB-backed store for slash commands. A command is a named wake trigger
 * (`/<trigger>` in a GitHub issue/comment) that, when matched, supplies the
 * agent's framing prompt and an optional profile override.
 *
 * The built-in `/<agent>` command (e.g. `/noodle`) is seeded on boot with
 * `is_builtin = 1` and cannot be deleted — it is the default fix workflow.
 * User commands (`/question`, `/review`, …) are managed through the web UI.
 *
 * Mirrors CronStore's pattern: a class over a shared better-sqlite3 handle
 * (the same one serve passes around), with `fromDb` for in-memory tests.
 *
 * Triggers are stored WITHOUT the leading slash and are case-insensitive
 * (normalised to lowercase) + unique.
 */

export interface CommandRow {
  id: number;
  /** Trigger word without the leading slash, e.g. "question". Lowercase. */
  trigger: string;
  name: string;
  description: string;
  /** Framing prompt the agent receives (wraps the issue context block). */
  system_prompt: string;
  /** Resolved profile name, or null to use the routed/default profile. */
  profile: string | null;
  /**
   * Runtime override for this command: "pi", "opencode", or null to use the
   * profile's runtime / config default. Lets a single command (e.g. /review)
   * pin a different engine than the profile would otherwise select.
   */
  runtime: string | null;
  enabled: number; // 0 | 1 (SQLite has no native bool)
  /** 1 for the seeded /<agent> default — non-deletable. */
  is_builtin: number; // 0 | 1
  created_at: string;
  updated_at: string;
}

export interface NewCommand {
  trigger: string;
  name: string;
  description?: string;
  system_prompt?: string;
  profile?: string | null;
  runtime?: string | null;
  enabled?: number;
}

/**
 * Partial update for a command. All fields optional. `is_builtin` is never
 * editable through this type — it is set only by the boot-time seed.
 */
export type CommandUpdate = Partial<
  Pick<NewCommand, "trigger" | "name" | "description" | "system_prompt" | "profile" | "runtime" | "enabled">
>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  profile TEXT,
  runtime TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commands_enabled ON commands(enabled);
`;

export class CommandStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    this.db.exec(SCHEMA);
    // Add `runtime` to pre-existing tables. Fresh DBs have it via the CREATE.
    const cols = db.prepare("PRAGMA table_info(commands)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "runtime")) {
      db.exec("ALTER TABLE commands ADD COLUMN runtime TEXT");
    }
  }

  /** For tests that want to inject an in-memory DB. */
  static fromDb(db: Db): CommandStore {
    return new CommandStore(db);
  }

  /** Create a command. Callers must normalise + validate the trigger first. */
  create(input: NewCommand): CommandRow {
    this.db
      .prepare(
        `INSERT INTO commands (trigger, name, description, system_prompt, profile, runtime, enabled)
         VALUES (@trigger, @name, @description, @system_prompt, @profile, @runtime, @enabled)`,
      )
      .run({
        trigger: input.trigger,
        name: input.name,
        description: input.description ?? "",
        system_prompt: input.system_prompt ?? "",
        profile: input.profile ?? null,
        runtime: input.runtime ?? null,
        enabled: input.enabled ?? 1,
      });
    const id = (this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    return this.get(id);
  }

  /** Apply a partial update. */
  update(id: number, update: CommandUpdate): CommandRow {
    const current = this.get(id);
    const cols: string[] = [];
    const params: Record<string, unknown> = { id };

    for (const key of ["trigger", "name", "description", "system_prompt", "profile", "runtime"] as const) {
      if (update[key] !== undefined) {
        cols.push(`${key} = @${key}`);
        params[key] = update[key];
      }
    }
    if (update.enabled !== undefined) {
      cols.push("enabled = @enabled");
      params.enabled = update.enabled;
    }
    if (cols.length === 0) return current;

    cols.push("updated_at = datetime('now')");
    this.db.prepare(`UPDATE commands SET ${cols.join(", ")} WHERE id = @id`).run(params);
    return this.get(id);
  }

  /**
   * Delete a command. Throws for built-in rows (the `/<agent>` default is
   * non-deletable so users always have a working command).
   */
  delete(id: number): void {
    const row = this.db.prepare("SELECT is_builtin FROM commands WHERE id = ?").get(id) as
      | { is_builtin: number }
      | undefined;
    if (!row) return; // idempotent — deleting a missing row is a no-op
    if (row.is_builtin === 1) {
      throw new Error(`command ${id} is built-in and cannot be deleted`);
    }
    this.db.prepare("DELETE FROM commands WHERE id = ?").run(id);
  }

  /** Fetch one command by id. Throws if missing. */
  get(id: number): CommandRow {
    const row = this.db.prepare("SELECT * FROM commands WHERE id = ?").get(id) as
      | CommandRow
      | undefined;
    if (!row) throw new Error(`command ${id} not found`);
    return row;
  }

  /** Find a command by its trigger (case-insensitive). Returns undefined if missing. */
  getByTrigger(trigger: string): CommandRow | undefined {
    if (!trigger) return undefined;
    return this.db
      .prepare("SELECT * FROM commands WHERE trigger = ? COLLATE NOCASE")
      .get(trigger) as CommandRow | undefined;
  }

  /** All commands, newest-first (by id, which is monotonic with creation). */
  list(): CommandRow[] {
    return this.db
      .prepare("SELECT * FROM commands ORDER BY id DESC")
      .all() as CommandRow[];
  }

  /** Triggers of all enabled commands — used to generalise wake detection. */
  activeTriggers(): string[] {
    const rows = this.db
      .prepare("SELECT trigger FROM commands WHERE enabled = 1 ORDER BY id ASC")
      .all() as { trigger: string }[];
    return rows.map((r) => r.trigger);
  }
  /**
   * The first enabled command whose `/<trigger>` appears as a standalone token
   * in `text`. Returns null when nothing matches. Ordered by id so the
   * built-in default is evaluated first (and loses only to a more specific
   * command that actually appears in the text).
   */
  resolveByTrigger(text: string): CommandRow | null {
    if (!text) return null;
    const rows = this.db
      .prepare("SELECT * FROM commands WHERE enabled = 1 ORDER BY id ASC")
      .all() as CommandRow[];
    for (const cmd of rows) {
      const escaped = cmd.trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?:^|\\s)/${escaped}\\b`, "i");
      if (re.test(text)) return cmd;
    }
    return null;
  }

  /**
   * Insert the built-in command row. Only called by `seedBuiltinCommand` when
   * no built-in exists yet. User-created commands go through `create()`; this
   * path is the sole way a row with `is_builtin = 1` enters the table.
   */
  upsertBuiltin(trigger: string, systemPrompt: string): void {
    this.db
      .prepare(
        `INSERT INTO commands (trigger, name, description, system_prompt, profile, enabled, is_builtin)
         VALUES (@trigger, @name, @description, @system_prompt, @profile, @enabled, @is_builtin)`,
      )
      .run({
        trigger,
        name: "Default (fix workflow)",
        description: `The built-in /${trigger} command — loads the noodle-default + noodle-fix skills and runs the fix workflow. Non-deletable.`,
        system_prompt: systemPrompt,
        profile: null,
        enabled: 1,
        is_builtin: 1,
      });
  }
}

/**
 * Normalise a raw trigger (as typed by a user) into storage form: lowercase,
 * strip leading slashes, trim, collapse internal whitespace to hyphens.
 * Returns the empty string if the input has no usable content.
 *
 *   normalizeTrigger("Question")   → "question"
 *   normalizeTrigger("/Question")  → "question"
 *   normalizeTrigger("  review ")  → "review"
 *   normalizeTrigger("//question") → "question"
 */
export function normalizeTrigger(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .trim();
}

/**
 * Ensure the built-in `/<agent>` command exists. Called once at boot. If a
 * built-in row is already present, its trigger + system_prompt are refreshed
 * in place (so an agent-name change or a prompt-text update propagates without
 * leaving a stale row). If no built-in exists, one is seeded.
 *
 * The built-in is the default fix workflow: its `system_prompt` is the exact
 * framing `buildPrompt` used before commands existed, so a `/noodle` run is
 * byte-identical to the pre-commands behaviour.
 */
export function seedBuiltinCommand(store: CommandStore, agentName: string): void {
  const trigger = slugify(agentName);
  const prompt = defaultCommandPrompt(agentName);
  const existing = store.list().find((c) => c.is_builtin === 1);
  if (existing) {
    // Refresh trigger (agent may have been renamed) + prompt text in place.
    store.update(existing.id, { trigger, system_prompt: prompt });
    return;
  }
  store.upsertBuiltin(trigger, prompt);
}
