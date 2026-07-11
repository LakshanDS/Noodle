import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SettingStore } from "../src/server/settings-store.js";
import {
  synthesizeConfig,
  readSetupProfile,
  hasUsableProfiles,
  SETUP_PROFILE_KEY,
  type SetupProfile,
} from "../src/config/setup-fallback.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-setup-fallback-"));
  db = new Database(join(dir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("setup-fallback — synthesizeConfig", () => {
  it("builds a minimal valid config from a seed", () => {
    const seed: SetupProfile = { provider: "anthropic", model: "claude-sonnet-4-20250514", api_key_env: "ANTHROPIC_API_KEY" };
    const config = synthesizeConfig(seed);
    expect(config.default_profile).toBe("default");
    expect(Object.keys(config.profiles)).toEqual(["default"]);
    expect(config.profiles.default.provider).toBe("anthropic");
    expect(config.profiles.default.model).toBe("claude-sonnet-4-20250514");
    expect(config.profiles.default.api_key_env).toBe("ANTHROPIC_API_KEY");
  });

  it("includes optional base_url + api when provided (custom provider)", () => {
    const seed: SetupProfile = {
      provider: "nvidia",
      model: "minimaxai/minimax-m3",
      api: "openai-completions",
      base_url: "https://integrate.api.nvidia.com/v1",
      api_key_env: "NVIDIA_API_KEY",
    };
    const config = synthesizeConfig(seed);
    expect(config.profiles.default.base_url).toBe("https://integrate.api.nvidia.com/v1");
    expect(config.profiles.default.api).toBe("openai-completions");
  });

  it("fills in sensible defaults (agent_name, tools, server, queue)", () => {
    const config = synthesizeConfig({ provider: "openai", model: "gpt-4o" });
    expect(config.agent_name).toBe("Noodle");
    expect(config.server.host).toBe("0.0.0.0");
    expect(config.server.port).toBe(3000);
    expect(config.queue.concurrency).toBe(1);
    expect(config.profiles.default.tools.length).toBeGreaterThan(0);
  });
});

describe("setup-fallback — readSetupProfile", () => {
  it("returns null when no seed is stored", () => {
    expect(readSetupProfile(db)).toBeNull();
  });

  it("round-trips a stored seed", () => {
    const store = new SettingStore(db);
    const seed: SetupProfile = { provider: "anthropic", model: "claude-3", api_key_env: "ANTHROPIC_API_KEY" };
    store.set(SETUP_PROFILE_KEY, JSON.stringify(seed));
    const read = readSetupProfile(db);
    expect(read).not.toBeNull();
    expect(read!.provider).toBe("anthropic");
    expect(read!.model).toBe("claude-3");
  });

  it("returns null for a malformed seed JSON", () => {
    const store = new SettingStore(db);
    store.set(SETUP_PROFILE_KEY, "{not json");
    expect(readSetupProfile(db)).toBeNull();
  });

  it("returns null for a seed missing required fields", () => {
    const store = new SettingStore(db);
    store.set(SETUP_PROFILE_KEY, JSON.stringify({ provider: "anthropic" })); // no model
    expect(readSetupProfile(db)).toBeNull();
  });
});

describe("setup-fallback — hasUsableProfiles", () => {
  it("is true when a config has a default profile that resolves", () => {
    const config = synthesizeConfig({ provider: "openai", model: "gpt-4o" });
    expect(hasUsableProfiles(config)).toBe(true);
  });

  it("is false when the config has zero profiles", () => {
    const config = synthesizeConfig({ provider: "openai", model: "gpt-4o" });
    // Mutate to empty profiles + a non-existent default.
    const empty = { ...config, profiles: {}, default_profile: "default" };
    expect(hasUsableProfiles(empty)).toBe(false);
  });
});
