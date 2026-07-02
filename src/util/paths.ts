import { cp, mkdir, access, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";

/** Absolute path to Noodle's bundled skills directory. */
export function noodleSkillsDir(): string {
  // Built: dist/util/paths.js -> ../../skills ; tsx: src/util/paths.ts -> ../../skills
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "skills");
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy Noodle's own skills into a workspace's `.agents/skills/` so pi
 * discovers them via its standard skill lookup. Skills are a nice-to-have;
 * failures here never abort the run.
 */
export async function installSkills(workspacePath: string): Promise<void> {
  const src = noodleSkillsDir();
  const dest = join(workspacePath, ".agents", "skills");
  await mkdir(dest, { recursive: true });

  if (!(await exists(src))) {
    log.warn({ src }, "skills directory not found; skipping skill install");
    return;
  }

  try {
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await cp(join(src, entry.name), join(dest, entry.name), { recursive: true });
    }
    log.debug({ count: entries.filter((e) => e.isDirectory()).length }, "copied skills");
  } catch (e) {
    log.warn({ err: (e as Error).message }, "could not copy skills");
  }
}
