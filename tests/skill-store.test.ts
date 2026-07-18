import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStore } from "../src/server/skill-store.js";
import { noodleSkillsDir } from "../src/util/paths.js";

/**
 * SkillStore tests against a temp dir so the real bundled skills/ are never
 * touched. The store reads/writes skills/<name>/SKILL.md with YAML frontmatter.
 */
describe("SkillStore", () => {
  let dir: string;
  let store: SkillStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "noodle-skill-store-"));
    store = new SkillStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists nothing on an empty dir", () => {
    expect(store.list()).toEqual([]);
  });

  it("creates a skill and reads it back with full body", () => {
    const row = store.create({
      name: "my-skill",
      description: "A test skill.",
      body: "# My skill\n\nStep one. Then step two.",
    });
    expect(row.name).toBe("my-skill");
    expect(row.description).toBe("A test skill.");
    expect(row.body).toBe("# My skill\n\nStep one. Then step two.");
    expect(row.source).toBe("custom");

    // Round-trips through get().
    const got = store.get("my-skill");
    expect(got.body).toBe("# My skill\n\nStep one. Then step two.");
    expect(got.description).toBe("A test skill.");
  });

  it("writes a real SKILL.md on disk with frontmatter", () => {
    store.create({
      name: "disk-test",
      description: "On-disk format.",
      body: "Body line.",
    });
    const file = join(dir, "disk-test", "SKILL.md");
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, "utf8");
    // Frontmatter bookends + the body.
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain("name: disk-test");
    expect(raw).toContain("description: On-disk format.");
    expect(raw).toContain("Body line.");
  });

  it("flags bundled skills by folder name", () => {
    // Seed the three bundled folder names into the temp dir so we can assert
    // the source flag without touching the real package skills.
    for (const name of ["noodle-default", "noodle-fix", "noodle-review"]) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(
        join(dir, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: bundled\n---\n\nbody`,
        "utf8",
      );
    }
    const rows = store.list();
    expect(rows.every((r) => r.source === "bundled")).toBe(true);
    expect(rows.map((r) => r.name).sort()).toEqual(["noodle-default", "noodle-fix", "noodle-review"]);
  });

  it("updates description and body in place", () => {
    store.create({ name: "s1", description: "old", body: "old body" });
    const row = store.update("s1", { description: "new", body: "new body" });
    expect(row.description).toBe("new");
    expect(row.body).toBe("new body");
    // Name unchanged.
    expect(existsSync(join(dir, "s1", "SKILL.md"))).toBe(true);
  });

  it("renames the folder when the name changes", () => {
    store.create({ name: "old-name", description: "d", body: "b" });
    const row = store.update("old-name", { name: "new-name" });
    expect(row.name).toBe("new-name");
    expect(existsSync(join(dir, "old-name"))).toBe(false);
    expect(existsSync(join(dir, "new-name", "SKILL.md"))).toBe(true);
  });

  it("rejects rename onto an existing skill", () => {
    store.create({ name: "a", description: "d", body: "b" });
    store.create({ name: "b", description: "d", body: "b" });
    expect(() => store.update("a", { name: "b" })).toThrow(/already exists/);
  });

  it("deletes a skill folder", () => {
    store.create({ name: "gone", description: "d", body: "b" });
    store.delete("gone");
    expect(store.has("gone")).toBe(false);
    expect(existsSync(join(dir, "gone"))).toBe(false);
  });

  it("throws on delete of a missing skill", () => {
    expect(() => store.delete("nope")).toThrow(/not found/);
  });

  it("rejects create with a duplicate name", () => {
    store.create({ name: "dup", description: "d", body: "b" });
    expect(() => store.create({ name: "dup", description: "d", body: "b" })).toThrow(/already exists/);
  });

  // --- Path safety: the whole point of the name validation. ---

  it("rejects path-traversal names", () => {
    for (const bad of ["..", "../escape", "..%2f", "a/b", "A", "UPPER", "a b", "a.b", "", "-x"]) {
      expect(() => store.create({ name: bad, description: "d", body: "b" }), `name="${bad}"`).toThrow();
    }
  });

  it("has() returns false (not throw) for a traversal name", () => {
    expect(store.has("..")).toBe(false);
    expect(store.has("../escape")).toBe(false);
  });

  it("parses the real bundled skills with full bodies (not mock one-liners)", () => {
    // Guards the original bug: the UI showed truncated mock strings. The real
    // store must surface the full SKILL.md body.
    const real = new SkillStore(noodleSkillsDir());
    const def = real.get("noodle-default");
    expect(def.body).toContain("lazy senior developer");
    expect(def.body).toContain("## The ladder");
    // The mock stub ended at "YAGNI)…" — the real body is far longer.
    expect(def.body.length).toBeGreaterThan(500);
    expect(def.source).toBe("bundled");

    const fix = real.get("noodle-fix");
    expect(fix.body).toContain("## Investigate");
    expect(fix.body).toContain("noodle-default");
  });
});
