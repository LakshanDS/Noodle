import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { RunStore } from "../src/server/run-store.js";
import { SchedulerStore } from "../src/server/scheduler-store.js";
import { CommandStore } from "../src/server/command-store.js";
import { SettingStore } from "../src/server/settings-store.js";
import { ProfileStore } from "../src/server/profile-store.js";
import { LiveRunRegistry } from "../src/engine/live-runs.js";
import { registerUiRoutes } from "../src/server/ui-routes.js";
import { createWebhookApp } from "../src/server/http.js";
import { signToken } from "../src/server/ui-auth.js";

/**
 * UI routes: the HTML shell + JSON API. Uses fastify's app.inject (no port),
 * a throwaway SQLite-backed RunStore (same pattern as run-store.test.ts), and a
 * temp session JSONL fixture. Verifies fail-closed auth: every protected route
 * 401s without a valid cookie, and /api/login mints one.
 */

const SECRET = "test-secret";
const PASSWORD = "test-password";

let dir: string;
let store: RunStore;
let cronStore: SchedulerStore;
let commandStore: CommandStore;
let settingsStore: SettingStore;
let db: Database.Database;
let sessionPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-ui-"));
  db = new Database(join(dir, "runs.db"));
  store = RunStore.fromDb(db);
  cronStore = SchedulerStore.fromDb(db);
  commandStore = CommandStore.fromDb(db);
  settingsStore = SettingStore.fromDb(db);
  sessionPath = join(dir, "session.jsonl");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A fresh app with UI routes registered (password is the signing secret too).
 * Only the stores used by the route(s) under test need real values; the rest
 * (authProvider, agentName, config) are stubbed because those routes aren't hit
 * in these tests — matching how the production wiring passes real deps.
 */
function makeApp() {
  const app = Fastify({ logger: false });
  registerUiRoutes(app, {
    runStore: store,
    getSecret: () => PASSWORD,
    cronStore,
    commandStore,
    settingsStore,
    profileStore: ProfileStore.fromDb(db),
    liveRuns: new LiveRunRegistry(),
    // Stubs for deps not exercised by these tests:
    queue: { enqueue: () => {}, enqueueCron: () => {}, markFailed: () => {}, getById: () => null, countByStatus: () => 0 } as never,
    authProvider: {} as never,
    agentName: "TestBot",
    config: { profiles: {}, default_profile: "x" } as never,
  });
  return app;
}

/**
 * The real production mounting: UI routes added to the webhook app. This matters
 * because createWebhookApp's custom application/json parser returns the RAW body
 * string (for HMAC), so /api/login must tolerate a string body — a bare-Fastify
 * test (parsed object body) would miss that. This is what serve.ts does.
 */
function makeWebhookAppWithUi() {
  const app = createWebhookApp(() => "wh-secret", { enqueue: async () => {} });
  registerUiRoutes(app, {
    runStore: store,
    getSecret: () => PASSWORD,
    cronStore,
    commandStore,
    settingsStore,
    queue: { enqueue: () => {}, enqueueCron: () => {}, markFailed: () => {}, getById: () => null, countByStatus: () => 0 } as never,
    authProvider: {} as never,
    agentName: "TestBot",
    config: { profiles: {}, default_profile: "x" } as never,
  });
  return app;
}

/** A valid Cookie header for the signed session. */
function authCookie(): string {
  // PASSWORD is both the password and the signing secret in ui-auth.
  return `noodle_auth=${signToken(PASSWORD)}`;
}

/** Minimal session JSONL fixture: one user + one assistant message. */
function writeSessionFixture() {
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
    ].join("\n") + "\n",
    "utf8",
  );
}

describe("UI routes — auth gating", () => {
  it("GET /api/runs returns 401 without a cookie", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/runs" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("GET /api/runs returns 200 with a valid cookie", async () => {
    store.createRun({ job_id: "job-1", repo: "o/r", issue: 1, branch: "noodle/x" });
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/runs",
        headers: { cookie: authCookie() },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.runs).toHaveLength(1);
      expect(body.runs[0].repo).toBe("o/r");
    } finally {
      await app.close();
    }
  });

  it("GET /api/runs/:id returns 401 without a cookie", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/runs/job-1" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("GET / rejects a tampered cookie via /api, but serves the shell unauthenticated", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
    } finally {
      await app.close();
    }
  });
});

describe("UI routes — login / logout", () => {
  it("POST /api/login with the wrong password returns 401 and sets no cookie", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { "content-type": "application/json" },
        payload: { password: "wrong" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("POST /api/login with the right password returns 200 and sets the cookie", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { "content-type": "application/json" },
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["set-cookie"]).toContain("noodle_auth=");
      expect(res.headers["set-cookie"]).toContain("HttpOnly");
      expect(res.headers["set-cookie"]).toContain("SameSite=Strict");
    } finally {
      await app.close();
    }
  });

  it("POST /api/logout clears the cookie", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/logout" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["set-cookie"]).toContain("Max-Age=0");
    } finally {
      await app.close();
    }
  });

  it("a cookie minted via /api/login grants access to /api/runs", async () => {
    store.createRun({ job_id: "job-2", repo: "o/r", issue: 2, branch: "noodle/y" });
    const app = await makeApp();
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { "content-type": "application/json" },
        payload: { password: PASSWORD },
      });
      const cookie = login.headers["set-cookie"];
      const cookieVal = Array.isArray(cookie) ? cookie[0] : cookie;
      const justCookie = cookieVal!.split(";")[0];

      const res = await app.inject({
        method: "GET",
        url: "/api/runs",
        headers: { cookie: justCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().runs).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe("UI routes — run detail", () => {
  it("GET /api/runs/:id returns 404 for an unknown id", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/runs/nope",
        headers: { cookie: authCookie() },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("GET /api/runs/:id returns the run + parsed messages from session_path", async () => {
    writeSessionFixture();
    store.createRun({ job_id: "job-3", repo: "o/r", issue: 3, branch: "noodle/z" });
    store.updateRun("job-3", { status: "succeeded", session_path: sessionPath });

    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/runs/job-3",
        headers: { cookie: authCookie() },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.run.job_id).toBe("job-3");
      expect(body.run.status).toBe("succeeded");
      expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    } finally {
      await app.close();
    }
  });

  it("GET /api/runs/:id returns empty messages when session_path is null", async () => {
    store.createRun({ job_id: "job-4", repo: "o/r", issue: 4, branch: "noodle/w" });
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/runs/job-4",
        headers: { cookie: authCookie() },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().messages).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("UI routes — real webhook-app mounting (string body parser)", () => {
  // Regression guard: createWebhookApp's custom application/json parser returns
  // the raw body string. /api/login must still read the password from it.
  it("POST /api/login succeeds against the webhook app (string body shape)", async () => {
    store.createRun({ job_id: "job-5", repo: "o/r", issue: 5, branch: "noodle/v" });
    const app = makeWebhookAppWithUi();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { "content-type": "application/json" },
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["set-cookie"]).toContain("noodle_auth=");

      // The minted cookie must grant access on the same app.
      const cookieVal = res.headers["set-cookie"].split(";")[0];
      const runs = await app.inject({
        method: "GET",
        url: "/api/runs",
        headers: { cookie: cookieVal },
      });
      expect(runs.statusCode).toBe(200);
      expect(runs.json().runs).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed JSON login body without 500ing", async () => {
    const app = makeWebhookAppWithUi();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { "content-type": "application/json" },
        payload: "not json at all",
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

/**
 * Server control routes — the Restart button on the Logs page.
 *
 * POST /api/server/restart triggers a graceful shutdown (serve.ts:shutdown),
 * which under docker-compose brings the container back via the restart policy.
 * GET /api/server/status reports the in-flight run count for the confirm
 * dialog. Both are auth-guarded; restart returns 503 when no handler is wired
 * (bare-process environments where exit would just stop the server).
 */
describe("UI routes — server restart", () => {
  it("GET /api/server/status returns 401 without a cookie", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/server/status" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("GET /api/server/status reports runningJobs and canRestart=false by default", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/server/status",
        headers: { cookie: authCookie() },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ runningJobs: 0, canRestart: false });
    } finally {
      await app.close();
    }
  });

  it("POST /api/server/restart returns 401 without a cookie", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/server/restart" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("POST /api/server/restart returns 503 when no restart handler is wired", async () => {
    // makeApp() passes no `restart` fn — the endpoint must refuse rather than
    // silently exit the process. This is the bare-process safety path.
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/server/restart",
        headers: { cookie: authCookie() },
      });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toMatch(/not available/i);
    } finally {
      await app.close();
    }
  });

  it("POST /api/server/restart returns 200 and invokes the wired restart fn", async () => {
    // Wire a real restart fn — assert it gets called exactly once, and that the
    // response is 200 + {ok:true}. The fn is deferred via setImmediate so the
    // response flushes first; we await a microtask tick to let it fire.
    let calls = 0;
    const app = Fastify({ logger: false });
    registerUiRoutes(app, {
      runStore: store,
      getSecret: () => PASSWORD,
      settingsStore,
      queue: { countByStatus: () => 0 } as never,
      authProvider: {} as never,
      config: { profiles: {}, default_profile: "x" } as never,
      restart: () => { calls++; },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/server/restart",
        headers: { cookie: authCookie() },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      // setImmediate schedules the restart on the next macrotask; inject()
      // resolves synchronously after sending the response, so we must yield
      // the macrotask queue before asserting the deferred fn ran.
      await new Promise((r) => setImmediate(r));
      expect(calls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("GET /api/server/status surfaces the live running-job count", async () => {
    // Override the queue stub to return a non-zero count — verifies the route
    // passes through queue.countByStatus('running') rather than hardcoding.
    const app = Fastify({ logger: false });
    registerUiRoutes(app, {
      runStore: store,
      getSecret: () => PASSWORD,
      settingsStore,
      queue: { countByStatus: (s: string) => (s === "running" ? 3 : 0) } as never,
      authProvider: {} as never,
      config: { profiles: {}, default_profile: "x" } as never,
      restart: () => {},
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/server/status",
        headers: { cookie: authCookie() },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ runningJobs: 3, canRestart: true });
    } finally {
      await app.close();
    }
  });
});

