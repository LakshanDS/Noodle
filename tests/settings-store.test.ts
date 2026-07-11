import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SettingStore, SETTING_CATALOG } from "../src/server/settings-store.js";
import { hydrateEnvFromDb } from "../src/server/hydrate-env.js";

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

  it("accepts keys not in the catalog (custom api_key_env)", () => {
    store.set("NVIDIA_API_KEY", "nvj_xyz");
    expect(store.get("NVIDIA_API_KEY")).toBe("nvj_xyz");
  });

  it("mask returns empty for unset/empty values", () => {
    expect(SettingStore.mask(undefined)).toBe("");
    expect(SettingStore.mask("")).toBe("");
  });

  it("mask shows •••• + last 4 chars for a set value", () => {
    expect(SettingStore.mask("ghp_1234567890abcdef")).toBe("••••cdef");
    expect(SettingStore.mask("short")).toBe("••••hort");
  });

  it("isRestartKey is true for boot-read secrets, false for per-request LLM keys", () => {
    expect(SettingStore.isRestartKey("GITHUB_TOKEN")).toBe(true);
    expect(SettingStore.isRestartKey("GITHUB_APP_ID")).toBe(true);
    expect(SettingStore.isRestartKey("GITHUB_WEBHOOK_SECRET")).toBe(true);
    expect(SettingStore.isRestartKey("NOODLE_UI_PASSWORD")).toBe(true);
    expect(SettingStore.isRestartKey("NOODLE_LOGIN")).toBe(true);
    // LLM keys are read per-request via process.env[api_key_env].
    expect(SettingStore.isRestartKey("ANTHROPIC_API_KEY")).toBe(false);
    expect(SettingStore.isRestartKey("OPENAI_API_KEY")).toBe(false);
    expect(SettingStore.isRestartKey("OPENROUTER_API_KEY")).toBe(false);
  });

  it("catalog includes all expected keys", () => {
    const keys = SETTING_CATALOG.map((s) => s.key);
    expect(keys).toContain("GITHUB_TOKEN");
    expect(keys).toContain("GITHUB_APP_ID");
    expect(keys).toContain("GITHUB_PRIVATE_KEY");
    expect(keys).toContain("NOODLE_UI_PASSWORD");
    expect(keys).toContain("ANTHROPIC_API_KEY");
    // Every catalog entry has the required fields.
    for (const s of SETTING_CATALOG) {
      expect(typeof s.key).toBe("string");
      expect(typeof s.label).toBe("string");
      expect(typeof s.secret).toBe("boolean");
      expect(typeof s.restartRequired).toBe("boolean");
    }
  });
});

describe("hydrateEnvFromDb", () => {
  it("copies DB values into process.env when the env var is unset", () => {
    const env: Record<string, string | undefined> = {};
    store.set("ANTHROPIC_API_KEY", "sk-ant-fromdb");
    store.set("GITHUB_TOKEN", "ghp_fromdb");
    const hydrated = hydrateEnvFromDb(db, env);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fromdb");
    expect(env.GITHUB_TOKEN).toBe("ghp_fromdb");
    expect(hydrated.sort()).toEqual(["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]);
  });

  it("does NOT overwrite a value already set in the real environment (real env wins)", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "sk-ant-fromenv",
    };
    store.set("ANTHROPIC_API_KEY", "sk-ant-fromdb");
    hydrateEnvFromDb(db, env);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fromenv"); // env wins
  });

  it("does not hydrate empty-string rows (cleared fields stay unset)", () => {
    const env: Record<string, string | undefined> = {};
    store.set("GITHUB_TOKEN", "");
    hydrateEnvFromDb(db, env);
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("treats an empty real-env value as unset (DB fills it)", () => {
    const env: Record<string, string | undefined> = { GITHUB_TOKEN: "" };
    store.set("GITHUB_TOKEN", "ghp_fromdb");
    hydrateEnvFromDb(db, env);
    expect(env.GITHUB_TOKEN).toBe("ghp_fromdb");
  });
});
