import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { RunStore } from "../src/server/run-store.js";
import { CronStore } from "../src/server/cron-store.js";
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
  CronStore.fromDb(db); // ensure cron table exists
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeApp() {
  const app = Fastify({ logger: false });
  registerUiRoutes(app, {
    runStore: RunStore.fromDb(db),
    secret: PASSWORD,
    cronStore: CronStore.fromDb(db),
    settingsStore,
    profileStore: ProfileStore.fromDb(db),
    queue: { enqueue: () => {}, enqueueCron: () => {}, markFailed: () => {}, getById: () => null } as never,
    authProvider: {} as never,
    agentName: "TestBot",
    config: { profiles: {}, default_profile: "x" } as never,
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
      // Unset secret is empty string.
      expect(body.values.ANTHROPIC_API_KEY).toBe("");
      // restartKeys lists the boot-read keys.
      expect(body.restartKeys).toContain("GITHUB_TOKEN");
      expect(body.restartKeys).toContain("NOODLE_UI_PASSWORD");
      expect(body.restartKeys).not.toContain("ANTHROPIC_API_KEY");
    } finally {
      await app.close();
    }
  });
});

describe("UI settings routes — PUT", () => {
  it("writes new values and reports needsRestart for boot-read keys", async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { cookie: authCookie(), "content-type": "application/json" },
        payload: JSON.stringify({
          values: {
            GITHUB_TOKEN: "ghp_newvalue",
            ANTHROPIC_API_KEY: "sk-ant-new",
          },
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.needsRestart).toBe(true); // GITHUB_TOKEN is a restart key
      expect(body.restartKeys).toEqual(["GITHUB_TOKEN"]);
      // Persisted.
      expect(settingsStore.get("GITHUB_TOKEN")).toBe("ghp_newvalue");
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
