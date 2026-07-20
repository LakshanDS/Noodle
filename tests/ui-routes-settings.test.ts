import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { RunStore } from "../src/server/run-store.js";
import { SchedulerStore } from "../src/server/scheduler-store.js";
import { CommandStore } from "../src/server/command-store.js";
import { SettingStore } from "../src/server/settings-store.js";
import { ProfileStore } from "../src/server/profile-store.js";
import { registerUiRoutes } from "../src/server/ui-routes.js";
import { signToken } from "../src/server/ui-auth.js";

/**
 * Settings API routes: GET /api/settings (catalog + masked values) and
 * PUT /api/settings (write). Uses the same in-memory SQLite + app.inject
 * pattern as ui-routes.test.ts.
 */

const PASSWORD = "test-password";

let dir: string;
let db: Database.Database;
let settingsStore: SettingStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-ui-settings-"));
  db = new Database(join(dir, "runs.db"));
  settingsStore = SettingStore.fromDb(db);
  RunStore.fromDb(db); // ensure runs table exists
  SchedulerStore.fromDb(db); // ensure cron table exists
  CommandStore.fromDb(db); // ensure command table exists
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeApp() {
  const app = Fastify({ logger: false });
  registerUiRoutes(app, {
    runStore: RunStore.fromDb(db),
    getSecret: () => PASSWORD,
    cronStore: SchedulerStore.fromDb(db),
    commandStore: CommandStore.fromDb(db),
    settingsStore,
    profileStore: ProfileStore.fromDb(db),
    queue: { enqueue: () => {}, enqueueCron: () => {}, markFailed: () => {}, getById: () => null } as never,
    authProvider: {} as never,
    agentName: "TestBot",
    config: { profiles: {}, default_profile: "x", queue: { max_attempts: 3, retry_backoff_seconds: 60 } } as never,
  });
  return app;
}

function authCookie(): string {
  return `noodle_auth=${signToken(PASSWORD)}`;
}

describe("UI settings routes — auth gating", () => {
  it("GET /api/settings returns 401 without a cookie", async () => {
    const app = makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/settings" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("PUT /api/settings returns 401 without a cookie", async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ values: { GITHUB_TOKEN: "x" } }),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("UI settings routes — GET", () => {
  it("returns the catalog + masked secret values + cleartext non-secrets", async () => {
    settingsStore.set("GITHUB_TOKEN", "ghp_secret123456");
    settingsStore.set("NOODLE_LOGIN", "noodle-agent");
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/settings",
        headers: { cookie: authCookie() },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.catalog)).toBe(true);
      expect(body.catalog.length).toBeGreaterThan(0);
      // Secret value is masked, not cleartext.
      expect(body.values.GITHUB_TOKEN).toBe("••••3456");
      // Non-secret value is cleartext.
      expect(body.values.NOODLE_LOGIN).toBe("noodle-agent");
      // agent_name was removed from the catalog (hardcoded "Noodle" now).
      expect(body.values.agent_name).toBeUndefined();
      // default_profile moved to the Profiles page — no longer in the settings catalog.
      expect(body.values.default_profile).toBeUndefined();
      // restartKeys lists the boot-read keys. GitHub creds (PAT/App), the UI
      // password, agent_name/login/triggers/routing are all read live now, and
      // the queue retry knobs resolve via getters at dispatch time. Nothing in
      // the catalog requires a restart.
      expect(body.restartKeys).not.toContain("GITHUB_TOKEN");
      expect(body.restartKeys).not.toContain("NOODLE_UI_PASSWORD");
      expect(body.restartKeys).not.toContain("default_profile");
      expect(body.restartKeys).not.toContain("agent_name");
    } finally {
      await app.close();
    }
  });
});

describe("UI settings routes — PUT", () => {
  it("writes new values and reports needsRestart=false", async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { cookie: authCookie(), "content-type": "application/json" },
        payload: JSON.stringify({
          values: {
            queue_max_attempts: "5",
            ANTHROPIC_API_KEY: "sk-ant-new",
          },
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      // All catalog fields are live-editable — no restart.
      expect(body.needsRestart).toBe(false);
      expect(body.restartKeys).toEqual([]);
      // Persisted.
      expect(settingsStore.get("queue_max_attempts")).toBe("5");
      expect(settingsStore.get("ANTHROPIC_API_KEY")).toBe("sk-ant-new");
    } finally {
      await app.close();
    }
  });

  it("reports needsRestart=false when only per-request LLM keys change", async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { cookie: authCookie(), "content-type": "application/json" },
        payload: JSON.stringify({
          values: { OPENAI_API_KEY: "sk-new" },
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.needsRestart).toBe(false);
      expect(body.restartKeys).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("skips values that match the mask (unchanged secret fields round-tripped from GET)", async () => {
    settingsStore.set("ANTHROPIC_API_KEY", "sk-ant-realsecret");
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { cookie: authCookie(), "content-type": "application/json" },
        payload: JSON.stringify({
          values: {
            // The mask GET returned — must NOT overwrite the real secret.
            ANTHROPIC_API_KEY: "••••cret",
            OPENAI_API_KEY: "sk-new-openai",
          },
        }),
      });
      expect(res.statusCode).toBe(200);
      // The masked value was skipped, so the real secret is intact.
      expect(settingsStore.get("ANTHROPIC_API_KEY")).toBe("sk-ant-realsecret");
      // The non-masked value was written.
      expect(settingsStore.get("OPENAI_API_KEY")).toBe("sk-new-openai");
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed body with 400", async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { cookie: authCookie(), "content-type": "application/json" },
        payload: JSON.stringify({ notValues: true }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("clears a field when an empty string is sent", async () => {
    settingsStore.set("OPENAI_API_KEY", "sk-old");
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { cookie: authCookie(), "content-type": "application/json" },
        payload: JSON.stringify({ values: { OPENAI_API_KEY: "" } }),
      });
      expect(res.statusCode).toBe(200);
      expect(settingsStore.get("OPENAI_API_KEY")).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe("UI routes — DELETE /api/github/app", () => {
  it("returns 401 without a cookie", async () => {
    const app = makeApp();
    try {
      const res = await app.inject({ method: "DELETE", url: "/api/github/app" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("removes App creds but preserves the PAT and NOODLE_LOGIN", async () => {
    settingsStore.setMany({
      GITHUB_APP_ID: "123456",
      GITHUB_APP_SLUG: "my-bot",
      GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      GITHUB_WEBHOOK_SECRET: "whsecret",
      GITHUB_APP_SETUP_STATE: "csrf-state",
      GITHUB_TOKEN: "ghp_patfallback",
      NOODLE_LOGIN: "my-bot[bot]",
    });
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/github/app",
        headers: { cookie: authCookie() },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      // All App-owned keys are gone.
      expect(settingsStore.get("GITHUB_APP_ID")).toBeUndefined();
      expect(settingsStore.get("GITHUB_APP_SLUG")).toBeUndefined();
      expect(settingsStore.get("GITHUB_PRIVATE_KEY")).toBeUndefined();
      expect(settingsStore.get("GITHUB_WEBHOOK_SECRET")).toBeUndefined();
      expect(settingsStore.get("GITHUB_APP_SETUP_STATE")).toBeUndefined();
      // The PAT survives so Noodle can fall back to it.
      expect(settingsStore.get("GITHUB_TOKEN")).toBe("ghp_patfallback");
      // NOODLE_LOGIN is left alone (may have been set for PAT mode).
      expect(settingsStore.get("NOODLE_LOGIN")).toBe("my-bot[bot]");
    } finally {
      await app.close();
    }
  });
});
