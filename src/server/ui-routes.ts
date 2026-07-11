import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RunStore } from "./run-store.js";
import type { JobQueue } from "./queue.js";
import { CronStore } from "./cron-store.js";
import type { NewCron, CronUpdate } from "./cron-store.js";
import type { AuthProvider } from "../github/auth-provider.js";
import type { NoodleConfig } from "../config/schema.js";
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
  /** Resolved config — for the profile-name dropdown + default profile. */
  config: NoodleConfig;
}

export function registerUiRoutes(app: FastifyInstance, deps: UiDeps): void {
  const { runStore, secret, queue, authProvider, agentName, cronStore, config } = deps;

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

  /** Profile names available for the create/edit dropdown. */
  app.get("/api/profiles", { preHandler: auth }, async () => {
    return { profiles: Object.keys(config.profiles), default: config.default_profile };
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
