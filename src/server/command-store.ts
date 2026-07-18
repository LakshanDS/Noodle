import type { Database as Db } from "better-sqlite3";
import { defaultCommandPrompt, fixCommandPrompt, reviewCommandPrompt } from "../engine/prompt.js";
import { slugify } from "../util/slugify.js";
import { stripCodeBlocks } from "../commands/match.js";

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
  /**
   * Optional custom label set as a JSON string
   * ({cooking:{name,color}, cooked:{...}, failed:{...}}). Null = use the global
   * default labels. See src/engine/labels.ts.
   */
  labels: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewCommand {
  trigger: string;
  description?: string;
  system_prompt?: string;
  profile?: string | null;
  runtime?: string | null;
  enabled?: number;
  /** JSON label-set string, or null to use the global defaults. */
  labels?: string | null;
}

/**
 * Partial update for a command. All fields optional. `is_builtin` is never
 * editable through this type — it is set only by the boot-time seed.
 */
export type CommandUpdate = Partial<
  Pick<NewCommand, "trigger" | "description" | "system_prompt" | "profile" | "runtime" | "enabled" | "labels">
>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  profile TEXT,
  runtime TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  labels TEXT,
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
    // Add `labels` (custom per-command label set) to pre-existing tables.
    if (!cols.some((c) => c.name === "labels")) {
      db.exec("ALTER TABLE commands ADD COLUMN labels TEXT");
    }
    // Drop the removed `name` column from pre-existing tables.
    if (cols.some((c) => c.name === "name")) {
      db.exec("ALTER TABLE commands DROP COLUMN name");
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
        `INSERT INTO commands (trigger, description, system_prompt, profile, runtime, enabled, labels)
         VALUES (@trigger, @description, @system_prompt, @profile, @runtime, @enabled, @labels)`,
      )
      .run({
        trigger: input.trigger,
        description: input.description ?? "",
        system_prompt: input.system_prompt ?? "",
        profile: input.profile ?? null,
        runtime: input.runtime ?? null,
        enabled: input.enabled ?? 1,
        labels: input.labels ?? null,
      });
    const id = (this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    return this.get(id);
  }

  /** Apply a partial update. */
  update(id: number, update: CommandUpdate): CommandRow {
    const current = this.get(id);
    const cols: string[] = [];
    const params: Record<string, unknown> = { id };

    for (const key of ["trigger", "description", "system_prompt", "profile", "runtime", "labels"] as const) {
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

  /** Delete a command bypassing the built-in guard. Used by the seed function to clean up stale built-ins on rename. */
  forceDelete(id: number): void {
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
   * The enabled command whose `/<trigger>` appears as a standalone token in the
   * given text segments. Returns null when nothing matches across any segment.
   *
   * Segments are scanned in the ORDER GIVEN — callers should pass them
   * newest-first (latest comment → issue body) so the most recent intent wins
   * when multiple commands appear in the thread. Within each segment, candidates
   * are tested LONGEST-trigger-first so a more specific command wins over a
   * prefix-named one: `/noodle-fix` is tested before `/noodle`, so typing
   * `/noodle-fix` resolves to the fix workflow, not the generic `/noodle`.
   *
   * The trailing boundary `(?![\w-])` (not followed by a word char or hyphen)
   * ensures `/noodle` does not match inside `/noodle-fix` — a plain `\b` would,
   * since it treats `-` as a boundary.
   *
   * Accepts either a single string (back-compat) or an array of segments.
   */
  resolveByTrigger(textOrSegments: string | string[]): CommandRow | null {
    const segments = Array.isArray(textOrSegments)
      ? textOrSegments
      : [textOrSegments];
    if (segments.length === 0) return null;
    const rows = this.db
      .prepare("SELECT * FROM commands WHERE enabled = 1")
      .all() as CommandRow[];
    // Longest trigger first — most specific command wins on overlap.
    rows.sort((a, b) => b.trigger.length - a.trigger.length);
    const regexes = rows.map((cmd) => ({
      cmd,
      re: new RegExp(`(?:^|\\s)/${cmd.trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i"),
    }));
    // Scan segments in order; first segment with a match wins (recency). Strip
    // code blocks from each segment so a `/trigger` inside a code example
    // doesn't resolve (matches the wake-gate behaviour in matchesCommandTrigger).
    for (const seg of segments) {
      if (!seg) continue;
      const stripped = stripCodeBlocks(seg);
      for (const { cmd, re } of regexes) {
        if (re.test(stripped)) return cmd;
      }
    }
    return null;
  }

  /**
   * Insert a built-in command row. Only called by `seedBuiltinCommand` when
   * no built-in with this trigger exists yet. User-created commands go through
   * `create()`; this path is the sole way a row with `is_builtin = 1` enters
   * the table.
   */
  upsertBuiltin(trigger: string, systemPrompt: string, description: string): void {
    this.db
      .prepare(
        `INSERT INTO commands (trigger, description, system_prompt, profile, enabled, is_builtin)
         VALUES (@trigger, @description, @system_prompt, @profile, @enabled, @is_builtin)`,
      )
      .run({
        trigger,
        description,
        system_prompt: systemPrompt,
        profile: null,
        enabled: 1,
        is_builtin: 1,
      });
  }
}

/**
 * Normalise a raw trigger (as typed by a user) into storage form: lowercase,
 * strip leading AND trailing slashes, trim, collapse internal whitespace to
 * hyphens. Returns the empty string if the input has no usable content.
 *
 *   normalizeTrigger("Question")    → "question"
 *   normalizeTrigger("/Question")   → "question"
 *   normalizeTrigger("  review ")   → "review"
 *   normalizeTrigger("//question")  → "question"
 *   normalizeTrigger("question//")  → "question"
 */
export function normalizeTrigger(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

/**
 * Ensure the three built-in commands exist: `/<agent>` (general-purpose),
 * `/<agent>-fix` (fix workflow), and `/<agent>-review` (code review). Called
 * once at boot.
 *
 * On initial seed (no built-in with that trigger yet): inserts with the
 * default prompt, description, and enabled=1.
 *
 * On subsequent boots (row already exists): preserves the operator's
 * system_prompt, description, and profile edits — only the trigger is
 * refreshed (for agent-name renames, though agent_name is now fixed to
 * "Noodle") and the command is forced enabled=1 so built-ins are always
 * available as the documentation contract states.
 *
 * Stale built-ins whose triggers no longer match expected ones (e.g. an
 * agent rename left behind old "noodle"-prefixed triggers) are cleaned up.
 */
export function seedBuiltinCommand(store: CommandStore, agentName: string): void {
  const base = slugify(agentName);
  const specs = [
    {
      trigger: base,
      prompt: defaultCommandPrompt(agentName),
      description: `The built-in /${base} command — loads the noodle-default skill. Non-deletable.`,
    },
    {
      trigger: `${base}-fix`,
      prompt: fixCommandPrompt(agentName),
      description: `The built-in /${base}-fix command — loads noodle-default + noodle-fix skills and runs the fix workflow. Non-deletable.`,
    },
    {
      trigger: `${base}-review`,
      prompt: reviewCommandPrompt(agentName),
      description: `The built-in /${base}-review command — loads noodle-default + noodle-review skills and runs the code review workflow. Non-deletable.`,
    },
  ];
  // Remove stale built-ins whose triggers no longer match (e.g. agent renamed
  // from "Noodle" to "MyBot" — old "noodle"/"noodle-fix"/"noodle-review" rows
  // must be replaced by "mybot"/"mybot-fix"/"mybot-review").
  const expectedTriggers = new Set(specs.map((s) => s.trigger));
  for (const row of store.list().filter((c) => c.is_builtin === 1)) {
    if (!expectedTriggers.has(row.trigger)) {
      store.forceDelete(row.id);
    }
  }
  for (const spec of specs) {
    const existing = store.getByTrigger(spec.trigger);
    if (existing) {
      // Already exists — preserve the operator's prompt/description edits.
      // Only ensure the trigger stays current and the command is enabled.
      // Built-ins are documented as "always available", so force enabled=1.
      if (!existing.enabled || existing.trigger !== spec.trigger) {
        store.update(existing.id, {
          trigger: spec.trigger,
          enabled: 1,
        });
      }
    } else {
      // First-time seed — insert with the full defaults.
      store.upsertBuiltin(spec.trigger, spec.prompt, spec.description);
    }
  }
}
