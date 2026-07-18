import { readFileSync, createReadStream, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RunStore } from "./run-store.js";
import type { JobQueue } from "./queue.js";
import { SchedulerStore } from "./scheduler-store.js";
import type { NewSchedulerJob, SchedulerUpdate } from "./scheduler-store.js";
import type { TriggerStore } from "./trigger-store.js";
import type { NewTrigger, TriggerUpdate } from "./trigger-store.js";
import { CommandStore, normalizeTrigger, type NewCommand, type CommandUpdate } from "./command-store.js";
import { SkillStore, type SkillInput, type SkillUpdate } from "./skill-store.js";
import { SettingStore, SETTING_CATALOG } from "./settings-store.js";
import { ProfileStore, validateProfileInput, type StoredProfile } from "./profile-store.js";
import type { AuthProvider } from "../github/auth-provider.js";
import type { NoodleConfig, Profile } from "../config/schema.js";
import { labelsFor } from "../engine/run.js";
import { defaultLabelSet, serializeLabelSet, parseLabelSet } from "../engine/labels.js";
import { readSession, type ParsedMessage } from "./session-reader.js";
import {
  clearCookieValue,
  loginCookieValue,
  requireAuth,
  verifyPassword,
} from "./ui-auth.js";
import { log, getRecentLogs } from "../util/log.js";

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

/** Pino level → numeric, for `?level=` filtering on GET /api/logs. */
const LEVEL_ORDER: Record<string, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
};

export interface UiDeps {
  runStore: RunStore;
  /** Getter for the operator password (NOODLE_UI_PASSWORD). Also the token-signing secret. Read per-request so password changes take effect without restart. */
  getSecret: () => string;
  queue: JobQueue;
  authProvider: AuthProvider;
  /** Cron job store — for the /api/schedulers CRUD + manual-run routes. */
  schedulerStore: SchedulerStore;
  /** Trigger store — for the /api/triggers CRUD + manual-run routes. */
  triggerStore: TriggerStore;
  /** Settings store — for the /api/settings read/write routes (secrets etc.). */
  settingsStore: SettingStore;
  /** Profile store — for the /api/profiles CRUD routes (DB-managed profiles). */
  profileStore: ProfileStore;
  /** Command store — for the /api/commands CRUD routes (DB-managed). */
  commandStore: CommandStore;
  /** Skill store — for the /api/skills CRUD routes (filesystem-backed). */
  skillStore: SkillStore;
  /** Resolved config — for the profile-name dropdown + default profile. */
  config: NoodleConfig;
  /** Directory where persistent log files live (for the download endpoint). */
  logDir?: string;
  /**
   * Trigger the dispatcher to pull newly-enqueued jobs immediately (rather than
   * waiting up to 5s for the safety-net timer). Called after a manual cron run
   * is enqueued. Optional only so test harnesses can omit it.
   */
  dispatch?: () => void;
}

/**
 * Seed sensible defaults for the editable instance settings on a fresh DB —
 * system prompt, run timeouts, triggers, routing, queue, and GitHub labels.
 * Each row is written only when missing, so this is idempotent and never
 * clobbers an operator's edits.
 *
 * Called from serve.ts at boot (right after the password seed) so a fresh
 * install has working settings the moment the UI comes up — independent of
 * whether the setup wizard ever runs. The wizard (POST /api/setup) still seeds
 * these too for back-compat, but is now unreachable on most fresh installs
 * because the boot step seeds NOODLE_UI_PASSWORD, which marks the instance
 * configured. That's why this boot-time seed exists.
 */
export function seedDefaultSettings(settingsStore: SettingStore): void {
  const values: Record<string, string> = {};
  if (!settingsStore.has("system_prompt")) {
    values.system_prompt = [
      "You are an autonomous software engineer working on a GitHub repository.",
      "Work from the issue or task you're given, and the system info below.",
      "Decide your own approach and which tools to use based on what this",
      "machine can actually do. Make the minimal change, verify it, and report",
      "what you did as your final message.",
      "",
      "{system}",
    ].join("\n");
  }
  if (!settingsStore.has("run_stall_timeout_minutes")) values.run_stall_timeout_minutes = "30";
  if (!settingsStore.has("run_tool_stall_minutes")) values.run_tool_stall_minutes = "60";
  if (!settingsStore.has("queue_max_attempts")) values.queue_max_attempts = "5";
  if (!settingsStore.has("queue_retry_backoff_seconds")) values.queue_retry_backoff_seconds = "3";
  if (!settingsStore.has("labels")) values.labels = serializeLabelSet(defaultLabelSet());
  if (Object.keys(values).length > 0) settingsStore.setMany(values);
}

export function registerUiRoutes(app: FastifyInstance, deps: UiDeps): void {
  const { runStore, getSecret, queue, authProvider, schedulerStore, triggerStore, settingsStore, profileStore, commandStore, skillStore, config, logDir, dispatch } = deps;

  // PreHandler closure: verify the signed cookie before any protected route.
  // The secret is read per-request so password changes take effect without restart.
  const auth = async (req: FastifyRequest, reply: FastifyReply) => requireAuth(req, reply, getSecret());

  // --- HTML shell (the login + viewer SPA). Served unauthenticated: the body
  // renders the login screen and its JS bounces to it on any 401 from /api/*.
  // Serving one shell keeps the UI a single route with no separate login page. ---
  app.get("/", async (_req, reply) => {
    const html = readFileSync(HTML_PATH, "utf8");
    reply.type("text/html").send(html);
  });

  // SPA catch-all: serve the shell for any non-API path so browser history
  // mode deep links (e.g. /runs/job-123) resolve. API routes (/api/*), the
  // webhook (/webhook), health (/health), and the download endpoint are all
  // registered before this, so they take precedence.
  app.get("/*", async (_req, reply) => {
    const html = readFileSync(HTML_PATH, "utf8");
    reply.type("text/html").send(html);
  });

  // --- Login / logout (intentionally NOT behind requireAuth). ---
  app.post("/api/login", async (req, reply) => {
    // The UI routes share the webhook app, whose custom application/json parser
    // returns the RAW body string (so the webhook handler has bytes for HMAC).
    // So req.body may be a string here, not a parsed object — coerce either way.
    const password = readPassword(req.body);
    const secret = getSecret();
    if (!secret || !password || !verifyPassword(password, secret)) {
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
  const isConfigured = (): boolean => settingsStore.has("NOODLE_UI_PASSWORD");

  app.get("/api/setup/status", async () => {
    return {
      configured: isConfigured(),
      steps: {
        github: settingsStore.has("GITHUB_TOKEN") || settingsStore.has("GITHUB_APP_ID"),
        llm: profileStore.list().length > 0,
        ui: settingsStore.has("NOODLE_UI_PASSWORD"),
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
    if (parsed.uiPassword) values.NOODLE_UI_PASSWORD = parsed.uiPassword;
    // Seed a minimal global system prompt on first run. It states the agent's
    // role and defers approach + capability decisions to the live system info
    // (expanded from {system} at run time). The operator can edit/empty it later.
    if (!settingsStore.has("system_prompt")) {
      values.system_prompt = [
        "You are an autonomous software engineer working on a GitHub repository.",
        "Work from the issue or task you're given, and the system info below.",
        "Decide your own approach and which tools to use based on what this",
        "machine can actually do. Make the minimal change, verify it, and report",
        "what you did as your final message.",
        "",
        "{system}",
      ].join("\n");
    }
    // Seed sensible defaults for run timeouts, triggers, routing, and queue so a
    // fresh install is usable + self-documenting. The operator can edit any of
    // these from the Settings page later.
    if (!settingsStore.has("run_stall_timeout_minutes")) values.run_stall_timeout_minutes = "30";
    if (!settingsStore.has("run_tool_stall_minutes")) values.run_tool_stall_minutes = "60";
    if (!settingsStore.has("queue_concurrency")) values.queue_concurrency = "3";
    if (!settingsStore.has("queue_max_attempts")) values.queue_max_attempts = "5";
    if (!settingsStore.has("queue_retry_backoff_seconds")) values.queue_retry_backoff_seconds = "3";
    // Seed the default GitHub status labels so the Settings UI has values to
    // show/edit on a fresh install. Commands without custom labels inherit these.
    if (!settingsStore.has("labels")) values.labels = serializeLabelSet(defaultLabelSet());

    settingsStore.setMany(values);

    // Write the profile directly to the DB and set it as the default — no more
    // seed/next-boot indirection. The profile is immediately runnable.
    const profile = validateProfileInput({
      model: parsed.llm.model,
      base_url: parsed.llm.baseUrl,
      api: parsed.llm.api,
      api_key: parsed.llm.apiKey ?? "",
    });
    if ("error" in profile) {
      return reply.code(400).send({ error: profile.error });
    }
    if (!profileStore.has("default")) {
      profileStore.create("default", profile);
      config.profiles["default"] = profile;
      if (!settingsStore.has("default_profile")) {
        settingsStore.set("default_profile", "default");
        config.default_profile = "default";
      }
    }

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
    //
    // The run row doesn't record which command (if any) was used, so we don't
    // know the exact cooking-label name. Instead, fetch the issue's current
    // labels and remove ANY that matches a known cooking label: the global
    // default + every command's custom cooking label. This prevents a stale
    // command-specific cooking label from blocking all future runs.
    try {
      if (run.issue != null) {
        const instId = queue.getById(numericId).installation_id ?? undefined;
        const { gh } = await authProvider.forRepo(run.repo, instId);
        // Collect every possible "cooking" label name: the current global
        // default + each command's custom cooking override (if set).
        const cookingNames = new Set<string>([labelsFor(config.agent_name).cooking.name]);
        for (const cmd of commandStore.list()) {
          const cmdLabels = parseLabelSet(cmd.labels);
          if (cmdLabels) cookingNames.add(cmdLabels.cooking.name);
        }
        // Fetch the issue and remove any matching label.
        const issue = await gh.getIssue(run.repo, run.issue);
        const present = issue.labels.filter((l) => cookingNames.has(l));
        for (const label of present) {
          await gh.removeIssueLabel(run.repo, run.issue, label);
        }
      }
    } catch (e) {
      log.warn({ err: e, jobId: id }, "could not remove cooking label after cancel");
    }
    return { ok: true };
  });

  // --- System log (in-memory ring buffer; mirrors `docker logs`). Auth-guarded. ---
  // Returns the most recent captured log lines, newest-first by default. The
  // buffer is tee'd from pino's stdout destination (see util/log.ts), so this is
  // the same output `docker logs` shows — bounded to the last LOG_BUFFER_MAX
  // lines and cleared on each boot. Optional `?limit=N` caps the count; optional
  // `?level=warn` filters to that severity and above (trace<debug<info<warn<error<fatal).
  app.get("/api/logs", { preHandler: auth }, async (req) => {
    const q = req.query as { limit?: string; level?: string };
    let limit: number | undefined;
    if (q.limit) {
      const n = parseInt(q.limit, 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
    const entries = getRecentLogs(limit);
    const minLevel = LEVEL_ORDER[q.level?.toLowerCase() ?? ""] ?? 0;
    const filtered = minLevel > 0 ? entries.filter((e) => e.level >= minLevel) : entries;
    return { entries: filtered };
  });

  // Download all persistent log files (current + rotated) as a single text
  // file. Streams oldest-first so the most recent entries are at the bottom.
  app.get("/api/logs/download", { preHandler: auth }, async (_req, reply) => {
    if (!logDir) {
      return reply.code(503).send({ error: "Log file persistence is not enabled." });
    }
    // Collect log files: noodle.log.5, .4, .3, .2, .1, noodle.log (oldest first).
    const files: string[] = [];
    for (let i = 5; i >= 1; i--) {
      const p = join(logDir, `noodle.log.${i}`);
      if (existsSync(p)) files.push(p);
    }
    const active = join(logDir, "noodle.log");
    if (existsSync(active)) files.push(active);

    if (files.length === 0) {
      return reply.code(404).send({ error: "No log files found." });
    }

    // Stream all files concatenated via a composite readable.
    const streams = files.map((f) => createReadStream(f));
    const combined = Readable.from(
      (async function* () {
        for (const stream of streams) {
          for await (const chunk of stream) yield chunk;
        }
      })(),
    );

    reply.header("Content-Type", "text/plain; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="noodle-logs.txt"');
    return reply.send(combined);
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
    const items = stored.map(({ name, profile }) => ({ name, profile, source: "db" as const }));
    return {
      // Flat name list (kept for the cron dropdown's existing contract).
      profiles: Object.keys(config.profiles),
      default: config.default_profile,
      // Full-detail list for the profiles tab.
      items,
    };
  });

  app.post("/api/profiles", { preHandler: auth }, async (req, reply) => {
    const body = readJsonBody(req.body);
    if (!body) return reply.code(400).send({ error: "missing body" });
    const parsed = parseProfilePayload(body, /*creating*/ true);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const name = parsed.name!;
    if (profileStore.has(name)) {
      return reply.code(409).send({ error: `profile "${name}" already exists` });
    }
    const stored = profileStore.create(name, parsed.profile);
    // Live-sync into the in-memory config so the profile is runnable now.
    config.profiles[name] = parsed.profile;
    // If this is the first profile, set it as the default.
    if (!settingsStore.has("default_profile")) {
      settingsStore.set("default_profile", name);
      config.default_profile = name;
    }
    return { profile: toProfileDetail(stored, "db") };
  });

  /**
   * Fetch the model list an endpoint exposes — the OpenAI/NVIDIA-compatible
   * `GET {base_url}/models`. Used by the profile form to (a) populate the Model
   * dropdown and (b) verify a typed model id is one the endpoint actually
   * serves (the form's verify button turns green when `verified` is true).
   *
   * Takes base_url + api_key in the body so it works during profile creation,
   * before a profile is saved under a name. The api_key is optional — local
   * no-auth endpoints (Ollama) need no Bearer header.
   */
  app.post("/api/profiles/fetch-models", { preHandler: auth }, async (req, reply) => {
    const body = readJsonBody(req.body);
    if (!body) return reply.code(400).send({ error: "missing body" });
    const baseUrl = typeof body.base_url === "string" ? body.base_url.trim() : "";
    if (!baseUrl) return reply.code(400).send({ error: "base_url is required" });
    const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";

    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      return reply.code(400).send({
        error: `Could not reach ${url}: ${(e as Error).message}`,
        models: [], verified: false, found: false,
      });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const detail = text ? ` — ${text.slice(0, 200)}` : "";
      return reply.code(400).send({
        error: `Endpoint returned ${res.status} ${res.statusText}${detail}`,
        models: [], verified: false, found: false,
      });
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return reply.code(400).send({
        error: "Endpoint did not return JSON.",
        models: [], verified: false, found: false,
      });
    }

    // OpenAI/NVIDIA shape: { data: [{ id }, ...] }. Fall back to { models: [{ id }] }.
    const ids = extractModelIds(json);
    if (ids == null) {
      return reply.code(400).send({
        error: "Endpoint did not return a recognizable model list.",
        models: [], verified: false, found: false,
      });
    }

    const models = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    const verified = !!model && models.includes(model);
    return { models, verified, found: models.length > 0 };
  });

  /**
   * Send a minimal completion request to the endpoint to verify the model is
   * actually usable — reachable URL, valid key, and a model id the endpoint
   * will serve. This is a stronger check than fetch-models' list-membership:
   * some endpoints return a model in /models but reject it on a real call.
   *
   * Builds the request per `api` protocol. Returns ok on any 2xx; surfaces the
   * provider's error status + a trimmed body excerpt otherwise.
   */
  app.post("/api/profiles/test-model", { preHandler: auth }, async (req, reply) => {
    const body = readJsonBody(req.body);
    if (!body) return reply.code(400).send({ error: "missing body" });
    const baseUrl = typeof body.base_url === "string" ? body.base_url.trim() : "";
    if (!baseUrl) return reply.code(400).send({ error: "base_url is required" });
    const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model) return reply.code(400).send({ error: "model is required" });
    const api = typeof body.api === "string" ? body.api : "openai-completions";

    const reqDef = buildTestRequest(api, baseUrl, model, apiKey);

    let res: Response;
    try {
      res = await fetch(reqDef.url, {
        method: "POST",
        headers: reqDef.headers,
        body: JSON.stringify(reqDef.body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      return reply.code(400).send({
        ok: false,
        error: `Could not reach ${reqDef.url}: ${(e as Error).message}`,
      });
    }

    if (res.ok) return { ok: true, status: res.status };

    const text = await res.text().catch(() => "");
    const detail = text ? ` — ${text.slice(0, 300)}` : "";
    return reply.code(400).send({
      ok: false,
      status: res.status,
      error: `Endpoint returned ${res.status} ${res.statusText}${detail}`,
    });
  });

  app.get("/api/profiles/:name", { preHandler: auth }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!profileStore.has(name)) {
      return reply.code(404).send({ error: `profile "${name}" not found` });
    }
    return { profile: toProfileDetail(profileStore.get(name), "db") };
  });

  app.patch("/api/profiles/:name", { preHandler: auth }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const body = readJsonBody(req.body);
    if (!body) return reply.code(400).send({ error: "missing body" });
    const parsed = parseProfilePayload(body, /*creating*/ false);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const newName = parsed.name ?? name;

    if (!profileStore.has(name)) {
      return reply.code(404).send({ error: `profile "${name}" not found` });
    }
    if (newName !== name && profileStore.has(newName)) {
      return reply.code(409).send({ error: `profile "${newName}" already exists` });
    }

    if (newName !== name) {
      profileStore.rename(name, newName);
      delete config.profiles[name];
    }
    const stored = profileStore.update(newName, parsed.profile);
    config.profiles[stored.name] = parsed.profile;
    return { profile: toProfileDetail(stored, "db") };
  });

  app.delete("/api/profiles/:name", { preHandler: auth }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!profileStore.has(name)) {
      return reply.code(404).send({ error: `profile "${name}" not found` });
    }
    profileStore.delete(name);
    delete config.profiles[name];
    // If we deleted the default profile, clear or reassign the default.
    if (config.default_profile === name) {
      const remaining = profileStore.list();
      if (remaining.length > 0) {
        settingsStore.set("default_profile", remaining[0].name);
        config.default_profile = remaining[0].name;
      } else {
        settingsStore.set("default_profile", "");
        config.default_profile = undefined;
      }
    }
    return { ok: true };
  });

  /**
   * Set a profile as the default (the fallback when no routing rule matches).
   * Since `default_profile` is a single key, setting one replaces any previous
   * default — exactly one profile is the default at any time.
   */
  app.post("/api/profiles/:name/default", { preHandler: auth }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!profileStore.has(name)) {
      return reply.code(404).send({ error: `profile "${name}" not found` });
    }
    settingsStore.set("default_profile", name);
    config.default_profile = name;
    return { ok: true, default: name };
  });

  // --- Skills (filesystem-backed). The store reads/writes skills/<name>/SKILL.md
  // from the same directory `installSkills()` copies into agent workspaces, so UI
  // edits land in front of the agent on the next run with no engine change. ---

  app.get("/api/skills", { preHandler: auth }, async () => {
    return { skills: skillStore.list() };
  });

  app.get("/api/skills/:name", { preHandler: auth }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!skillStore.has(name)) {
      return reply.code(404).send({ error: `skill "${name}" not found` });
    }
    return { skill: skillStore.get(name) };
  });

  app.post("/api/skills", { preHandler: auth }, async (req, reply) => {
    const body = readJsonBody(req.body);
    const parsed = parseSkillInput(body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    if (skillStore.has(parsed.input.name)) {
      return reply.code(409).send({ error: `skill "${parsed.input.name}" already exists` });
    }
    try {
      return { skill: skillStore.create(parsed.input) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.patch("/api/skills/:name", { preHandler: auth }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const body = readJsonBody(req.body);
    const parsed = parseSkillUpdate(body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    if (!skillStore.has(name)) {
      return reply.code(404).send({ error: `skill "${name}" not found` });
    }
    const newName = parsed.input.name;
    if (newName !== undefined && newName !== name && skillStore.has(newName)) {
      return reply.code(409).send({ error: `skill "${newName}" already exists` });
    }
    try {
      return { skill: skillStore.update(name, parsed.input) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.delete("/api/skills/:name", { preHandler: auth }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!skillStore.has(name)) {
      return reply.code(404).send({ error: `skill "${name}" not found` });
    }
    try {
      skillStore.delete(name);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return { ok: true };
  });

  // --- Commands (DB-backed). Each is a slash command (`/<trigger>`) that wakes
  // the agent with its own system_prompt (with {system}/{pr}/{issue} tag
  // expansion). The seeded built-in (/<agent>) is not deletable. ---

  app.get("/api/commands", { preHandler: auth }, async () => {
    return { commands: commandStore.list() };
  });

  app.get("/api/commands/:id", { preHandler: auth }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: "invalid id" });
    try {
      return { command: commandStore.get(id) };
    } catch {
      return reply.code(404).send({ error: `command ${id} not found` });
    }
  });

  app.post("/api/commands", { preHandler: auth }, async (req, reply) => {
    const body = readJsonBody(req.body);
    const parsed = parseCommandInput(body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    try {
      return { command: commandStore.create(parsed.input) };
    } catch (e) {
      // UNIQUE constraint on trigger → duplicate.
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.patch("/api/commands/:id", { preHandler: auth }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: "invalid id" });
    const body = readJsonBody(req.body);
    const parsed = parseCommandUpdate(body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    try {
      return { command: commandStore.update(id, parsed.input) };
    } catch (e) {
      const msg = (e as Error).message;
      if (/not found/i.test(msg)) return reply.code(404).send({ error: msg });
      if (/unique|already exist/i.test(msg)) return reply.code(409).send({ error: msg });
      return reply.code(400).send({ error: msg });
    }
  });

  app.delete("/api/commands/:id", { preHandler: auth }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: "invalid id" });
    try {
      commandStore.delete(id);
    } catch (e) {
      const msg = (e as Error).message;
      if (/builtin/i.test(msg)) return reply.code(403).send({ error: msg });
      return reply.code(404).send({ error: msg });
    }
    return { ok: true };
  });

  // --- GitHub repo + branch listing (for the cron form's autocomplete).
  // Both return { repos: [] } / { branches: [] } on any error so the form
  // always degrades gracefully to free-text input. ---

  app.get("/api/github/repos", { preHandler: auth }, async (_req, reply) => {
    try {
      // PAT mode ignores the repo arg; App mode needs an installation on a real
      // repo to resolve — if it fails, we catch and return an empty list.
      const { gh } = await authProvider.forRepo("a/a");
      const repos = await gh.listRepos();
      return { repos };
    } catch {
      return reply.code(200).send({ repos: [] });
    }
  });

  app.get("/api/github/repos/:owner/:name/branches", { preHandler: auth }, async (req, reply) => {
    const { owner, name } = req.params as { owner: string; name: string };
    try {
      const { gh } = await authProvider.forRepo(`${owner}/${name}`);
      const branches = await gh.listBranches(`${owner}/${name}`);
      return { branches };
    } catch {
      return reply.code(200).send({ branches: [] });
    }
  });

  // --- GitHub App creation via manifest flow. ---
  // `POST /api/github/create-app` generates a manifest URL and redirects the
  // operator to GitHub. GitHub shows a pre-filled App creation form; on confirm
  // it redirects to `GET /api/github/app-callback` with a one-time code that
  // Noodle exchanges for the App credentials (ID, private key, webhook secret).

  app.post("/api/github/create-app", { preHandler: auth }, async (req, reply) => {
    const body = readJsonBody(req.body);
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      return reply.code(400).send({ error: "name is required" });
    }
    if (typeof body.url !== "string" || !body.url.trim()) {
      return reply.code(400).send({ error: "url is required" });
    }
    // Prefer the operator-configured public URL (NOODLE_PUBLIC_URL) — this is
    // where GitHub must reach Noodle for webhook delivery. Fall back to the
    // browser's `window.location.origin` when unset. The browser origin can be
    // the string "null" (sandboxed iframes / file: / data:) or a localhost
    // address when developing locally — both rejected below with a clear error.
    const publicUrlSetting = settingsStore.get("NOODLE_PUBLIC_URL");
    const urlSource = publicUrlSetting && publicUrlSetting.trim()
      ? publicUrlSetting.trim()
      : body.url.trim();
    // Validate it's a real http(s) URL with a host.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlSource);
    } catch {
      return reply.code(400).send({ error: `"${urlSource}" is not a valid URL. ${publicUrlSetting ? "Fix the Public URL in Settings, or " : ""}open Noodle via its http(s) address (e.g. https://noodle.example.com).` });
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return reply.code(400).send({ error: `URL must use http or https (got "${parsedUrl.protocol}").` });
    }
    // GitHub Apps require a webhook URL reachable from GitHub's servers over
    // the public Internet. localhost / 127.0.0.1 / private IPs all fail this —
    // GitHub refuses to create the App with "Hook url is not supported because
    // it isn't reachable over the public Internet (localhost)". Catch it here.
    const host = parsedUrl.hostname.toLowerCase();
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    const isPrivateIp = /^(10\.|192\.168\.|169\.254\.|127\.)|^(172\.(1[6-9]|2\d|3[01])\.)/.test(host);
    if (isLoopback || isPrivateIp) {
      return reply.code(400).send({
        error: `GitHub Apps need a webhook URL reachable from the public Internet, but "${host}" is not publicly routable. Set the Public URL above to a tunnel (e.g. https://abc.ngrok.io) or your public host/IP, then try again. Or for local-only dev, use a Personal Access Token below instead.`,
      });
    }
    const name = body.name.trim();
    // Reconstruct from protocol + host so any path/query is dropped and the
    // origin is normalized. Works behind reverse proxies.
    const base = `${parsedUrl.protocol}//${parsedUrl.host}`;

    // Generate a CSRF state token and store it temporarily.
    const state = randomBytes(24).toString("hex");
    settingsStore.set("GITHUB_APP_SETUP_STATE", state);

    const callbackUrl = `${base}/api/github/app-callback`;
    const manifest = {
      name,
      url: base,
      hook_attributes: { url: `${base}/webhook` },
      redirect_url: callbackUrl,
      callback_urls: [callbackUrl],
      public: false,
      setup_url: `${base}/setup`,
      default_permissions: {
        issues: "write",
        pull_requests: "write",
        contents: "write",
        metadata: "read",
      },
      default_events: ["issues", "issue_comment", "pull_request"],
    };

    // Return the manifest so the frontend can POST it to GitHub via a hidden form.
    return { manifest, state };
  });

  /**
   * GitHub redirects here after the operator creates the App. The `code` is a
   * one-time token that we exchange for the App's credentials (ID, PEM private
   * key, webhook secret) via GitHub's manifest conversion endpoint.
   */
  app.get("/api/github/app-callback", async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code) {
      return reply.code(400).send({ error: "missing code parameter" });
    }
    // Verify the CSRF state token.
    const expectedState = settingsStore.get("GITHUB_APP_SETUP_STATE");
    if (!expectedState || state !== expectedState) {
      reply.type("text/html");
      return reply.code(403).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Setup Error</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0d1117; color: #e6edf3; }
  .card { text-align: center; padding: 2.5rem 3rem; background: #161b22; border: 1px solid #30363d; border-radius: 12px; max-width: 400px; }
  .check { font-size: 3rem; margin-bottom: 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { color: #8b949e; font-size: 0.875rem; line-height: 1.5; }
</style></head><body>
<div class="card">
  <div class="check">⚠️</div>
  <h1>Invalid or Expired Link</h1>
  <p>This setup link is no longer valid. Please go back to Noodle Settings and try again.</p>
</div>
</body></html>`);
    }
    settingsStore.set("GITHUB_APP_SETUP_STATE", ""); // delete

    // Exchange the code for App credentials.
    try {
      const resp = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!resp.ok) {
        const text = await resp.text();
        log.error({ status: resp.status, body: text }, "GitHub manifest conversion failed");
        reply.type("text/html");
        return reply.code(502).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Setup Error</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0d1117; color: #e6edf3; }
  .card { text-align: center; padding: 2.5rem 3rem; background: #161b22; border: 1px solid #30363d; border-radius: 12px; max-width: 400px; }
  .check { font-size: 3rem; margin-bottom: 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { color: #8b949e; font-size: 0.875rem; line-height: 1.5; }
</style></head><body>
<div class="card">
  <div class="check">❌</div>
  <h1>GitHub Returned an Error</h1>
  <p>Could not complete the App creation. Check the Noodle logs for details, then try again.</p>
</div>
</body></html>`);
      }
      const data = await resp.json() as {
        id: number;
        slug: string;
        name: string;
        client_id: string;
        client_secret: string;
        webhook_secret: string;
        pem: string;
      };

      // Persist the credentials. The slug is the bot's GitHub username
      // (e.g. "my-repo-bot"), which becomes the agent login.
      settingsStore.setMany({
        GITHUB_APP_ID: String(data.id),
        GITHUB_PRIVATE_KEY: data.pem,
        GITHUB_WEBHOOK_SECRET: data.webhook_secret,
        NOODLE_LOGIN: `${data.slug}[bot]`,
        // Clear any PAT — App mode takes precedence.
        GITHUB_TOKEN: "",
      });

      log.info({ appId: data.id, slug: data.slug }, "GitHub App created via manifest flow");
      // Show a self-contained success page (opened in a new tab by the Settings UI).
      reply.type("text/html");
      return reply.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>GitHub App Connected</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0d1117; color: #e6edf3; }
  .card { text-align: center; padding: 2.5rem 3rem; background: #161b22; border: 1px solid #30363d; border-radius: 12px; max-width: 400px; }
  .check { font-size: 3rem; margin-bottom: 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { color: #8b949e; font-size: 0.875rem; line-height: 1.5; margin: 0 0 1.5rem; }
  .hint { font-size: 0.75rem; color: #484f58; }
</style></head><body>
<div class="card">
  <div class="check">✅</div>
  <h1>GitHub App Connected</h1>
  <p><strong>${data.name}</strong> (ID: ${data.id}) has been created and configured.</p>
  <p>You can close this tab and restart Noodle to apply.</p>
  <p class="hint">This tab will close automatically in 5 seconds.</p>
</div>
<script>setTimeout(() => window.close(), 5000)</script>
</body></html>`);
    } catch (e) {
      log.error({ err: e }, "Failed to exchange GitHub App manifest code");
      reply.type("text/html");
      return reply.code(502).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Setup Error</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0d1117; color: #e6edf3; }
  .card { text-align: center; padding: 2.5rem 3rem; background: #161b22; border: 1px solid #30363d; border-radius: 12px; max-width: 400px; }
  .check { font-size: 3rem; margin-bottom: 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { color: #8b949e; font-size: 0.875rem; line-height: 1.5; }
</style></head><body>
<div class="card">
  <div class="check">❌</div>
  <h1>Connection Failed</h1>
  <p>Could not reach GitHub to complete the setup. Check the Noodle logs and your network, then try again.</p>
</div>
</body></html>`);
    }
  });

  app.get("/api/schedulers", { preHandler: auth }, async () => {
    return { schedulers: schedulerStore.listSchedulers() };
  });

  app.post("/api/schedulers", { preHandler: auth }, async (req, reply) => {
    const body = readJsonBody(req.body);
    const parsed = parseSchedulerInput(body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    try {
      const scheduler = schedulerStore.createScheduler(parsed);
      return { scheduler: scheduler };
    } catch (e) {
      return reply.code(400).send({ error: `Invalid cron expression: ${(e as Error).message}` });
    }
  });

  app.get("/api/schedulers/:id", { preHandler: auth }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: "invalid id" });
    try {
      const scheduler = schedulerStore.getScheduler(id);
      const runs = runStore.listRunsForCron(id, 20);
      return { scheduler, runs };
    } catch {
      return reply.code(404).send({ error: "scheduler not found" });
    }
  });

  app.patch("/api/schedulers/:id", { preHandler: auth }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: "invalid id" });
    const body = readJsonBody(req.body);
    const parsed = parseSchedulerUpdate(body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    try {
      // Validate a changed cron expression before persisting.
      if (parsed.cron_expression !== undefined) {
        SchedulerStore.nextRunFromExpr(parsed.cron_expression);
      }
      const scheduler = schedulerStore.updateScheduler(id, parsed);
      return { scheduler: scheduler };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (/not found/.test(msg)) return reply.code(404).send({ error: msg });
      return reply.code(400).send({ error: `Invalid cron expression: ${msg}` });
    }
  });

  app.delete("/api/schedulers/:id", { preHandler: auth }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: "invalid id" });
    try {
      schedulerStore.getScheduler(id);
    } catch {
      return reply.code(404).send({ error: "scheduler not found" });
    }
    schedulerStore.deleteScheduler(id);
    return { ok: true };
  });

  /** Trigger a cron job immediately (enqueue now, bypassing its schedule). */
  app.post("/api/schedulers/:id/run", { preHandler: auth }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: "invalid id" });
    let scheduler;
    try {
      scheduler = schedulerStore.getScheduler(id);
    } catch {
      return reply.code(404).send({ error: "scheduler not found" });
    }
    // No installation-id resolution here — the worker resolves it from the repo
    // name when the job runs (forRepo auto-resolves in App mode).
    queue.enqueueCron({
      repo: scheduler.repo,
      cronJobId: scheduler.id,
      profile: scheduler.profile ?? config.default_profile,
      source: "manual",
    });
    // Trigger the dispatcher so the manual run starts immediately.
    dispatch?.();
    return { ok: true };
  });

  // --- Event-driven triggers (all auth-guarded). ---
  // Triggers are DB-defined event-driven agent runs that open issues (see trigger-store.ts).
  // These routes are the backend for the "Triggers" section of the web UI.

  app.get("/api/triggers", { preHandler: auth }, async () => {
    return { triggers: triggerStore.listTriggers() };
  });

  app.post("/api/triggers", { preHandler: auth }, async (req, reply) => {
    const body = readJsonBody(req.body);
    const parsed = parseTriggerInput(body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    try {
      const trigger = triggerStore.createTrigger(parsed);
      return { trigger };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get("/api/triggers/:id", { preHandler: auth }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: "invalid id" });
    try {
      const trigger = triggerStore.getTrigger(id);
      const runs = runStore.listRunsForTrigger(id, 20);
      return { trigger, runs };
    } catch {
      return reply.code(404).send({ error: "trigger not found" });
    }
  });

  app.patch("/api/triggers/:id", { preHandler: auth }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: "invalid id" });
    const body = readJsonBody(req.body);
    const parsed = parseTriggerUpdate(body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    try {
      const trigger = triggerStore.updateTrigger(id, parsed);
      return { trigger };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (/not found/.test(msg)) return reply.code(404).send({ error: msg });
      return reply.code(400).send({ error: msg });
    }
  });

  app.delete("/api/triggers/:id", { preHandler: auth }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: "invalid id" });
    try {
      triggerStore.getTrigger(id);
    } catch {
      return reply.code(404).send({ error: "trigger not found" });
    }
    triggerStore.deleteTrigger(id);
    return { ok: true };
  });

  /** Trigger a trigger job immediately (manual run, simulating the event). */
  app.post("/api/triggers/:id/run", { preHandler: auth }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: "invalid id" });
    let trigger;
    try {
      trigger = triggerStore.getTrigger(id);
    } catch {
      return reply.code(404).send({ error: "trigger not found" });
    }
    queue.enqueueTrigger({
      repo: trigger.repo,
      triggerId: trigger.id,
      profile: trigger.profile ?? config.default_profile,
      source: "manual",
    });
    triggerStore.markTriggered(trigger.id);
    dispatch?.();
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

    // Re-overlay the LIVE-able fields onto the shared `config` reference so they
    // take effect immediately (no restart). These are read fresh by runJob,
    // resolveProfile, the webhook handler (via getters), and label generation.
    // The two queue retry knobs resolve via getters at dispatch time, so a change
    // here applies to the next job failure. (Per-profile concurrency is set on
    // the Profiles page — each profile's max_concurrent — not here.)
    const tom = settingsStore.get("trigger_on_mention");
    if (tom != null) config.triggers.trigger_on_mention = tom === "true";
    const too = settingsStore.get("trigger_on_open");
    if (too != null) config.triggers.trigger_on_open = too === "true";
    const tkw = settingsStore.get("trigger_keywords");
    if (tkw) { try { config.triggers.trigger_keywords = JSON.parse(tkw); } catch { /* leave */ } }
    const rt = settingsStore.get("routing");
    if (rt) { try { config.routing = JSON.parse(rt); } catch { /* leave */ } }
    const qMax = settingsStore.get("queue_max_attempts");
    if (qMax) { const n = parseInt(qMax, 10); if (n) config.queue.max_attempts = n; }
    const qBackoff = settingsStore.get("queue_retry_backoff_seconds");
    if (qBackoff) { const n = parseInt(qBackoff, 10); if (n) config.queue.retry_backoff_seconds = n; }

    return {
      ok: true,
      // Tell the UI whether any of the writes need a restart to take effect.
      // No field in the catalog requires a restart anymore — all live-reload.
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

/**
 * Pull model ids out of a provider's `/models` response. Returns the id list,
 * or null when the shape is unrecognized. Accepts both the OpenAI/NVIDIA shape
 * `{ data: [{ id }] }` and the `{ models: [{ id }] }` some providers use; each
 * entry may also be a bare string.
 */
function extractModelIds(json: unknown): string[] | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const arr = Array.isArray(obj.data) ? obj.data
    : Array.isArray(obj.models) ? obj.models
    : null;
  if (!arr) return null;
  const ids: string[] = [];
  for (const entry of arr) {
    if (typeof entry === "string") {
      if (entry) ids.push(entry);
    } else if (entry && typeof entry === "object") {
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === "string" && id) ids.push(id);
    }
  }
  return ids;
}

/** The wire-protocol enum from schema.ts. Mirrored here as a narrow type so this
 *  helper doesn't need the full Profile import for one switch. */
type WireApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "mistral-conversations";

interface TestRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Build a minimal "does this model work" completion request for a protocol.
 * Each uses the smallest possible payload (max_tokens 1, a trivial prompt) so
 * the ping costs ~1 token and returns fast. Unknown protocols fall back to the
 * OpenAI-compatible shape, which is the most common.
 */
function buildTestRequest(api: string, baseUrl: string, model: string, apiKey: string): TestRequest {
  const root = baseUrl.replace(/\/+$/, "");
  switch (api as WireApi) {
    case "openai-responses":
      // OpenAI's Responses API: POST /responses, body uses `input` not `messages`.
      return {
        url: `${root}/responses`,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: { model, input: "hi", max_output_tokens: 1 },
      };
    case "anthropic-messages":
      return {
        url: `${root}/v1/messages`,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
      };
    case "google-generative-ai":
      // Key travels as a query param for Google's Generative AI endpoint.
      return {
        url: `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        headers: { "Content-Type": "application/json" },
        body: { contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 1 } },
      };
    case "mistral-conversations":
    case "openai-completions":
    default:
      // OpenAI-compatible (Ollama, vLLM, DeepSeek, NVIDIA NIM, Mistral, …):
      // Bearer key, /chat/completions. Mistral uses the same shape.
      return {
        url: `${root}/v1/chat/completions`,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
      };
  }
}

/** Validate a trigger create payload. Returns the typed input or { error }. */
function parseTriggerInput(body: Record<string, unknown> | null): NewTrigger | { error: string } {
  if (!body) return { error: "missing body" };
  const name = strField(body, "name");
  const repo = strField(body, "repo");
  const event_type = strField(body, "event_type");
  const prompt = strField(body, "prompt");
  const branch_name = strField(body, "branch_name") || "noodle/trigger";
  if (!name || !repo || !event_type || !prompt) {
    return { error: "name, repo, event_type, and prompt are required" };
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { error: `repo "${repo}" is not a valid "owner/name"` };
  }
  const VALID_EVENTS = ["issues", "pull_request", "push", "issue_comment"];
  if (!VALID_EVENTS.includes(event_type)) {
    return { error: `event_type must be one of: ${VALID_EVENTS.join(", ")}` };
  }
  const profile = body.profile === null || body.profile === undefined ? null : strField(body, "profile");
  const event_action = body.event_action === null || body.event_action === undefined ? null : strField(body, "event_action");
  const branch_pattern = body.branch_pattern === null || body.branch_pattern === undefined ? null : strField(body, "branch_pattern");
  const label = body.label === null || body.label === undefined ? null : strField(body, "label");
  return { name, repo, event_type, event_action, branch_pattern, prompt, profile, branch_name, label, enabled: 1 };
}

/** Validate a trigger update payload (all fields optional). Returns the typed update or { error }. */
function parseTriggerUpdate(body: Record<string, unknown> | null): TriggerUpdate | { error: string } {
  if (!body) return { error: "missing body" };
  const out: TriggerUpdate = {};
  for (const key of ["name", "repo", "event_type", "event_action", "branch_pattern", "prompt", "profile", "branch_name", "label"] as const) {
    const v = strField(body, key);
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  // Handle null values for optional fields.
  if (body.event_action === null) out.event_action = null;
  if (body.branch_pattern === null) out.branch_pattern = null;
  if (body.profile === null) out.profile = null;
  if (body.label === null) out.label = null;
  if (body.enabled !== undefined) {
    out.enabled = body.enabled ? 1 : 0;
  }
  return out;
}

/** Validate a cron create payload. Returns the typed input or { error }. */
function parseSchedulerInput(body: Record<string, unknown> | null): NewSchedulerJob | { error: string } {
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
  const labels = labelsField(body, "labels");
  return { name, repo, prompt, branch_name, cron_expression, profile, labels, enabled: 1 };
}

/** Validate a cron update payload (all fields optional). Returns the typed update or { error }. */
function parseSchedulerUpdate(body: Record<string, unknown> | null): SchedulerUpdate | { error: string } {
  if (!body) return { error: "missing body" };
  const out: SchedulerUpdate = {};
  for (const key of ["name", "repo", "prompt", "branch_name", "cron_expression", "profile"] as const) {
    const v = strField(body, key === "branch_name" ? "branch_name" : key);
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  if (body.labels !== undefined) {
    out.labels = labelsField(body, "labels");
  }
  if (body.enabled !== undefined) {
    out.enabled = body.enabled ? 1 : 0;
  }
  return out;
}

/**
 * Parse a labels field: accepts a non-empty JSON string or null, returns null
 * for absent/empty/non-string. The JSON content itself is validated later by
 * parseLabelSet at apply time. (Used by both cron create + update.)
 */
function labelsField(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  if (typeof v !== "string") return null;
  return v.trim() || null;
}

/** Coerce a body field to a trimmed string, or undefined when absent/empty. */
function strField(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" ? v.trim() || undefined : undefined;
}

/**
 * Validate a skill create payload. Name, description, and body are all
 * required. Mirrors the cron split: a separate `parseSkillUpdate` handles
 * PATCH. Returns a discriminated union.
 */
function parseSkillInput(
  body: Record<string, unknown> | null,
): { ok: true; input: SkillInput } | { ok: false; error: string } {
  if (!body) return { ok: false, error: "missing body" };
  const name = strField(body, "name");
  if (!name) return { ok: false, error: "name is required" };
  const description = strField(body, "description");
  if (description === undefined) return { ok: false, error: "description is required" };
  if (typeof body.body !== "string") return { ok: false, error: "body is required" };
  return { ok: true, input: { name, description, body: body.body } };
}

/**
 * Validate a skill update payload. All fields optional (omitted ⇒ keep
 * existing). Used by PATCH /api/skills/:name.
 */
function parseSkillUpdate(
  body: Record<string, unknown> | null,
): { ok: true; input: SkillUpdate } | { ok: false; error: string } {
  if (!body) return { ok: false, error: "missing body" };
  const input: SkillUpdate = {};
  const name = strField(body, "name");
  if (name !== undefined) input.name = name;
  const description = strField(body, "description");
  if (description !== undefined) input.description = description;
  if (typeof body.body === "string") input.body = body.body;
  return { ok: true, input };
}

/**
 * Validate a command create payload. Trigger (normalized: lowercased, leading
 * slashes stripped) + name are required. Mirrors the cron split: a separate
 * `parseCommandUpdate` handles PATCH.
 */
function parseCommandInput(
  body: Record<string, unknown> | null,
): { ok: true; input: NewCommand } | { ok: false; error: string } {
  if (!body) return { ok: false, error: "missing body" };
  const rawTrigger = strField(body, "trigger");
  if (!rawTrigger) return { ok: false, error: "trigger is required" };
  const trigger = normalizeTrigger(rawTrigger);
  if (!trigger) return { ok: false, error: "trigger is required" };
  const { fields, error } = commandOptionalFields(body);
  if (error) return { ok: false, error };
  return { ok: true, input: { trigger, ...fields } };
}

/**
 * Validate a command update payload. All fields optional (omitted ⇒ keep
 * existing). Used by PATCH /api/commands/:id.
 */
function parseCommandUpdate(
  body: Record<string, unknown> | null,
): { ok: true; input: CommandUpdate } | { ok: false; error: string } {
  if (!body) return { ok: false, error: "missing body" };
  const input: CommandUpdate = {};
  const rawTrigger = strField(body, "trigger");
  if (rawTrigger !== undefined) {
    const trigger = normalizeTrigger(rawTrigger);
    if (!trigger) return { ok: false, error: "trigger cannot be empty" };
    input.trigger = trigger;
  }
  const { fields, error } = commandOptionalFields(body);
  if (error) return { ok: false, error };
  Object.assign(input, fields);
  return { ok: true, input };
}

/**
 * Extract the optional command fields (description, system_prompt, profile,
 * runtime, enabled, labels). Returns an `error` string when the `labels` shape
 * is invalid; the caller surfaces it as a 400.
 */
function commandOptionalFields(body: Record<string, unknown>): { fields: Partial<NewCommand>; error?: string } {
  const out: Partial<NewCommand> = {};
  const description = strField(body, "description");
  if (description !== undefined) out.description = description;
  const systemPrompt = strField(body, "system_prompt");
  if (systemPrompt !== undefined) out.system_prompt = systemPrompt;
  // profile: null or a non-empty string. Explicit null clears the pin.
  if (body.profile === null) out.profile = null;
  else if (typeof body.profile === "string" && body.profile.trim()) out.profile = body.profile.trim();
  // runtime: null or a string.
  if (body.runtime === null) out.runtime = null;
  else if (typeof body.runtime === "string") out.runtime = body.runtime.trim() || null;
  // enabled: 0 | 1.
  if (body.enabled !== undefined) out.enabled = body.enabled ? 1 : 0;
  // labels: null (clear → use global defaults) or a valid 3-stage label-set.
  // Accept either a JSON string or a parsed object; normalize to a JSON string.
  if (body.labels === null) {
    out.labels = null;
  } else if (body.labels !== undefined) {
    const rawStr = typeof body.labels === "string" ? body.labels : JSON.stringify(body.labels);
    if (parseLabelSet(rawStr) === null) {
      return { fields: out, error: "labels must be a valid set {cooking,cooked,failed} each {name,color} with a 6-char hex color" };
    }
    out.labels = rawStr;
  }
  return { fields: out };
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
    model: string;
    apiKey?: string;
    baseUrl: string;
    api: string;
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
  const model = strField(llm, "model");
  if (!model) return { error: "llm.model is required" };
  const baseUrl = strField(llm, "baseUrl");
  const api = strField(llm, "api");
  if (!baseUrl) return { error: "llm.baseUrl is required" };
  if (!api) return { error: "llm.api is required" };

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
      model,
      apiKey: strField(llm, "apiKey"),
      baseUrl,
      api,
    },
    uiPassword,
  };
}
