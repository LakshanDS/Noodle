import { describe, it, expect } from "vitest";
import { noodleSkillsDir, installSkills } from "../src/util/paths.js";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("skill resolution", () => {
  it("noodleSkillsDir has default + fix + review", () => {
    const dir = noodleSkillsDir();
    expect(existsSync(join(dir, "noodle-default", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "noodle-fix", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "noodle-review", "SKILL.md"))).toBe(true);
  });

  it("installSkills copies all three skills into a workspace", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "noodle-skill-test-"));
    await installSkills(tmp);
    const dest = join(tmp, ".agents", "skills");
    const names = (await readdir(dest, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    expect(new Set(names)).toEqual(new Set(["noodle-default", "noodle-fix", "noodle-review"]));

    // default holds the mindset; fix/review pair with it (not duplicate it).
    const def = await readFile(join(dest, "noodle-default", "SKILL.md"), "utf8");
    const fix = await readFile(join(dest, "noodle-fix", "SKILL.md"), "utf8");
    const review = await readFile(join(dest, "noodle-review", "SKILL.md"), "utf8");

    expect(def).toContain("lazy senior developer");
    expect(def).toContain("ladder");
    // task skills reference the default (composition, not duplication)
    expect(fix).toContain("noodle-default");
    expect(review).toContain("noodle-default");
    // the mindset lives once — fix/review don't re-state the ladder
    expect(fix).not.toContain("## The ladder");
    expect(review).not.toContain("## The ladder");
  });
});
