import type { Database as Db } from "better-sqlite3";

/**
 * DB-backed key/value store for self-hosted instance secrets and flags that
 * the web UI manages: GitHub creds, LLM API keys, the webhook secret, the UI
 * password, the agent login.
 *
 * Why a DB table (not the .env / YAML like the rest of config): these are the
 * things an operator sets once at first run and then edits through the browser.
 * Keeping them in the same SQLite DB the server already runs on lets the UI
 * read/write them directly — no file rewriting, no separate secrets store.
 *
 * The YAML config keeps the *behavioral* config (profiles, routing, triggers,
 * queue, scheduler) — the portable "how the agent works" stuff. This table is
 * the *instance* config — "what this deployment is wired to."
 *
 * At boot, `hydrateEnvFromDb()` (hydrate-env.ts) copies every row into
 * `process.env` unless the real environment already set it — so DB-stored
 * secrets behave identically to env vars for every consumer (providers read
 * `process.env[api_key_env]`, auth reads GITHUB_* once at boot, etc.) with
 * zero code changes there. Real env wins, so a `.env`/`-e` flag isn't silently
 * clobbered by stale rows.
 *
 * Mirrors RunStore / CronStore: a class over the shared better-sqlite3 handle,
 * with `fromDb` for in-memory tests.
 *
 * NOTE: values are stored as plaintext TEXT. SQLite's file is already the
 * sensitive artifact (it holds the same data better-sqlite3 writes for the
 * queue/runs); operators protect it the same way they protect noodle.db
 * itself (volume perms, disk encryption). We do NOT mask/encrypt at rest
 * because every consumer needs the cleartext at runtime anyway.
 */

/** The set of keys this store knows about, with human labels for the UI. */
export interface SettingMeta {
  /** The env var name the value is hydrated into. */
  key: string;
  /** Human-readable label for the settings form. */
  label: string;
  /** Whether changing this value requires a server restart to take effect. */
  restartRequired: boolean;
  /** Whether the value is secret (masked in the UI). */
  secret: boolean;
  /** Optional help text shown under the field. */
  hint?: string;
}

/**
 * The catalog of settings. Grouped logically for the UI; the `restartRequired`
 * flag is derived from whether the consumer reads the value once at boot
 * (GitHub auth, webhook secret, UI password, login) vs per-request (LLM keys).
 */
export const SETTING_CATALOG: readonly SettingMeta[] = [
  // --- GitHub (App mode) ---
  { key: "GITHUB_APP_ID", label: "GitHub App ID", restartRequired: true, secret: false, hint: "The numeric App ID." },
  { key: "GITHUB_PRIVATE_KEY", label: "GitHub App private key (PEM)", restartRequired: true, secret: true, hint: "The full PEM text, including BEGIN/END lines." },
  // --- GitHub (PAT mode) ---
  { key: "GITHUB_TOKEN", label: "GitHub token (PAT)", restartRequired: true, secret: true, hint: "A PAT with repo (or fine-grained contents/pull-requests/issues) scope." },
  // --- Webhook + UI auth ---
  { key: "GITHUB_WEBHOOK_SECRET", label: "Webhook secret", restartRequired: true, secret: true, hint: "The HMAC secret GitHub signs webhooks with." },
  { key: "NOODLE_UI_PASSWORD", label: "Dashboard password", restartRequired: true, secret: true, hint: "Also signs the auth cookie. Setting this enables the web UI." },
  { key: "NOODLE_LOGIN", label: "Agent login", restartRequired: true, secret: false, hint: "The agent's GitHub username (scopes assignment triggers). Defaults to <agent>-agent." },
  // --- LLM API keys (read per-request via process.env[api_key_env]) ---
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", restartRequired: false, secret: true },
  { key: "OPENAI_API_KEY", label: "OpenAI API key", restartRequired: false, secret: true },
  { key: "OPENROUTER_API_KEY", label: "OpenRouter API key", restartRequired: false, secret: true },
  { key: "GROQ_API_KEY", label: "Groq API key", restartRequired: false, secret: true },
  { key: "DEEPSEEK_API_KEY", label: "DeepSeek API key", restartRequired: false, secret: true },
  { key: "GEMINI_API_KEY", label: "Google (Gemini) API key", restartRequired: false, secret: true },
  { key: "OPENCODE_API_KEY", label: "OpenCode Zen API key", restartRequired: false, secret: true, hint: "For OpenCode-runtime runs using the free OpenCode Zen models. Get one at opencode.ai/auth." },
] as const;

/** Keys whose change requires a restart. */
const RESTART_KEYS = new Set(SETTING_CATALOG.filter((s) => s.restartRequired).map((s) => s.key));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
}

export class SettingStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  /** For tests that want to inject an in-memory DB. */
  static fromDb(db: Db): SettingStore {
    return new SettingStore(db);
  }

  /** Get one value, or undefined if absent. */
  get(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  /** True if a (non-empty) value is stored for this key. */
  has(key: string): boolean {
    const v = this.get(key);
    return v != null && v !== "";
  }

  /** Fetch every row. Used by hydrateEnvFromDb at boot. */
  all(): SettingRow[] {
    return this.db.prepare("SELECT key, value, updated_at FROM settings").all() as SettingRow[];
  }

  /**
   * Insert or update a value. An empty string deletes the row (so "clear this
   * field" in the UI actually clears it rather than storing empty). Unknown
   * keys are accepted — custom profiles may reference arbitrary api_key_env
   * names the catalog doesn't pre-list.
   */
  set(key: string, value: string): void {
    if (value === "") {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (@key, @value, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run({ key, value });
  }

  /** Bulk upsert from a key→value map. Empty values delete. */
  setMany(values: Record<string, string>): void {
    const tx = this.db.transaction((entries: [string, string][]) => {
      for (const [k, v] of entries) this.set(k, v);
    });
    tx(Object.entries(values));
  }

  /**
   * Mask a value for UI display: show `••••` + the last 4 chars if set, else
   * empty. Never reveals the stored value; the PUT endpoint only accepts a
   * new full value when the user edits the field.
   */
  static mask(value: string | undefined): string {
    if (!value) return "";
    return `••••${value.slice(-4)}`;
  }

  /** Is this key one that needs a restart to take effect? */
  static isRestartKey(key: string): boolean {
    return RESTART_KEYS.has(key);
  }

  /** The catalog, for the UI to render the form. */
  static catalog(): readonly SettingMeta[] {
    return SETTING_CATALOG;
  }
}
