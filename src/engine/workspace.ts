import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { log } from "../util/log.js";

/**
 * Manages a throwaway git workspace per job: clone, branch, commit, push.
 * Blast radius is limited to a temp dir. (Docker isolation is a Phase 3 concern.)
 */
export class Workspace {
  private git: SimpleGit;
  private disposed = false;

  private constructor(public readonly path: string) {
    this.git = simpleGit(this.path);
  }

  /** Clone `cloneUrl` (https with token embedded) into a fresh temp dir. */
  static async clone(cloneUrl: string, jobId: string): Promise<Workspace> {
    const dir = await mkdtemp(join(tmpdir(), `noodle-${jobId}-`));
    log.debug({ dir, cloneUrl: cloneUrl.replace(/\/\/.*@/, "//***@"), jobId }, "cloning workspace");
    // simpleGit().clone(src, dest) — clone into the temp dir directly
    await simpleGit().clone(cloneUrl, dir, ["--depth", "50"]);
    return new Workspace(dir);
  }

  /** Create and checkout a new branch off the current HEAD. */
  async branch(name: string): Promise<void> {
    await this.git.checkoutLocalBranch(name);
    log.debug({ dir: this.path, branch: name }, "created branch");
  }

  /** Remove only the skills Noodle copied (not user-owned skills). */
  async removeInternals(): Promise<void> {
    const { noodleSkillsDir } = await import("../util/paths.js");
    const { readdir } = await import("node:fs/promises");
    const src = noodleSkillsDir();
    try {
      const entries = await readdir(src, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        await rm(join(this.path, ".agents", "skills", entry.name), { recursive: true, force: true });
      }
      log.debug("removed Noodle-copied skills from workspace");
    } catch {
      // No skills dir or nothing to clean — fine.
    }
  }

  /** Stage all changes and commit. Returns true if there was anything to commit. */
  async commitAll(message: string): Promise<boolean> {
    await this.git.add("-A");
    const status = await this.git.status();
    if (status.staged.length === 0) return false;
    await this.git.commit(message);
    return true;
  }

  /** List of changed files vs the branch point (for PR summary). */
  async changedFiles(): Promise<string[]> {
    const diff = await this.git.diff(["--name-only", "HEAD~1"]);
    return diff.split("\n").filter(Boolean);
  }

  /** Push the current branch to origin. */
  async push(branch: string): Promise<void> {
    await this.git.push("origin", branch, ["--set-upstream"]);
    log.debug({ dir: this.path, branch }, "pushed");
  }

  /** Remove the temp dir. Safe to call multiple times. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await rm(this.path, { recursive: true, force: true });
    } catch (e) {
      log.warn({ dir: this.path, err: e }, "failed to clean up workspace");
    }
  }
}

/** Build an HTTPS clone URL with the PAT embedded, e.g. for `git clone`. */
export function cloneUrlFor(repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}
