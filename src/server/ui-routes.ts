import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RunStore } from "./run-store.js";
import type { JobQueue } from "./queue.js";
import { CronStore } from "./cron-store.js";
import type { NewCron, CronUpdate } from "./cron-store.js";
import { SettingStore, SETTING_CATALOG } from "./settings-store.js";
import { ProfileStore, validateProfileInput, type StoredProfile } from "./profile-store.js";
import { SETUP_PROFILE_KEY, type SetupProfile } from "../config/setup-fallback.js";
import { isAppMode } from "../github/auth-provider.js";
import type { AuthProvider } from "../github/auth-provider.js";
import type { NoodleConfig, Profile } from "../config/schema.js";
import { labelsFor } from "../engine/run.js";
import { readSession, type ParsedMessage } from "./session-reader.js";
import {
  clearCookieValue,
  loginCookieValue,
  requireAuth,
  verifyPassword,
} from "./ui-auth.js";
import { log } from "../util/log.js";

/**
 * Register the web UI routes on an existing Fastify app: the HTML shell at
 * `GET /` plus the JSON API under `/api/*`. All routes except `/api/login` are
 * gated by the signed-cookie preHandler, so the UI fails closed.
 *
 * Routes are added by `serve.ts` only when `NOODLE_UI_PASSWORD` is set, so an
 * unconfigured deployment exposes nothing new.
 *
 * The HTML is a single self-contained `public/index.html` (inline CSS + JS, no
 * build step). It contains both the login screen and the chat viewer; the JS
 * swaps views after a successful `/api/login`, so there's no separate login
 * page to serve.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/server/ui-routes.js → ../../public (repo root's public/).
const HTML_PATH = join(__dirname, "..", "..", "public", "index.html");

export interface UiDeps {
  runStore: RunStore;
  /** The operator password (NOODLE_UI_PASSWORD). Also the token-signing secret. */
  secret: string;
  queue: JobQueue;
  authProvider: AuthProvider;
  agentName: string;
  /** Cron job store — for the /api/crons CRUD + manual-run routes. */
  cronStore: CronStore;
  /** Settings store — for the /api/settings read/write routes (secrets etc.). */
  settingsStore: SettingStore;
  /** Profile store — for the /api/profiles CRUD routes (DB-managed profiles). */
  profileStore: ProfileStore;
  /** Resolved config — for the profile-name dropdown + default profile. */
  config: NoodleConfig;
}

export function registerUiRoutes(app: FastifyInstance, deps: UiDeps): void {
  const { runStore, secret, queue, authProvider, agentName, cronStore, settingsStore, profileStore, config } = deps;

  // PreHandler closure: verify the signed cookie before any protected route.
  const auth = async (req: FastifyRequest, reply: FastifyReply) => requireAuth(req, reply, secret);

  // --- HTML shell (the login + viewer SPA). Served unauthenticated: the body
  // renders the login screen and its JS bounces to it on any 401 from /api/*.
  // Serving one shell keeps the UI a single route with no separate login page. ---
  app.get("/", async (_req, reply) => {
    const html = readFileSync(HTML_PATH, "utf8");
    reply.type("text/html").send(html);
  });

  // --- Login / logout (intentionally NOT behind requireAuth). ---
  app.post("/api/login", async (req, reply) => {
    // The UI routes share the webhook app, whose custom application/json parser
    // returns the RAW body string (so the webhook handler has bytes for HMAC).
    // So req.body may be a string here, not a parsed object — coerce either way.
    const password = readPassword(req.body);
    if (!password || !verifyPassword(password, secret)) {
      return reply.code(401).send({ error: "invalid password" });
    }
    reply.header("set-cookie", loginCookieValue(secret));
    return reply.send({ ok: true });
  });

  app.post("/api/logout", async (_req, reply) => {
    reply.header("set-cookie", clearCookieValue());
    return reply.send({ ok: true });
  });

  // --- Setup wizard (first-run). Unauthenticated, but only admitted when the
  // instance is not yet configured (no UI password + no GitHub auth). Once a
  // UI password is set these routes 403, so they can't be used to re-open the
  // wizard or reset creds on a live instance. ---
  // `configured` here means "has a UI password" — that's the gate that turns the
  // UI from open-setup into auth-gated. GitHub auth is also reported so the
  // wizard can show which steps are still needed.
  const isConfigured = (): boolean => settingsStore.has("NOODLE_UI_PASSWORD") || !!process.env.NOODLE_UI_PASSWORD;

  app.get("/api/setup/status", async () => {
    const env = process.env;
    const ghFromEnv = isAppMode(env)
      ? !!(env.GITHUB_APP_ID && (env.GITHUB_PRIVATE_KEY || env.GITHUB_PRIVATE_KEY_FILE))
      : !!env.GITHUB_TOKEN;
    return {
      configured: isConfigured(),
      steps: {
        github: ghFromEnv || settingsStore.has("GITHUB_TOKEN") || settingsStore.has("GITHUB_APP_ID"),
        llm: settingsStore.has("ANTHROPIC_API_KEY") ||
          settingsStore.has("OPENAI_API_KEY") ||
          settingsStore.has("OPENROUTER_API_KEY") ||
          settingsStore.has("GROQ_API_KEY") ||
          settingsStore.has("DEEPSEEK_API_KEY") ||
          settingsStore.has("GEMINI_API_KEY") ||
          settingsStore.has(SETUP_PROFILE_KEY),
        ui: settingsStore.has("NOODLE_UI_PASSWORD") || !!env.NOODLE_UI_PASSWORD,
      },
      // Existing profile names from config (so the wizard can warn if a profile
      // already exists, meaning the seed step is optional).
      hasProfiles: Object.keys(config.profiles).length > 0,
    };
  });

  app.post("/api/setup", async (req, reply) => {
    // Fail closed once configured — never let the wizard re-run on a live box.
    if (isConfigured()) {
      return reply.code(403).send({ error: "already configured" });
    }
    const body = readJsonBody(req.body);
    if (!body) return reply.code(400).send({ error: "missing body" });
    const parsed = parseSetupPayload(body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });

    // Persist all in one transaction.
    const values: Record<string, string> = {};
    if (parsed.github.token) values.GITHUB_TOKEN = parsed.github.token;
    if (parsed.github.appId) values.GITHUB_APP_ID = parsed.github.appId;
    if (parsed.github.privateKey) values.GITHUB_PRIVATE_KEY = parsed.github.privateKey;
    if (parsed.github.webhookSecret) values.GITHUB_WEBHOOK_SECRET = parsed.github.webhookSecret;
    if (parsed.llm.apiKeyEnv && parsed.llm.apiKey) values[parsed.llm.apiKeyEnv] = parsed.llm.apiKey;
    if (parsed.uiPassword) values.NOODLE_UI_PASSWORD = parsed.uiPassword;

    // Store the profile seed so the config fallback can synthesize a profile on
    // the next boot (only relevant when YAML has no profiles).
    const seed: SetupProfile = {
      provider: parsed.llm.provider,
      model: parsed.llm.model,
      ...(parsed.llm.apiKeyEnv ? { api_key_env: parsed.llm.apiKeyEnv } : {}),
      ...(parsed.llm.baseUrl ? { base_url: parsed.llm.baseUrl } : {}),
      ...(parsed.llm.api ? { api: parsed.llm.api } : {}),
    };
    values[SETUP_PROFILE_KEY] = JSON.stringify(seed);

    settingsStore.setMany(values);
    return { ok: true, needsRestart: true };
  });

  // --- Read-only API (all auth-guarded). ---
  app.get("/api/runs", { preHandler: auth }, async () => {
    return { runs: runStore.listRuns(50) };
  });

  app.get("/api/runs/:id", { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    let run;
    try {
      run = runStore.getRun(id);
    } catch {
      return reply.code(404).send({ error: "run not found" });
    }
    // Parse the session file server-side so the browser never sees the cwd /
    // temp paths that leak from pi's session records.
    const messages: ParsedMessage[] = run.session_path ? readSession(run.session_path) : [];
    return { run, messages };
  });

  // --- Cancel a running job. Marks the queue job as failed, updates the run
  // store, and best-effort removes the "cooking" label from the issue. ---
  app.post("/api/runs/:id/cancel", { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string }; // e.g. "job-19"
    let run;
    try {
      run = runStore.getRun(id);
    } catch {
      return reply.code(404).send({ error: "run not found" });
    }
    if (run.status !== "running") {
      return reply.code(409).send({ error: "run is not running", status: run.status });
    }
    // Parse numeric job id from "job-19" → 19.
    const numericId = parseInt(id.replace(/^job-/, ""), 10);
    if (isNaN(numericId)) {
      return reply.code(400).send({ error: "invalid job id" });
    }
    // Mark the queue job failed so the worker won't pick it up again.
    try {
      queue.markFailed(numericId, "cancelled by operator");
    } catch (e) {
      log.warn({ err: e, jobId: id }, "could not mark queue job as failed (may already be done)");
    }
    // Update the run store.
    runStore.updateRun(id, { status: "failed", error: "cancelled by operator", finished_at: new Date().toISOString() });
    // Best-effort: remove the "cooking" label so future runs aren't blocked.
    // Cron runs have no source issue (run.issue is null) and never apply the
    // label, so skip the API call for them.
    try {
      if (run.issue != null) {
        const lbls = labelsFor(agentName);
        const instId = queue.getById(numericId).installation_id ?? undefined;
        const { gh } = await authProvider.forRepo(run.repo, instId);
        await gh.removeIssueLabel(run.repo, run.issue, lbls.cooking.name);
      }
    } catch (e) {
      log.warn({ err: e, jobId: id }, "could not remove cooking label after cancel");
    }
    return { ok: true };
  });

  // --- Cron job management (all auth-guarded). ---
  // Crons are DB-defined recurring agent runs that open issues (see cron-store.ts).
  // These routes are the backend for the "Crons" section of the web UI.

  // --- Profile management (DB-backed agent profiles). All auth-guarded. ---
  // These routes are the backend for the "Profiles" tab. DB-managed profiles are
  // merged into `config.profiles` at boot (serve.ts) and kept in sync here on
  // every mutation, so a freshly created/edited profile is instantly runnable
  // by the engine, appears in the cron dropdown, and counts toward the worker
  // pool's per-profile concurrency — no restart needed.

  /**
   * List every available profile: DB-stored ones (with full data, editable) plus
   * any YAML-only ones (name + data, but not deletable via the DB). The cron
   * dropdown and profiles list both consume this.
   */
  app.get("/api/profiles", { preHandler: auth }, async () => {
    const stored = profileStore.list();
    const dbNames = new Set(stored.map((p) => p.name));
    const fromYaml = Object.entries(config.profiles)
      .filter(([name]) => !dbNames.has(name))
      .map(([name, profile]) => ({ name, profile, source: "yaml" as const }));
    const fromDb = stored.map(({ name, profile }) => ({ name, profile, source: "db" as const }));
    return {
      // Flat name list (kept for the cron dropdown's existing contract).
      profiles: Object.keys(config.profiles),
      default: config.default_profile,
      // Full-detail list for the profiles tab.
      items: [...fromDb, ...fromYaml],
    };
  });

  app.post("/api/profiles", { preHandler: auth }, async (req, reply) => {
    const body = readJsonBody(req.body);
    if (!body) return reply.code(400).send({ error: "missing body" });
    const parsed = parseProfilePayload(body, /*creating*/ true);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const name = parsed.name!;
    if (profileStore.has(name) || name in config.profiles) {
      return reply.code(409).send({ error: `profile "${name}" already exists` });
    }
    const stored = profileStore.create(name, parsed.profile);
    // Live-sync into the in-memory config so the profile is runnable now.
    config.profiles[name] = parsed.profile;
    return { profile: toProfileDetail(stored, "db") };
  });

  app.get("/api/profiles/:name", { preHandler: auth }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const dbRow = profileStore.has(name) ? profileStore.get(name) : undefined;
    if (dbRow) return { profile: toProfileDetail(dbRow, "db") };
    const yamlProfile = config.profiles[name];
    if (yamlProfile) {
      return { profile: { name, profile: yamlProfile, source: "yaml" as const } };
    }
    return reply.code(404).send({ error: `profile "${name}" not found` });
  });

  app.patch("/api/profiles/:name", { preHandler: auth }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const body = readJsonBody(req.body);
    if (!body) return reply.code(400).send({ error: "missing body" });
    const parsed = parseProfilePayload(body, /*creating*/ false);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const newName = parsed.name ?? name;

    // YAML-only profiles can't be edited in place (they'd reappear from the YAML
    // on next boot). Instead, promote the edit to a new DB row so the DB override
    // takes effect.
    if (!profileStore.has(name) && !(name in config.profiles)) {
      return reply.code(404).send({ error: `profile "${name}" not found` });
    }
    if (newName !== name && (profileStore.has(newName) || newName in config.profiles)) {
      return reply.code(409).send({ error: `profile "${newName}" already exists` });
    }

    let stored: StoredProfile;
    if (profileStore.has(name)) {
      if (newName !== name) {
        profileStore.rename(name, newName);
        // Drop the old-name binding from the live config; the new one is set below.
        delete config.profiles[name];
      }
      stored = profileStore.update(newName, parsed.profile);
    } else {
      // Promote a YAML profile to DB-managed.
      stored = profileStore.create(newName, parsed.profile);
    }
    config.profiles[stored.name] = parsed.profile;
    return { profile: toProfileDetail(stored, "db") };
  });

  app.delete("/api/profiles/:name", { preHandler: auth }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const existed = profileStore.has(name);
    profileStore.delete(name);
    // Only DB profiles come back from the YAML on next boot, so removing a
    // pure-DB profile from the live config is safe + durable. We DON'T touch
    // YAML-only profiles here (they'd just reappear).
    if (existed) {
      delete config.profiles[name];
      return { ok: true };
    }
    if (name in config.profiles) {
      return reply.code(400).send({
        error: `"${name}" is defined in the YAML config; remove it there to delete it.`,
      });
    }
    return reply.code(404).send({ error: `profile "${name}" not found` });
  });

  app.get("/api/crons", { preHandler: auth }, async () => {
    return { crons: cronStore.listCrons() };
  });

  app.post("/api/crons", { preHandler: auth }, async (req, reply) => {
    const body = readJsonBody(req.body);
    const parsed = parseCronInput(body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    try {
      const cron = cronStore.createCron(parsed);
      return { cron };
    } catch (e) {
      return reply.code(400).send({ error: `Invalid cron expression: ${(e as Error).message}` });
    }
  });

  app.get("/api/crons/:id", { preHandler: auth }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: "invalid id" });
    try {
      const cron = cronStore.getCron(id);
      const runs = runStore.listRunsForCron(id, 20);
      return { cron, runs };
    } catch {
      return reply.code(404).send({ error: "cron not found" });
    }
  });

  app.patch("/api/crons/:id", { preHandler: auth }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: "invalid id" });
    const body = readJsonBody(req.body);
    const parsed = parseCronUpdate(body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    try {
      // Validate a changed cron expression before persisting.
      if (parsed.cron_expression !== undefined) {
        CronStore.nextRunFromExpr(parsed.cron_expression);
      }
      const cron = cronStore.updateCron(id, parsed);
      return { cron };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (/not found/.test(msg)) return reply.code(404).send({ error: msg });
      return reply.code(400).send({ error: `Invalid cron expression: ${msg}` });
    }
  });

  app.delete("/api/crons/:id", { preHandler: auth }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: "invalid id" });
    try {
      cronStore.getCron(id);
    } catch {
      return reply.code(404).send({ error: "cron not found" });
    }
    cronStore.deleteCron(id);
    return { ok: true };
  });

  /** Trigger a cron job immediately (enqueue now, bypassing its schedule). */
  app.post("/api/crons/:id/run", { preHandler: auth }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: "invalid id" });
    let cron;
    try {
      cron = cronStore.getCron(id);
    } catch {
      return reply.code(404).send({ error: "cron not found" });
    }
    // No installation-id resolution here — the worker resolves it from the repo
    // name when the job runs (forRepo auto-resolves in App mode).
    queue.enqueueCron({
      repo: cron.repo,
      cronJobId: cron.id,
      profile: cron.profile ?? config.default_profile,
      source: "manual",
    });
    return { ok: true };
  });

  // --- Settings (DB-backed instance secrets). All auth-guarded. ---
  // GET returns the catalog + masked values; PUT accepts new values. Secret
  // values are masked so a GET never leaks them to the browser — the UI sends
  // a full new value only when the field is edited (type-to-replace).
  app.get("/api/settings", { preHandler: auth }, async () => {
    const rows = settingsStore.all();
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    return {
      // The catalog tells the UI how to render each field (label, secret,
      // restartRequired, hint) without hardcoding it in the client.
      catalog: SETTING_CATALOG,
      // Masked values: "••••last4" for set secrets, the cleartext for non-secret
      // flags, "" for unset.
      values: Object.fromEntries(
        SETTING_CATALOG.map((s) => [
          s.key,
          s.secret ? SettingStore.mask(stored.get(s.key)) : (stored.get(s.key) ?? ""),
        ]),
      ),
      // Which keys, if changed, require a restart. The UI uses this to label
      // fields and to show a banner after a write.
      restartKeys: SETTING_CATALOG.filter((s) => s.restartRequired).map((s) => s.key),
    };
  });

  app.put("/api/settings", { preHandler: auth }, async (req, reply) => {
    const body = readJsonBody(req.body);
    if (!body || typeof body.values !== "object" || body.values === null) {
      return reply.code(400).send({ error: "expected { values: { [key]: string } }" });
    }
    const incoming = body.values as Record<string, unknown>;
    // Only accept string values; coerce/ignore anything else. A value that
    // matches the current mask ("••••last4") means "unchanged" — skip it so we
    // don't store the mask as the real secret.
    const updates: Record<string, string> = {};
    const touchedRestartKeys: string[] = [];
    for (const [key, raw] of Object.entries(incoming)) {
      if (typeof raw !== "string") continue;
      // Skip unchanged secret fields (the mask round-trips from GET).
      if (raw.startsWith("••••")) continue;
      updates[key] = raw;
      if (SettingStore.isRestartKey(key)) touchedRestartKeys.push(key);
    }
    settingsStore.setMany(updates);
    return {
      ok: true,
      // Tell the UI whether any of the writes need a restart to take effect.
      needsRestart: touchedRestartKeys.length > 0,
      restartKeys: touchedRestartKeys,
    };
  });
}

/**
 * Parse a request body that may arrive as a raw JSON string (the webhook app's
 * custom parser) or a parsed object. Mirrors readPassword's coercion. Returns
 * the object, or null when unparseable.
 */
function readJsonBody(body: unknown): Record<string, unknown> | null {
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
}

/** Validate a cron create payload. Returns the typed input or { error }. */
function parseCronInput(body: Record<string, unknown> | null): NewCron | { error: string } {
  if (!body) return { error: "missing body" };
  const name = strField(body, "name");
  const repo = strField(body, "repo");
  const prompt = strField(body, "prompt");
  const branch_name = strField(body, "branch_name") || strField(body, "branch");
  const cron_expression = strField(body, "cron_expression") || strField(body, "schedule");
  if (!name || !repo || !prompt || !branch_name || !cron_expression) {
    return { error: "name, repo, prompt, branch_name, and cron_expression are required" };
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { error: `repo "${repo}" is not a valid "owner/name"` };
  }
  const profile = body.profile === null || body.profile === undefined ? null : strField(body, "profile");
  return { name, repo, prompt, branch_name, cron_expression, profile, enabled: 1 };
}

/** Validate a cron update payload (all fields optional). Returns the typed update or { error }. */
function parseCronUpdate(body: Record<string, unknown> | null): CronUpdate | { error: string } {
  if (!body) return { error: "missing body" };
  const out: CronUpdate = {};
  for (const key of ["name", "repo", "prompt", "branch_name", "cron_expression", "profile"] as const) {
    const v = strField(body, key === "branch_name" ? "branch_name" : key);
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  if (body.enabled !== undefined) {
    out.enabled = body.enabled ? 1 : 0;
  }
  return out;
}

/** Coerce a body field to a trimmed string, or undefined when absent/empty. */
function strField(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" ? v.trim() || undefined : undefined;
}

/**
 * Shape a stored profile into the API detail envelope. `source` distinguishes
 * DB-managed (editable, deletable) profiles from YAML-only ones.
 */
function toProfileDetail(
  stored: StoredProfile,
  source: "db" | "yaml",
): ProfileDetailOut {
  return { name: stored.name, profile: stored.profile, source };
}

type ProfileDetailOut = { name: string; profile: Profile; source: "db" | "yaml" };

/**
 * Extract + validate the `name` (required on create) and `profile` (validated
 * against ProfileSchema) fields from a create/update payload. On PATCH, an
 * omitted `name` means "keep the existing name" (name is undefined).
 *
 * Returns a discriminated union: `{ ok: true, … }` or `{ ok: false, error }`.
 */
function parseProfilePayload(
  body: Record<string, unknown>,
  creating: boolean,
): { ok: true; name: string | undefined; profile: Profile } | { ok: false; error: string } {
  const rawName = strField(body, "name");
  if (creating && !rawName) return { ok: false, error: "name is required" };
  const profile = validateProfileInput(body.profile ?? {});
  if ("error" in profile) return { ok: false, error: profile.error };
  return { ok: true, name: rawName, profile };
}

/**
 * Extract the `password` field from a request body that may arrive as either a
 * parsed object (default fastify JSON parser) or a raw JSON string (the webhook
 * app's HMAC-friendly custom parser, which UI routes share). Returns undefined
 * on any parse failure or missing field.
 */
function readPassword(body: unknown): string | undefined {
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (body && typeof body === "object" && "password" in body) {
    const p = (body as { password?: unknown }).password;
    return typeof p === "string" ? p : undefined;
  }
  return undefined;
}

/**
 * The shape of a setup wizard submission. GitHub is either PAT (token) or App
 * (appId + privateKey); the LLM step needs a provider, model, and key; the UI
 * password gates the dashboard after setup.
 */
interface SetupPayload {
  github: {
    token?: string;
    appId?: string;
    privateKey?: string;
    webhookSecret?: string;
  };
  llm: {
    provider: string;
    model: string;
    apiKey?: string;
    /** Env var name the key is stored under (defaults to a provider-based name). */
    apiKeyEnv?: string;
    baseUrl?: string;
    api?: string;
  };
  uiPassword: string;
}

/** Validate a setup payload. Returns the typed payload or { error }. */
function parseSetupPayload(body: Record<string, unknown>): SetupPayload | { error: string } {
  const githubRaw = body.github;
  const llmRaw = body.llm;
  const uiPassword = strField(body, "uiPassword");
  if (!uiPassword) return { error: "uiPassword is required" };
  if (!llmRaw || typeof llmRaw !== "object") return { error: "llm is required" };
  const llm = llmRaw as Record<string, unknown>;
  const provider = strField(llm, "provider");
  const model = strField(llm, "model");
  if (!provider || !model) return { error: "llm.provider and llm.model are required" };

  const github: SetupPayload["github"] = {};
  if (githubRaw && typeof githubRaw === "object") {
    const g = githubRaw as Record<string, unknown>;
    github.token = strField(g, "token");
    github.appId = strField(g, "appId");
    github.privateKey = typeof g.privateKey === "string" ? g.privateKey : undefined;
    github.webhookSecret = strField(g, "webhookSecret");
  }
  // Must have some GitHub auth (PAT or App).
  if (!github.token && !(github.appId && github.privateKey)) {
    return { error: "GitHub auth required: set a token, or appId + privateKey" };
  }

  return {
    github,
    llm: {
      provider,
      model,
      apiKey: strField(llm, "apiKey"),
      apiKeyEnv: strField(llm, "apiKeyEnv"),
      baseUrl: strField(llm, "baseUrl"),
      api: strField(llm, "api"),
    },
    uiPassword,
  };
}
