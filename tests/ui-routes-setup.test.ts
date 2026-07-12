import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { RunStore } from "../src/server/run-store.js";
import { CronStore } from "../src/server/cron-store.js";
import { CommandStore } from "../src/server/command-store.js";
import { SettingStore } from "../src/server/settings-store.js";
import { ProfileStore } from "../src/server/profile-store.js";
import { registerUiRoutes } from "../src/server/ui-routes.js";
import { SETUP_PROFILE_KEY } from "../src/config/setup-fallback.js";

/**
 * Setup wizard routes: GET /api/setup/status (unauth) + POST /api/setup (unauth
 * only when not configured). Uses the same in-memory SQLite + app.inject
 * pattern as ui-routes.test.ts. Critically, the setup POST must 403 once a UI
 * password is stored — the wizard can't re-run on a live instance.
 */

const PASSWORD = "test-password";

let dir: string;
let db: Database.Database;
let settingsStore: SettingStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-ui-setup-"));
  db = new Database(join(dir, "runs.db"));
  settingsStore = SettingStore.fromDb(db);
  RunStore.fromDb(db);
  CronStore.fromDb(db);
  CommandStore.fromDb(db);
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
    commandStore: CommandStore.fromDb(db),
    settingsStore,
    profileStore: ProfileStore.fromDb(db),
    queue: { enqueue: () => {}, enqueueCron: () => {}, markFailed: () => {}, getById: () => null } as never,
    authProvider: {} as never,
    agentName: "TestBot",
    config: { profiles: {}, default_profile: "x" } as never,
  });
  return app;
}

describe("UI setup routes — GET /api/setup/status", () => {
  it("is reachable unauthenticated", async () => {
    const app = makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/setup/status" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("configured");
      expect(body).toHaveProperty("steps");
      expect(body).toHaveProperty("hasProfiles");
    } finally {
      await app.close();
    }
  });

  it("reports configured=false and all steps false on a blank instance", async () => {
    const app = makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/setup/status" });
      const body = res.json();
      expect(body.configured).toBe(false);
      expect(body.steps.github).toBe(false);
      expect(body.steps.llm).toBe(false);
      expect(body.steps.ui).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("reports steps as true when the corresponding settings exist", async () => {
    settingsStore.set("GITHUB_TOKEN", "ghp_xxx");
    settingsStore.set("ANTHROPIC_API_KEY", "sk-ant-xxx");
    settingsStore.set("NOODLE_UI_PASSWORD", "secret");
    const app = makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/setup/status" });
      const body = res.json();
      expect(body.configured).toBe(true); // UI password set → configured
      expect(body.steps.github).toBe(true);
      expect(body.steps.llm).toBe(true);
      expect(body.steps.ui).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("UI setup routes — POST /api/setup", () => {
  it("writes all wizard values + a profile seed on a blank instance", async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          github: { token: "ghp_wizard" },
          llm: { provider: "anthropic", model: "claude-3", apiKey: "sk-ant-wizard", apiKeyEnv: "ANTHROPIC_API_KEY" },
          uiPassword: "newpass",
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.needsRestart).toBe(true);
      // Persisted.
      expect(settingsStore.get("GITHUB_TOKEN")).toBe("ghp_wizard");
      expect(settingsStore.get("ANTHROPIC_API_KEY")).toBe("sk-ant-wizard");
      expect(settingsStore.get("NOODLE_UI_PASSWORD")).toBe("newpass");
      // Profile seed stored.
      const seed = JSON.parse(settingsStore.get(SETUP_PROFILE_KEY)!);
      expect(seed.provider).toBe("anthropic");
      expect(seed.model).toBe("claude-3");
      expect(seed.api_key_env).toBe("ANTHROPIC_API_KEY");
    } finally {
      await app.close();
    }
  });

  it("accepts GitHub App credentials instead of a PAT", async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          github: { appId: "123", privateKey: "-----BEGIN PEM-----\n…\n-----END-----", webhookSecret: "wh" },
          llm: { provider: "openai", model: "gpt-4o", apiKey: "sk-x", apiKeyEnv: "OPENAI_API_KEY" },
          uiPassword: "pw",
        }),
      });
      expect(res.statusCode).toBe(200);
      expect(settingsStore.get("GITHUB_APP_ID")).toBe("123");
      expect(settingsStore.get("GITHUB_PRIVATE_KEY")).toContain("BEGIN PEM");
      expect(settingsStore.get("GITHUB_WEBHOOK_SECRET")).toBe("wh");
    } finally {
      await app.close();
    }
  });

  it("403s once a UI password is stored (wizard can't re-run on a live box)", async () => {
    settingsStore.set("NOODLE_UI_PASSWORD", "existing");
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          github: { token: "ghp_x" },
          llm: { provider: "anthropic", model: "claude-3" },
          uiPassword: "newpass",
        }),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("already configured");
    } finally {
      await app.close();
    }
  });

  it("400s when GitHub auth is missing", async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          github: {},
          llm: { provider: "anthropic", model: "claude-3" },
          uiPassword: "pw",
        }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("GitHub auth required");
    } finally {
      await app.close();
    }
  });

  it("400s when the UI password is missing", async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          github: { token: "ghp_x" },
          llm: { provider: "anthropic", model: "claude-3" },
        }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("uiPassword is required");
    } finally {
      await app.close();
    }
  });
});
