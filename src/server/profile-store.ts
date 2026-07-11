import type { Database as Db } from "better-sqlite3";
import { ProfileSchema, type Profile } from "../config/schema.js";
import { log } from "../util/log.js";

/**
 * DB-backed store for agent profiles — the named {provider, model, tools, …}
 * bundles the agent runs as. Profiles can also live in the YAML config; this
 * table is the runtime-editable surface the web UI manages. At boot, `serve.ts`
 * merges every row here into `config.profiles` (DB rows override same-named YAML
 * profiles on a name clash), so the run engine, routing, cron dropdown, worker
 * pool, and relay all see them with no changes.
 *
 * Each profile's full field set (ProfileSchema — 19 fields) is stored as a JSON
 * blob in `data`. The schema is already the source of truth (the engine consumes
 * `Profile` objects), and the only queries are list-all / get-by-name — there's
 * no column-level filtering that would justify 19 typed columns. Every write and
 * every read validates the blob against `ProfileSchema`, so malformed data can't
 * land in the table and can't leak into the engine.
 *
 * Mirrors RunStore / CronStore / SettingStore: a class over the shared
 * better-sqlite3 handle, with `fromDb` for in-memory tests.
 */

export interface ProfileRow {
  /** Profile name — the key jobs/crons reference (and the `#<name>` tag). */
  name: string;
  /** JSON-serialized `Profile` object (validated against ProfileSchema). */
  data: string;
  created_at: string;
  updated_at: string;
}

/** A profile row with its data parsed back into a typed `Profile`. */
export interface StoredProfile {
  name: string;
  profile: Profile;
  created_at: string;
  updated_at: string;
}

/** A lightweight view for list endpoints — name + parsed identity fields. */
export interface ProfileSummary {
  name: string;
  provider: string;
  model: string;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export class ProfileStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  /** For tests that want to inject an in-memory DB. */
  static fromDb(db: Db): ProfileStore {
    return new ProfileStore(db);
  }

  /**
   * All stored profiles, with parsed + validated `Profile` objects. Sorted
   * alphabetically by name for stable UI ordering. Rows whose JSON no longer
   * validates against the current schema are skipped (logged) rather than
   * crashing the list — a forward-compat safety net if the schema gains fields.
   */
  list(): StoredProfile[] {
    const rows = this.db
      .prepare("SELECT name, data, created_at, updated_at FROM profiles ORDER BY name ASC")
      .all() as ProfileRow[];
    const out: StoredProfile[] = [];
    for (const row of rows) {
      const profile = parseProfile(row.data);
      if (!profile) {
        log.warn({ name: row.name }, "stored profile failed schema validation; skipping");
        continue;
      }
      out.push({ name: row.name, profile, created_at: row.created_at, updated_at: row.updated_at });
    }
    return out;
  }

  /** Lightweight summaries for the list view (no full data payload). */
  listSummaries(): ProfileSummary[] {
    return this.list().map(({ name, profile, created_at, updated_at }) => ({
      name,
      provider: profile.provider,
      model: profile.model,
      created_at,
      updated_at,
    }));
  }

  /** Fetch one profile by name. Throws if missing. */
  get(name: string): StoredProfile {
    const row = this.db
      .prepare("SELECT name, data, created_at, updated_at FROM profiles WHERE name = ?")
      .get(name) as ProfileRow | undefined;
    if (!row) throw new Error(`profile "${name}" not found`);
    const profile = parseProfile(row.data);
    if (!profile) throw new Error(`profile "${name}" has invalid stored data`);
    return { name: row.name, profile, created_at: row.created_at, updated_at: row.updated_at };
  }

  /** True if a profile with this name is stored in the DB. */
  has(name: string): boolean {
    const row = this.db.prepare("SELECT 1 AS hit FROM profiles WHERE name = ?").get(name);
    return !!row;
  }

  /**
   * Insert a new profile. Throws if the name is already taken (callers that
   * want upsert-or-rename should use `update` / `rename`). The profile is
   * validated against `ProfileSchema` before persisting.
   */
  create(name: string, profile: Profile): StoredProfile {
    if (this.has(name)) throw new Error(`profile "${name}" already exists`);
    const data = serializeProfile(profile);
    this.db
      .prepare(
        `INSERT INTO profiles (name, data) VALUES (@name, @data)`,
      )
      .run({ name, data });
    return this.get(name);
  }

  /**
   * Replace a profile's field set in place (name unchanged). Validates against
   * `ProfileSchema`. Throws if the profile doesn't exist.
   */
  update(name: string, profile: Profile): StoredProfile {
    if (!this.has(name)) throw new Error(`profile "${name}" not found`);
    const data = serializeProfile(profile);
    this.db
      .prepare(
        `UPDATE profiles SET data = @data, updated_at = datetime('now') WHERE name = @name`,
      )
      .run({ name, data });
    return this.get(name);
  }

  /**
   * Rename a profile. Throws if the old name doesn't exist or the new name is
   * already taken. Returns the renamed row (data unchanged).
   */
  rename(oldName: string, newName: string): StoredProfile {
    if (oldName === newName) return this.get(oldName);
    if (!this.has(oldName)) throw new Error(`profile "${oldName}" not found`);
    if (this.has(newName)) throw new Error(`profile "${newName}" already exists`);
    this.db
      .prepare(
        `UPDATE profiles SET name = @newName, updated_at = datetime('now') WHERE name = @oldName`,
      )
      .run({ oldName, newName });
    return this.get(newName);
  }

  /** Delete a profile. No-op if it doesn't exist (idempotent). */
  delete(name: string): void {
    this.db.prepare("DELETE FROM profiles WHERE name = ?").run(name);
  }
}

/**
 * Validate a raw object against `ProfileSchema`, applying defaults. Returns the
 * parsed `Profile` or null. Used by the UI route handler (on incoming JSON) and
 * internally (on stored blobs). Throws a Zod-flavored error string on failure
 * only via `parseProfileStrict`; this lenient variant is for reading stored rows.
 */
export function parseProfile(data: string): Profile | null {
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return null;
  }
  const res = ProfileSchema.safeParse(obj);
  return res.success ? res.data : null;
}

/**
 * Parse + validate a caller-supplied object, returning the typed `Profile` or a
 * human-readable error string. The `base_url ↔ api` pairing rule is enforced
 * here too (mirrors the cross-validator the YAML path runs in schema.ts).
 */
export function validateProfileInput(obj: unknown): Profile | { error: string } {
  const res = ProfileSchema.safeParse(obj);
  if (!res.success) {
    const first = res.error.issues[0];
    const path = first?.path.length ? `${first.path.join(".")}: ` : "";
    return { error: `${path}${first?.message ?? "invalid profile"}` };
  }
  const p = res.data;
  if (p.base_url && !p.api) return { error: '"api" is required when "base_url" is set (custom endpoint)' };
  if (p.api && !p.base_url) return { error: '"base_url" is required when "api" is set (custom endpoint)' };
  return p;
}

/** Serialize a validated `Profile` for storage. */
function serializeProfile(profile: Profile): string {
  return JSON.stringify(profile);
}
