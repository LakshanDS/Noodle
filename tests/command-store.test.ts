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
    const cmd = store.create({ trigger: "question" });
    expect(cmd.id).toBeGreaterThan(0);
    expect(cmd.trigger).toBe("question");
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

  it("labels default to null and round-trip through create/update", () => {
    // New commands have no custom labels (null → use global defaults).
    const cmd = store.create({ trigger: "question" });
    expect(cmd.labels).toBeNull();

    // Set a custom label set via update.
    const labelSet = JSON.stringify({
      cooking: { name: "Noodle-question is cooking", color: "3b82f6" },
      cooked: { name: "Noodle-question cooked here", color: "6fae6f" },
      failed: { name: "Noodle-question got Cooked", color: "c76b6b" },
    });
    const withLabels = store.update(cmd.id, { labels: labelSet });
    expect(withLabels.labels).toBe(labelSet);

    // Read back persists.
    expect(store.get(cmd.id).labels).toBe(labelSet);

    // Clearing back to null restores the "use defaults" state.
    const cleared = store.update(cmd.id, { labels: null });
    expect(cleared.labels).toBeNull();
  });

  it("create accepts labels directly", () => {
    const labelSet = JSON.stringify({
      cooking: { name: "X is cooking", color: "ff0000" },
      cooked: { name: "X cooked here", color: "00ff00" },
      failed: { name: "X got Cooked", color: "0000ff" },
    });
    const cmd = store.create({ trigger: "review", labels: labelSet });
    expect(cmd.labels).toBe(labelSet);
  });

  it("updates fields and bumps updated_at", () => {
    const cmd = store.create({ trigger: "q" });
    // Force the row's updated_at into the past so datetime('now') on update
    // is strictly newer (both have 1-second resolution).
    db.prepare("UPDATE commands SET updated_at = ? WHERE id = ?")
      .run("2020-01-01 00:00:00", cmd.id);
    const updated = store.update(cmd.id, { enabled: 0, profile: "claude" });
    expect(updated.enabled).toBe(0);
    expect(updated.profile).toBe("claude");
    expect(updated.updated_at).not.toBe("2020-01-01 00:00:00");
  });

  it("update with no fields returns the current row unchanged", () => {
    const cmd = store.create({ trigger: "q" });
    const updated = store.update(cmd.id, {});
    expect(updated).toEqual(cmd);
  });

  it("deletes a user command", () => {
    const cmd = store.create({ trigger: "q" });
    store.delete(cmd.id);
    expect(() => store.get(cmd.id)).toThrow(/not found/);
  });

  it("delete is idempotent for a missing row", () => {
    expect(() => store.delete(9999)).not.toThrow();
  });

  it("refuses to delete a built-in command", () => {
    const cmd = store.create({ trigger: "noodle", is_builtin: 1 } as never);
    // Mark as builtin via raw SQL since NewCommand doesn't expose is_builtin.
    db.prepare("UPDATE commands SET is_builtin = 1 WHERE id = ?").run(cmd.id);
    expect(() => store.delete(cmd.id)).toThrow(/built-in/);
    // Row still present.
    expect(store.get(cmd.id).trigger).toBe("noodle");
  });

  it("rejects duplicate triggers (unique constraint)", () => {
    store.create({ trigger: "review" });
    expect(() => store.create({ trigger: "review" })).toThrow();
  });

  it("list returns all commands newest-first", () => {
    store.create({ trigger: "a" });
    store.create({ trigger: "b" });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0].trigger).toBe("b");
  });

  it("getByTrigger is case-insensitive", () => {
    store.create({ trigger: "question" });
    expect(store.getByTrigger("Question")?.trigger).toBe("question");
    expect(store.getByTrigger("QUESTION")?.trigger).toBe("question");
  });

  it("getByTrigger returns undefined for missing or empty", () => {
    expect(store.getByTrigger("nope")).toBeUndefined();
    expect(store.getByTrigger("")).toBeUndefined();
  });

  it("activeTriggers returns only enabled commands", () => {
    store.create({ trigger: "on" });
    store.create({ trigger: "off", enabled: 0 });
    expect(store.activeTriggers()).toEqual(["on"]);
  });

  it("resolveByTrigger matches a standalone /trigger token in text", () => {
    store.create({ trigger: "question" });
    expect(store.resolveByTrigger("/question please help")?.trigger).toBe("question");
    expect(store.resolveByTrigger("hello /question")?.trigger).toBe("question");
  });

  it("resolveByTrigger does not match a substring of another word", () => {
    store.create({ trigger: "q" });
    // "/queue" should not match trigger "q" (word boundary).
    expect(store.resolveByTrigger("/queue me up")).toBeNull();
  });

  it("resolveByTrigger ignores disabled commands", () => {
    store.create({ trigger: "disabled", enabled: 0 });
    expect(store.resolveByTrigger("/disabled now")).toBeNull();
  });

  it("resolveByTrigger returns null for empty text", () => {
    store.create({ trigger: "q" });
    expect(store.resolveByTrigger("")).toBeNull();
  });

  it("resolveByTrigger does not shadow a longer trigger at a hyphen boundary", () => {
    // The classic bug: `/noodle` must NOT match inside `/noodle-fix`, because
    // otherwise the generic built-in shadows the specific fix/review commands.
    store.create({ trigger: "noodle" });
    store.create({ trigger: "noodle-fix" });
    expect(store.resolveByTrigger("/noodle-fix this")?.trigger).toBe("noodle-fix");
    // And a standalone /noodle still resolves to the generic one.
    expect(store.resolveByTrigger("/noodle please")?.trigger).toBe("noodle");
  });

  it("resolveByTrigger does not shadow a longer trigger at an underscore boundary", () => {
    store.create({ trigger: "test" });
    store.create({ trigger: "test_deep" });
    expect(store.resolveByTrigger("/test_deep now")?.trigger).toBe("test_deep");
    expect(store.resolveByTrigger("/test now")?.trigger).toBe("test");
  });

  it("resolveByTrigger does not match inside a longer word (no trailing chars)", () => {
    store.create({ trigger: "fix" });
    // `/fixing` must not match `/fix` — the `i` is a word char.
    expect(store.resolveByTrigger("/fixing the bug")).toBeNull();
    // `/fix` followed by punctuation still matches.
    expect(store.resolveByTrigger("please /fix.")?.trigger).toBe("fix");
  });
});

describe("seedBuiltinCommand", () => {
  it("seeds three built-in commands on a fresh store", () => {
    seedBuiltinCommand(store, "Noodle");
    const all = store.list();
    expect(all).toHaveLength(3);
    const builtins = all.filter((c) => c.is_builtin === 1);
    expect(builtins).toHaveLength(3);

    const noodle = store.getByTrigger("noodle");
    expect(noodle).toBeDefined();
    expect(noodle!.system_prompt).toContain("noodle-default");
    expect(noodle!.system_prompt).not.toContain("noodle-fix");
    expect(noodle!.enabled).toBe(1);

    const fix = store.getByTrigger("noodle-fix");
    expect(fix).toBeDefined();
    expect(fix!.system_prompt).toContain("noodle-default");
    expect(fix!.system_prompt).toContain("noodle-fix");

    const review = store.getByTrigger("noodle-review");
    expect(review).toBeDefined();
    expect(review!.system_prompt).toContain("noodle-default");
    expect(review!.system_prompt).toContain("noodle-review");

    // All built-ins are non-deletable.
    expect(() => store.delete(noodle!.id)).toThrow(/built-in/);
    expect(() => store.delete(fix!.id)).toThrow(/built-in/);
    expect(() => store.delete(review!.id)).toThrow(/built-in/);
  });

  it("is idempotent — re-running refreshes rows without duplicating", () => {
    seedBuiltinCommand(store, "Noodle");
    seedBuiltinCommand(store, "Noodle");
    expect(store.list().filter((c) => c.is_builtin === 1)).toHaveLength(3);
  });

  it("updates the trigger when the agent is renamed", () => {
    seedBuiltinCommand(store, "Noodle");
    seedBuiltinCommand(store, "MyBot");
    const builtins = store.list().filter((c) => c.is_builtin === 1);
    expect(builtins).toHaveLength(3);
    const triggers = builtins.map((c) => c.trigger).sort();
    expect(triggers).toEqual(["mybot", "mybot-fix", "mybot-review"]);
  });

  it("the built-in resolves via resolveByTrigger (so /noodle wakes)", () => {
    seedBuiltinCommand(store, "Noodle");
    const cmd = store.resolveByTrigger("please /noodle fix this");
    expect(cmd?.trigger).toBe("noodle");
  });

  it("activeTriggers includes all built-ins so webhook wake works", () => {
    seedBuiltinCommand(store, "Noodle");
    const triggers = store.activeTriggers();
    expect(triggers).toContain("noodle");
    expect(triggers).toContain("noodle-fix");
    expect(triggers).toContain("noodle-review");
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
