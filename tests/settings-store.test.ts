import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SettingStore, SETTING_CATALOG } from "../src/server/settings-store.js";

let dir: string;
let db: Database.Database;
let store: SettingStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-settings-"));
  db = new Database(join(dir, "test.db"));
  store = SettingStore.fromDb(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SettingStore", () => {
  it("set/get round-trips a value", () => {
    store.set("GITHUB_TOKEN", "ghp_abc123");
    expect(store.get("GITHUB_TOKEN")).toBe("ghp_abc123");
    expect(store.has("GITHUB_TOKEN")).toBe(true);
  });

  it("set with empty string deletes the row (clear field)", () => {
    store.set("GITHUB_TOKEN", "ghp_abc123");
    store.set("GITHUB_TOKEN", "");
    expect(store.get("GITHUB_TOKEN")).toBeUndefined();
    expect(store.has("GITHUB_TOKEN")).toBe(false);
  });

  it("set upserts on conflict (updates value + updated_at)", () => {
    store.set("NOODLE_UI_PASSWORD", "old");
    store.set("NOODLE_UI_PASSWORD", "new");
    expect(store.get("NOODLE_UI_PASSWORD")).toBe("new");
  });

  it("setMany writes all values in one transaction", () => {
    store.setMany({ GITHUB_TOKEN: "t1", ANTHROPIC_API_KEY: "k1", NOODLE_UI_PASSWORD: "" });
    expect(store.get("GITHUB_TOKEN")).toBe("t1");
    expect(store.get("ANTHROPIC_API_KEY")).toBe("k1");
    // Empty value clears (no row).
    expect(store.get("NOODLE_UI_PASSWORD")).toBeUndefined();
  });

  it("all() returns every stored row", () => {
    store.setMany({ GITHUB_TOKEN: "t1", ANTHROPIC_API_KEY: "k1" });
    const rows = store.all();
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]);
  });

  it("accepts keys not in the catalog (custom settings)", () => {
    store.set("SOME_CUSTOM_KEY", "custom-value");
    expect(store.get("SOME_CUSTOM_KEY")).toBe("custom-value");
  });

  it("mask returns empty for unset/empty values", () => {
    expect(SettingStore.mask(undefined)).toBe("");
    expect(SettingStore.mask("")).toBe("");
  });

  it("mask shows •••• + last 4 chars for a set value", () => {
    expect(SettingStore.mask("ghp_1234567890abcdef")).toBe("••••cdef");
    expect(SettingStore.mask("short")).toBe("••••hort");
  });

  it("isRestartKey is true for boot-read secrets, false for live (DB-backed) ones", () => {
    // GitHub creds + the UI password are read live from the DB now (no restart).
    expect(SettingStore.isRestartKey("GITHUB_TOKEN")).toBe(false);
    expect(SettingStore.isRestartKey("GITHUB_APP_ID")).toBe(false);
    expect(SettingStore.isRestartKey("GITHUB_WEBHOOK_SECRET")).toBe(false);
    expect(SettingStore.isRestartKey("NOODLE_UI_PASSWORD")).toBe(false);
    // agent_name / login / triggers / routing are re-overlayed onto config on
    // save and read live by runJob + the webhook handler (via getters).
    expect(SettingStore.isRestartKey("NOODLE_LOGIN")).toBe(false);
    expect(SettingStore.isRestartKey("agent_name")).toBe(false);
    expect(SettingStore.isRestartKey("trigger_on_mention")).toBe(false);
    expect(SettingStore.isRestartKey("routing")).toBe(false);
    // Queue retry knobs resolve via getters at dispatch time — no restart.
    // (queue_concurrency was removed; per-profile concurrency lives on profiles.)
    expect(SettingStore.isRestartKey("queue_max_attempts")).toBe(false);
    expect(SettingStore.isRestartKey("queue_retry_backoff_seconds")).toBe(false);
    // LLM keys are on profiles now, not in the settings catalog.
    expect(SettingStore.isRestartKey("ANTHROPIC_API_KEY")).toBe(false);
    expect(SettingStore.isRestartKey("default_profile")).toBe(false);
  });

  it("catalog includes all expected keys", () => {
    const keys = SETTING_CATALOG.map((s) => s.key);
    expect(keys).toContain("GITHUB_TOKEN");
    expect(keys).toContain("GITHUB_APP_ID");
    expect(keys).toContain("GITHUB_PRIVATE_KEY");
    expect(keys).toContain("NOODLE_UI_PASSWORD");
    expect(keys).toContain("system_prompt");
    // default_profile moved to the Profiles page UI (not a Settings catalog key).
    expect(keys).not.toContain("default_profile");
    // The repo-scan scheduler was removed — its keys are gone from the catalog.
    expect(keys).not.toContain("scheduler_enabled");
    expect(keys).not.toContain("scheduler_interval_minutes");
    expect(keys).not.toContain("scheduler_repos");
    // LLM API keys are NOT in the catalog — they live on profiles now.
    expect(keys).not.toContain("ANTHROPIC_API_KEY");
    // Every catalog entry has the required fields.
    for (const s of SETTING_CATALOG) {
      expect(typeof s.key).toBe("string");
      expect(typeof s.label).toBe("string");
      expect(typeof s.secret).toBe("boolean");
      expect(typeof s.restartRequired).toBe("boolean");
    }
  });
});
