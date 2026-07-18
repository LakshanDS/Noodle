import type { Database as Db } from "better-sqlite3";

/**
 * DB-backed key/value store for ALL instance configuration that the web UI
 * manages: GitHub creds, the webhook secret, the UI password, the agent login,
 * plus behavioral settings (agent name, triggers, routing, queue, scheduler,
 * run timeouts). Everything is editable from the Settings page.
 *
 * Why a DB table (not .env / YAML): these are the things an operator sets once
 * at first run and then edits through the browser. Keeping them in the same
 * SQLite DB the server already runs on lets the UI read/write them directly —
 * no file rewriting, no separate secrets store, no env-var hydration bridge.
 *
 * Consumers read from this store directly (or via getters that re-query the DB
 * per-request for hot-reloadable values like the UI password and webhook secret).
 * Only the DB path, server host/port, and log level remain env/CLI flags —
 * they're needed before the DB opens or the server starts listening.
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
  // --- Public URL (where GitHub / webhooks reach Noodle) ---
  { key: "NOODLE_PUBLIC_URL", label: "Public URL", restartRequired: false, secret: false, hint: "The public http(s) address GitHub can reach Noodle at (for webhook delivery). Required for the GitHub App flow when you browse via localhost — set this to a tunnel (e.g. https://abc.ngrok.io) or your public host. A raw public IP works too (e.g. http://203.0.113.50:3000). If unset, the browser's current address is used." },
  // --- GitHub (App mode) ---
  { key: "GITHUB_APP_ID", label: "GitHub App ID", restartRequired: false, secret: false, hint: "The numeric App ID." },
  { key: "GITHUB_PRIVATE_KEY", label: "GitHub App private key (PEM)", restartRequired: false, secret: true, hint: "The full PEM text, including BEGIN/END lines." },
  // --- GitHub (PAT mode) ---
  { key: "GITHUB_TOKEN", label: "GitHub token (PAT)", restartRequired: false, secret: true, hint: "A PAT with repo (or fine-grained contents/pull-requests/issues) scope." },
  // --- Webhook + UI auth ---
  { key: "GITHUB_WEBHOOK_SECRET", label: "Webhook secret", restartRequired: false, secret: true, hint: "The HMAC secret GitHub signs webhooks with." },
  // --- Internal: GitHub App setup state (CSRF token for manifest flow) ---
  { key: "GITHUB_APP_SETUP_STATE", label: "Setup state", restartRequired: false, secret: true, hint: "Temporary CSRF token for GitHub App creation flow." },
  { key: "NOODLE_UI_PASSWORD", label: "Dashboard password", restartRequired: false, secret: true, hint: "Also signs the auth cookie. Setting this enables the web UI. Changing it logs out all existing sessions." },
  { key: "NOODLE_LOGIN", label: "Agent login", restartRequired: false, secret: false, hint: "The agent's GitHub username (scopes assignment triggers). Defaults to <agent>-agent." },
  // --- GitHub labels (the 3 status labels applied to issues during a run).
  // Rendered by a custom UI block in SettingsView (3 name+color rows), not the
  // generic field loop. Stored as a JSON string; null = hardcoded defaults. ---
  { key: "labels", label: "GitHub labels", restartRequired: false, secret: false, hint: "The 3 status labels (cooking/cooked/failed) applied to issues during a run. Each command can override these with its own labels." },
  // --- System prompt (global role/context, prepended to every run). The default
  // profile is set from the Profiles page, not here. ---
  { key: "system_prompt", label: "System prompt", restartRequired: false, secret: false, hint: "Role + context prepended to every agent run (composed WITH each command's own prompt). Keep it short — just tell the agent its role and let it decide its approach from the system info it receives. Supports {agent}, {system}, {pr}, {issue} tags." },
  // --- Triggers (wake filters for issues — re-overlayed live on save). The two
  // booleans render side-by-side on one row (see SettingsView grouping). ---
  { key: "trigger_keywords", label: "Trigger keywords", restartRequired: false, secret: false, hint: 'JSON array of extra substrings that fire the agent (e.g. ["agent-fix"]).' },
  { key: "trigger_on_mention", label: "Trigger on @mention", restartRequired: false, secret: false, hint: 'Fire Agent when body/comments contains "@Noodle" or /Noodle.' },
  { key: "trigger_on_open", label: "Trigger on open", restartRequired: false, secret: false, hint: "Fire Agent on any new/reopened/labeled issue or Pull Request." },
  // --- Routing rules (re-overlayed live on save) ---
  { key: "routing", label: "Routing rules", restartRequired: false, secret: false, hint: 'JSON array of {kind, match, profile} objects (e.g. [{"kind":"slash","match":"/claude","profile":"claude"}]).' },
  // --- Queue retry knobs. Both resolve via getters at dispatch time, so a
  // change applies to the next job failure — no restart. (How many jobs run at
  // once is controlled per-profile by each profile's `max_concurrent` cap, set
  // on the Profiles page — not here.) ---
  { key: "queue_max_attempts", label: "Queue max attempts", restartRequired: false, secret: false, hint: "Total attempts per job (1 = no retry). Applies to the next job failure — no restart needed." },
  { key: "queue_retry_backoff_seconds", label: "Queue retry backoff (s)", restartRequired: false, secret: false, hint: "Base backoff seconds; doubles each attempt, capped at 10 min. Applies on the next failure — no restart needed." },
  // --- Run timeouts ---
  { key: "run_stall_timeout_minutes", label: "Stall timeout (min)", restartRequired: false, secret: false, hint: "Abort after N minutes of silence while no tool is running. 0 = off." },
  { key: "run_tool_stall_minutes", label: "Tool stall timeout (min)", restartRequired: false, secret: false, hint: "Abort after N minutes of silence while a tool IS running. 0 = off." },
  // --- LLM API keys live on profiles now (api_key field), not here. ---
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

  /** Fetch every row. Used by the settings GET endpoint + config loading. */
  all(): SettingRow[] {
    return this.db.prepare("SELECT key, value, updated_at FROM settings").all() as SettingRow[];
  }

  /**
   * Insert or update a value. An empty string deletes the row (so "clear this
   * field" in the UI actually clears it rather than storing empty).
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
