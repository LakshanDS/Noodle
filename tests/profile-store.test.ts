import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  ProfileStore,
  validateProfileInput,
} from "../src/server/profile-store.js";
import type { Profile } from "../src/config/schema.js";

let dir: string;
let store: ProfileStore;
let db: Database.Database;

/** A minimal valid profile (required fields only); defaults fill the rest. */
function baseProfile(overrides: Partial<Profile> = {}): Profile {
  return { provider: "anthropic", model: "claude-sonnet-4-20250514", ...overrides };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-profile-"));
  db = new Database(join(dir, "test.db"));
  store = ProfileStore.fromDb(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ProfileStore", () => {
  it("creates a profile and reads it back", () => {
    const stored = store.create("claude-fast", baseProfile());
    expect(stored.name).toBe("claude-fast");
    expect(stored.profile.provider).toBe("anthropic");
    expect(stored.profile.model).toBe("claude-sonnet-4-20250514");
    // Schema defaults are applied on read.
    expect(stored.profile.thinking_level).toBe("medium");
    expect(stored.profile.api_rpm).toBe(30);

    const fetched = store.get("claude-fast");
    expect(fetched.profile.provider).toBe("anthropic");
  });

  it("throws on creating a duplicate name", () => {
    store.create("dup", baseProfile());
    expect(() => store.create("dup", baseProfile())).toThrow(/already exists/);
  });

  it("get throws when the profile is missing", () => {
    expect(() => store.get("nope")).toThrow(/not found/);
  });

  it("has returns true only for stored profiles", () => {
    expect(store.has("x")).toBe(false);
    store.create("x", baseProfile());
    expect(store.has("x")).toBe(true);
  });

  it("updates a profile's fields in place", () => {
    store.create("p", baseProfile());
    const updated = store.update("p", baseProfile({ model: "claude-opus-4-20250514", api_rpm: 10 }));
    expect(updated.profile.model).toBe("claude-opus-4-20250514");
    expect(updated.profile.api_rpm).toBe(10);
  });

  it("update throws when the profile is missing", () => {
    expect(() => store.update("ghost", baseProfile())).toThrow(/not found/);
  });

  it("renames a profile", () => {
    store.create("old", baseProfile());
    const renamed = store.rename("old", "new");
    expect(renamed.name).toBe("new");
    expect(store.has("old")).toBe(false);
    expect(store.has("new")).toBe(true);
  });

  it("rename throws when the target name is taken", () => {
    store.create("a", baseProfile());
    store.create("b", baseProfile());
    expect(() => store.rename("a", "b")).toThrow(/already exists/);
  });

  it("rename to the same name is a no-op (returns current row)", () => {
    store.create("same", baseProfile());
    const res = store.rename("same", "same");
    expect(res.name).toBe("same");
  });

  it("deletes a profile", () => {
    store.create("gone", baseProfile());
    store.delete("gone");
    expect(store.has("gone")).toBe(false);
  });

  it("delete is idempotent for a missing name", () => {
    expect(() => store.delete("never")).not.toThrow();
  });

  it("list returns stored profiles sorted by name", () => {
    store.create("zeta", baseProfile({ model: "z" }));
    store.create("alpha", baseProfile({ model: "a" }));
    const list = store.list();
    expect(list.map((p) => p.name)).toEqual(["alpha", "zeta"]);
  });

  it("list skips rows whose data no longer validates", () => {
    store.create("good", baseProfile());
    // Hand-write a malformed JSON blob straight into the table.
    db.prepare("INSERT INTO profiles (name, data) VALUES (?, ?)").run("bad", "{not json");
    const list = store.list();
    expect(list.map((p) => p.name)).toEqual(["good"]);
  });

  it("listSummaries returns name + identity fields without the full payload", () => {
    store.create("p", baseProfile({ provider: "openai", model: "gpt-4o" }));
    const sums = store.listSummaries();
    expect(sums).toHaveLength(1);
    expect(sums[0]).toMatchObject({ name: "p", provider: "openai", model: "gpt-4o" });
  });

  it("persists across a new store instance on the same DB", () => {
    store.create("persistent", baseProfile());
    const reopened = ProfileStore.fromDb(db);
    expect(reopened.has("persistent")).toBe(true);
    expect(reopened.get("persistent").profile.provider).toBe("anthropic");
  });

  it("stored data round-trips nested fields (tools, pricing, thinking_level)", () => {
    const rich = baseProfile({
      tools: ["read", "bash"],
      thinking_level: "high",
      input_token_price: 0.14,
      output_token_price: 0.28,
      reasoning: true,
    });
    store.create("rich", rich);
    const fetched = store.get("rich").profile;
    expect(fetched.tools).toEqual(["read", "bash"]);
    expect(fetched.thinking_level).toBe("high");
    expect(fetched.input_token_price).toBe(0.14);
    expect(fetched.output_token_price).toBe(0.28);
    expect(fetched.reasoning).toBe(true);
  });
});

describe("validateProfileInput", () => {
  it("accepts a minimal valid profile and applies defaults", () => {
    const res = validateProfileInput({ provider: "anthropic", model: "m" });
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.provider).toBe("anthropic");
      expect(res.api_rpm).toBe(30); // default applied
    }
  });

  it("rejects a profile missing required fields", () => {
    const res = validateProfileInput({ provider: "anthropic" });
    expect("error" in res).toBe(true);
  });

  it("rejects base_url without api", () => {
    const res = validateProfileInput({
      provider: "ollama",
      model: "llama3",
      base_url: "http://localhost:11434/v1",
    });
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/api.*required/);
  });

  it("rejects api without base_url", () => {
    const res = validateProfileInput({
      provider: "ollama",
      model: "llama3",
      api: "openai-completions",
    });
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/base_url.*required/);
  });

  it("accepts a custom endpoint with both base_url and api", () => {
    const res = validateProfileInput({
      provider: "ollama",
      model: "llama3",
      base_url: "http://localhost:11434/v1",
      api: "openai-completions",
    });
    expect("error" in res).toBe(false);
  });
});
