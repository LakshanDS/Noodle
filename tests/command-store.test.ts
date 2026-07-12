import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommandStore, normalizeTrigger, seedBuiltinCommand } from "../src/server/command-store.js";

let dir: string;
let store: CommandStore;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-command-"));
  db = new Database(join(dir, "test.db"));
  store = CommandStore.fromDb(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("CommandStore", () => {
  it("creates a command and reads it back", () => {
    const cmd = store.create({ trigger: "question", name: "Answer a question" });
    expect(cmd.id).toBeGreaterThan(0);
    expect(cmd.trigger).toBe("question");
    expect(cmd.name).toBe("Answer a question");
    expect(cmd.description).toBe("");
    expect(cmd.system_prompt).toBe("");
    expect(cmd.profile).toBeNull();
    expect(cmd.enabled).toBe(1);
    expect(cmd.is_builtin).toBe(0);

    const fetched = store.get(cmd.id);
    expect(fetched.trigger).toBe("question");
  });

  it("creates with optional fields populated", () => {
    const cmd = store.create({
      trigger: "review",
      name: "Review changes",
      description: "Review the diff",
      system_prompt: "You are a reviewer.",
      profile: "cheap",
      enabled: 0,
    });
    expect(cmd.description).toBe("Review the diff");
    expect(cmd.system_prompt).toBe("You are a reviewer.");
    expect(cmd.profile).toBe("cheap");
    expect(cmd.enabled).toBe(0);
  });

  it("updates fields and bumps updated_at", () => {
    const cmd = store.create({ trigger: "q", name: "Q" });
    // Force the row's updated_at into the past so datetime('now') on update
    // is strictly newer (both have 1-second resolution).
    db.prepare("UPDATE commands SET updated_at = ? WHERE id = ?")
      .run("2020-01-01 00:00:00", cmd.id);
    const updated = store.update(cmd.id, { name: "Question", enabled: 0, profile: "claude" });
    expect(updated.name).toBe("Question");
    expect(updated.enabled).toBe(0);
    expect(updated.profile).toBe("claude");
    expect(updated.updated_at).not.toBe("2020-01-01 00:00:00");
  });

  it("update with no fields returns the current row unchanged", () => {
    const cmd = store.create({ trigger: "q", name: "Q" });
    const updated = store.update(cmd.id, {});
    expect(updated).toEqual(cmd);
  });

  it("deletes a user command", () => {
    const cmd = store.create({ trigger: "q", name: "Q" });
    store.delete(cmd.id);
    expect(() => store.get(cmd.id)).toThrow(/not found/);
  });

  it("delete is idempotent for a missing row", () => {
    expect(() => store.delete(9999)).not.toThrow();
  });

  it("refuses to delete a built-in command", () => {
    const cmd = store.create({ trigger: "noodle", name: "Default", is_builtin: 1 } as never);
    // Mark as builtin via raw SQL since NewCommand doesn't expose is_builtin.
    db.prepare("UPDATE commands SET is_builtin = 1 WHERE id = ?").run(cmd.id);
    expect(() => store.delete(cmd.id)).toThrow(/built-in/);
    // Row still present.
    expect(store.get(cmd.id).trigger).toBe("noodle");
  });

  it("rejects duplicate triggers (unique constraint)", () => {
    store.create({ trigger: "review", name: "Review" });
    expect(() => store.create({ trigger: "review", name: "Other" })).toThrow();
  });

  it("list returns all commands newest-first", () => {
    store.create({ trigger: "a", name: "A" });
    store.create({ trigger: "b", name: "B" });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0].trigger).toBe("b");
  });

  it("getByTrigger is case-insensitive", () => {
    store.create({ trigger: "question", name: "Q" });
    expect(store.getByTrigger("Question")?.trigger).toBe("question");
    expect(store.getByTrigger("QUESTION")?.trigger).toBe("question");
  });

  it("getByTrigger returns undefined for missing or empty", () => {
    expect(store.getByTrigger("nope")).toBeUndefined();
    expect(store.getByTrigger("")).toBeUndefined();
  });

  it("activeTriggers returns only enabled commands", () => {
    store.create({ trigger: "on", name: "On" });
    store.create({ trigger: "off", name: "Off", enabled: 0 });
    expect(store.activeTriggers()).toEqual(["on"]);
  });

  it("resolveByTrigger matches a standalone /trigger token in text", () => {
    store.create({ trigger: "question", name: "Q" });
    expect(store.resolveByTrigger("/question please help")?.trigger).toBe("question");
    expect(store.resolveByTrigger("hello /question")?.trigger).toBe("question");
  });

  it("resolveByTrigger does not match a substring of another word", () => {
    store.create({ trigger: "q", name: "Q" });
    // "/queue" should not match trigger "q" (word boundary).
    expect(store.resolveByTrigger("/queue me up")).toBeNull();
  });

  it("resolveByTrigger ignores disabled commands", () => {
    store.create({ trigger: "disabled", name: "D", enabled: 0 });
    expect(store.resolveByTrigger("/disabled now")).toBeNull();
  });

  it("resolveByTrigger returns null for empty text", () => {
    store.create({ trigger: "q", name: "Q" });
    expect(store.resolveByTrigger("")).toBeNull();
  });
});

describe("seedBuiltinCommand", () => {
  it("seeds the /<agent> built-in command on a fresh store", () => {
    seedBuiltinCommand(store, "Noodle");
    const all = store.list();
    expect(all).toHaveLength(1);
    const cmd = all[0];
    expect(cmd.trigger).toBe("noodle");
    expect(cmd.is_builtin).toBe(1);
    expect(cmd.enabled).toBe(1);
    expect(cmd.system_prompt).toContain("noodle-default");
    expect(cmd.system_prompt).toContain("noodle-fix");
    // The built-in is non-deletable.
    expect(() => store.delete(cmd.id)).toThrow(/built-in/);
  });

  it("is idempotent — re-running refreshes the row without duplicating", () => {
    seedBuiltinCommand(store, "Noodle");
    seedBuiltinCommand(store, "Noodle");
    expect(store.list().filter((c) => c.is_builtin === 1)).toHaveLength(1);
  });

  it("updates the trigger when the agent is renamed", () => {
    seedBuiltinCommand(store, "Noodle");
    seedBuiltinCommand(store, "MyBot");
    const builtins = store.list().filter((c) => c.is_builtin === 1);
    expect(builtins).toHaveLength(1);
    expect(builtins[0].trigger).toBe("mybot");
  });

  it("the built-in resolves via resolveByTrigger (so /noodle wakes)", () => {
    seedBuiltinCommand(store, "Noodle");
    const cmd = store.resolveByTrigger("please /noodle fix this");
    expect(cmd?.trigger).toBe("noodle");
  });

  it("activeTriggers includes the built-in so webhook wake works", () => {
    seedBuiltinCommand(store, "Noodle");
    expect(store.activeTriggers()).toContain("noodle");
  });
});

describe("normalizeTrigger", () => {
  it("strips leading slashes and lowercases", () => {
    expect(normalizeTrigger("/Question")).toBe("question");
    expect(normalizeTrigger("//Question")).toBe("question");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeTrigger("  review  ")).toBe("review");
  });

  it("returns empty for whitespace-only input", () => {
    expect(normalizeTrigger("   ")).toBe("");
    expect(normalizeTrigger("/  ")).toBe("");
  });
});
