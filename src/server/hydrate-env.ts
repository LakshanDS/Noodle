import type { Database as Db } from "better-sqlite3";
import { SettingStore } from "./settings-store.js";

/**
 * Copy every setting row into `process.env`, so DB-stored secrets behave like
 * env vars for every consumer (LLM keys read per-request via
 * `process.env[api_key_env]`; GitHub auth + webhook secret + UI password read
 * once at boot). Called from serve.ts BEFORE resolveAuthProvider() and before
 * the UI-password check.
 *
 * Precedence: REAL ENV WINS. If a var is already set in the real environment
 * (e.g. via `.env`, `-e`, or the shell), the DB value does not overwrite it.
 * This keeps a per-deploy override from being silently clobbered by a stale
 * row someone left in the DB.
 *
 * `process.env` values are always strings, so we only set when the DB value is
 * a non-empty string (a stored "" means "cleared" — leave the env unset).
 *
 * Returns the list of keys that were hydrated, for logging.
 */
export function hydrateEnvFromDb(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const store = new SettingStore(db);
  const hydrated: string[] = [];
  for (const row of store.all()) {
    if (row.value === "") continue;
    if (env[row.key] !== undefined && env[row.key] !== "") continue; // real env wins
    env[row.key] = row.value;
    hydrated.push(row.key);
  }
  return hydrated;
}
