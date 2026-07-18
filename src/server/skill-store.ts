import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

/**
 * Filesystem-backed store for skills. Each skill is a subdirectory of the
 * shared `skills/` folder (the same one `installSkills()` copies into agent
 * workspaces, so UI edits land in front of the agent on the next run with no
 * engine change). A skill's folder name is its identifier; its content is a
 * single `SKILL.md` with YAML frontmatter (`name`, `description`, …) followed
 * by a markdown body.
 *
 * Unlike the other stores (CronStore, ProfileStore, …) this one is NOT backed
 * by SQLite — skills are files on disk by design, matching how the
 * pi-coding-agent discovers them. The class mirrors the read/write/delete
 * surface of the DB stores (synchronous, returning T not Promise<T>) so the UI
 * routes can treat it uniformly.
 *
 * Path safety is enforced on every mutating call: the skill name must match a
 * conservative allowlist (lowercase, digits, hyphens) and the resolved folder
 * path must stay inside `skillsDir`, so a crafted name can't escape the dir or
 * clobber files outside it.
 */

/** Mirror of client/src/api/types.ts SkillRow — kept structurally identical. */
export interface SkillRow {
  /** Folder / frontmatter name, e.g. "noodle-fix". */
  name: string;
  description: string;
  /** SKILL.md markdown body (everything below the frontmatter). */
  body: string;
  /** "bundled" for the shipped built-ins, "custom" for UI-created skills. */
  source: "bundled" | "custom";
  updated_at: string;
}

/** Payload for creating a skill. */
export interface SkillInput {
  name: string;
  description: string;
  body: string;
}

/** Partial update for a skill. Renaming moves the folder. */
export type SkillUpdate = Partial<SkillInput>;

/** The skills shipped in the package — flagged "bundled" in list responses. */
const BUNDLED_SKILLS = new Set(["noodle-default", "noodle-fix", "noodle-review"]);

/**
 * Skill folder names must be lowercase, start with a letter/digit, and contain
 * only letters, digits, or hyphens. This (plus the resolve-inside-dir check)
 * blocks path traversal (`..`, absolute paths, `/`-separated names) and keeps
 * folder names filesystem-safe across platforms.
 */
const VALID_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Throw if `name` is not a safe skill folder identifier. */
function assertValidName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `invalid skill name "${name}": use lowercase letters, digits, and hyphens only`,
    );
  }
}

/**
 * Resolve `<skillsDir>/<name>` and assert the result stays inside `skillsDir`.
 * Guards against any traversal that slipped past the regex (defense in depth).
 */
function safeFolder(skillsDir: string, name: string): string {
  assertValidName(name);
  const folder = resolve(skillsDir, name);
  // `skillsDir` is already absolute (see constructor); ensure the resolved
  // folder is a direct child of it.
  const parent = dirname(folder);
  if (parent !== skillsDir) {
    throw new Error(`invalid skill name "${name}": escapes skills directory`);
  }
  return folder;
}

/** Absolute path to Noodle's bundled skills directory. */
function defaultSkillsDir(): string {
  // Built: dist/server/skill-store.js -> ../../skills ; tsx: src/server/skill-store.ts
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "skills");
}

/** Parsed view of a SKILL.md: frontmatter fields we care about + the body. */
interface ParsedSkillFile {
  name: string;
  description: string;
  body: string;
}

/**
 * Parse a SKILL.md string into frontmatter + body. The file is
 * `---\n<yaml>\n---\n<body>`. Frontmatter is optional but always present in
 * practice; a missing block is treated as an empty description and a body
 * equal to the whole file.
 */
function parseSkillFile(raw: string): ParsedSkillFile {
  // Only treat a leading `---` as frontmatter (the Agent Skills standard).
  if (!raw.startsWith("---")) {
    return { name: "", description: "", body: raw };
  }
  // Split into [open, yaml, rest]. `---` on its own line opens and closes the
  // block; the first `---` is the opener, the second is the closer.
  const lines = raw.split("\n");
  if (lines[0].trim() !== "---") {
    return { name: "", description: "", body: raw };
  }
  let closeLine = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeLine = i;
      break;
    }
  }
  if (closeLine < 0) {
    return { name: "", description: "", body: raw };
  }
  const fmRaw = lines.slice(1, closeLine).join("\n");
  // Body is everything after the closing `---` line. Drop one leading blank
  // line if present (the conventional `\n\n` separator) so round-trips are clean.
  let bodyLines = lines.slice(closeLine + 1);
  if (bodyLines.length > 0 && bodyLines[0] === "") bodyLines = bodyLines.slice(1);
  const body = bodyLines.join("\n");

  let fm: Record<string, unknown> = {};
  try {
    const parsed = parse(fmRaw);
    if (parsed && typeof parsed === "object") fm = parsed as Record<string, unknown>;
  } catch {
    // Malformed frontmatter — fall through with empty fields; body still reads.
  }
  return {
    name: typeof fm.name === "string" ? fm.name : "",
    description: typeof fm.description === "string" ? fm.description : "",
    body,
  };
}

/** Reassemble frontmatter + body into a SKILL.md string. */
function serializeSkillFile(input: { name: string; description: string; body: string }): string {
  // `yaml.stringify` appends a trailing "\n"; trim it so the closing "---"
  // lands directly after the last frontmatter line (round-trips cleanly: the
  // parser then sees exactly "<yaml>\n---\n\n<body>").
  const fm = stringify({ name: input.name, description: input.description }).replace(/\n+$/, "");
  return `---\n${fm}\n---\n\n${input.body}`;
}

export class SkillStore {
  private readonly skillsDir: string;

  /**
   * @param skillsDir Optional override for the skills directory. Defaults to
   *   the package's bundled `skills/` (resolved relative to this file so it
   *   works both under `tsx src/...` and the built `dist/...`). Tests pass a
   *   temp dir so they never touch the real bundled skills.
   */
  constructor(skillsDir: string = defaultSkillsDir()) {
    this.skillsDir = skillsDir;
  }

  /** List every skill folder as a SkillRow, sorted by name. */
  list(): SkillRow[] {
    if (!existsSync(this.skillsDir)) return [];
    const entries = readdirSync(this.skillsDir);
    const rows: SkillRow[] = [];
    for (const entry of entries) {
      const folder = join(this.skillsDir, entry);
      if (!statSync(folder).isDirectory()) continue;
      if (!existsSync(join(folder, "SKILL.md"))) continue;
      rows.push(this.rowFromDisk(entry));
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** True if a skill folder with a SKILL.md exists. */
  has(name: string): boolean {
    try {
      return existsSync(join(safeFolder(this.skillsDir, name), "SKILL.md"));
    } catch {
      return false;
    }
  }

  /** Read one skill, or throw if missing. Callers guard with `has()`. */
  get(name: string): SkillRow {
    const folder = safeFolder(this.skillsDir, name);
    return this.rowFromDisk(name, folder);
  }

  /** Create a new skill folder + SKILL.md. Throws if the name is taken. */
  create(input: SkillInput): SkillRow {
    assertValidName(input.name);
    const folder = safeFolder(this.skillsDir, input.name);
    if (existsSync(folder)) {
      throw new Error(`a skill named "${input.name}" already exists`);
    }
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), serializeSkillFile(input), "utf8");
    return this.rowFromDisk(input.name, folder);
  }

  /**
   * Update an existing skill. If `input.name` is provided and differs from the
   * current name, the folder is renamed first. Any of name/description/body may
   * be omitted to keep the existing value.
   */
  update(currentName: string, input: SkillUpdate): SkillRow {
    let folder = safeFolder(this.skillsDir, currentName);
    if (!existsSync(folder)) {
      throw new Error(`skill "${currentName}" not found`);
    }
    const existing = this.rowFromDisk(currentName, folder);

    const newName = input.name !== undefined ? input.name : existing.name;
    if (newName !== existing.name) {
      assertValidName(newName);
      const target = safeFolder(this.skillsDir, newName);
      if (existsSync(target)) {
        throw new Error(`a skill named "${newName}" already exists`);
      }
      renameSync(folder, target);
      folder = target;
    }

    writeFileSync(
      join(folder, "SKILL.md"),
      serializeSkillFile({
        name: newName,
        description: input.description !== undefined ? input.description : existing.description,
        body: input.body !== undefined ? input.body : existing.body,
      }),
      "utf8",
    );
    return this.rowFromDisk(newName, folder);
  }

  /** Recursively remove a skill folder. Throws if it doesn't exist. */
  delete(name: string): void {
    const folder = safeFolder(this.skillsDir, name);
    if (!existsSync(folder)) {
      throw new Error(`skill "${name}" not found`);
    }
    rmSync(folder, { recursive: true, force: true });
  }

  /** Read + parse a SKILL.md into a SkillRow. `name` overrides the folder name. */
  private rowFromDisk(folderName: string, folder?: string): SkillRow {
    const dir = folder ?? safeFolder(this.skillsDir, folderName);
    const file = join(dir, "SKILL.md");
    const raw = readFileSync(file, "utf8");
    const parsed = parseSkillFile(raw);
    const mtime = statSync(file).mtime.toISOString();
    return {
      // Prefer frontmatter name; fall back to the folder name (it's the truth
      // on disk and what the engine keys on).
      name: parsed.name || folderName,
      description: parsed.description,
      body: parsed.body,
      source: BUNDLED_SKILLS.has(folderName) ? "bundled" : "custom",
      updated_at: mtime,
    };
  }
}
