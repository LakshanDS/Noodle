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
 * GET /api/github/app-check-permission — validates that the configured GitHub
 * App's installation actually has Checks: Read & write (the live PR check-run
 * permission). Uses the same in-memory SQLite + app.inject pattern as
 * ui-routes-settings.test.ts, with a fake AuthProvider.
 */

const PASSWORD = "test-password";

let dir: string;
let db: Database.Database;
let settingsStore: SettingStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-ui-perm-"));
  db = new Database(join(dir, "runs.db"));
  settingsStore = SettingStore.fromDb(db);
  RunStore.fromDb(db);
  SchedulerStore.fromDb(db);
  CommandStore.fromDb(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeApp(authProvider: Record<string, unknown>) {
  const app = Fastify({ logger: false });
  registerUiRoutes(app, {
    runStore: RunStore.fromDb(db),
    getSecret: () => PASSWORD,
    cronStore: SchedulerStore.fromDb(db),
    commandStore: CommandStore.fromDb(db),
    settingsStore,
    profileStore: ProfileStore.fromDb(db),
    queue: { enqueue: () => {}, enqueueCron: () => {}, markFailed: () => {}, getById: () => null } as never,
    authProvider: authProvider as never,
    agentName: "TestBot",
    config: { profiles: {}, default_profile: "x", queue: { max_attempts: 3, retry_backoff_seconds: 60 } } as never,
  });
  return app;
}

function authCookie(): string {
  return `noodle_auth=${signToken(PASSWORD)}`;
}

async function getPermissions(app: ReturnType<typeof makeApp>): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: "GET",
    url: "/api/github/app-check-permission",
    headers: { cookie: authCookie() },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("GET /api/github/app-check-permission", () => {
  it("reports appMode:false when no App credentials are configured (PAT mode)", async () => {
    const app = makeApp({});
    try {
      expect(await getPermissions(app)).toEqual({ appMode: false });
    } finally {
      await app.close();
    }
  });

  it("ok:true when the installation has checks:write", async () => {
    settingsStore.set("GITHUB_APP_ID", "123");
    settingsStore.set("GITHUB_PRIVATE_KEY", "fake-key");
    const app = makeApp({
      listRepos: async () => [{ full_name: "o/r", default_branch: "main" }],
      appPermissions: async () => ({ checks: "write", contents: "write", metadata: "read" }),
    });
    try {
      const body = await getPermissions(app);
      expect(body.appMode).toBe(true);
      expect(body.ok).toBe(true);
      expect(body.checks).toBe("write");
      expect(body.repo).toBe("o/r");
      expect(body.settingsUrl).toContain("github.com/settings/apps");
    } finally {
      await app.close();
    }
  });

  it("ok:false with a fix hint when the Checks permission is missing", async () => {
    settingsStore.set("GITHUB_APP_ID", "123");
    settingsStore.set("GITHUB_PRIVATE_KEY", "fake-key");
    settingsStore.set("GITHUB_APP_SLUG", "my-bot");
    const app = makeApp({
      listRepos: async () => [{ full_name: "o/r", default_branch: "main" }],
      appPermissions: async () => ({ contents: "write", metadata: "read" }),
    });
    try {
      const body = await getPermissions(app);
      expect(body.appMode).toBe(true);
      expect(body.ok).toBe(false);
      expect(body.checks).toBe("none");
      expect(body.hint).toContain("Checks");
      expect(body.settingsUrl).toBe("https://github.com/settings/apps/my-bot/permissions");
    } finally {
      await app.close();
    }
  });

  it("ok:false when the App has no installations", async () => {
    settingsStore.set("GITHUB_APP_ID", "123");
    settingsStore.set("GITHUB_PRIVATE_KEY", "fake-key");
    const app = makeApp({
      listRepos: async () => [],
      appPermissions: async () => null,
    });
    try {
      const body = await getPermissions(app);
      expect(body.ok).toBe(false);
      expect(body.reason).toContain("installations");
    } finally {
      await app.close();
    }
  });

  it("ok:false when the provider can't read the installation (null)", async () => {
    settingsStore.set("GITHUB_APP_ID", "123");
    settingsStore.set("GITHUB_PRIVATE_KEY", "fake-key");
    const app = makeApp({
      listRepos: async () => [{ full_name: "o/r", default_branch: "main" }],
      appPermissions: async () => null,
    });
    try {
      const body = await getPermissions(app);
      expect(body.ok).toBe(false);
      expect(body.reason).toContain("Could not read");
    } finally {
      await app.close();
    }
  });
});
