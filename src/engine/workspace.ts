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

  /** Create and checkout a new branch off the current HEAD (fresh attempt). */
  async branch(name: string): Promise<void> {
    await this.git.checkoutLocalBranch(name);
    log.debug({ dir: this.path, branch: name }, "created branch");
  }

  /**
   * Reuse an existing remote branch: fetch it and hard-reset onto its tip so
   * the agent's work stacks on top of the previous attempt's commits. Used
   * when a follow-up run targets an issue that already has an OPEN PR — the
   * caller has already confirmed the branch exists on the remote (via
   * findOpenPRForIssue). After this, the working tree reflects the last run's
   * state and a subsequent push (force-with-lease) updates the existing PR.
   *
   * `freshCloneUrl` embeds the (possibly re-minted) token; fetching from it
   * instead of the stale `origin` avoids an auth failure on long runs.
   */
  async checkoutOrReuse(name: string, freshCloneUrl: string): Promise<void> {
    // Fetch the remote feature branch so we have its commits + a FETCH_HEAD
    // pointer to reset onto. simple-git's fetch(remote, ref) pulls just this ref.
    await this.git.fetch(freshCloneUrl, name);
    // Reset onto the fetched tip — agent now starts from where the last run
    // left off, not from base. HEAD before reset is the freshly-cloned base,
    // so there's nothing local to lose.
    await this.git.raw(["reset", "--hard", "FETCH_HEAD"]);
    // Check out the (now-current) branch so commits land on it by name.
    await this.git.checkout(name);
    log.debug({ dir: this.path, branch: name }, "reused existing remote branch");
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

  /**
   * Push the current branch to origin. If `freshCloneUrl` is given, the origin
   * remote is re-pointed first — used on long agent runs where the token baked
   * into the clone-time URL has since expired.
   *
   * Uses `--force-with-lease` instead of a plain push: a reused branch's local
   * history is rebased on top of the previous attempt by `checkoutOrReuse`, so
   * the remote tip has diverged and a fast-forward push would be rejected. The
   * lease protects against clobbering commits pushed by anything else since our
   * fetch (e.g. a concurrent same-issue run) — it refuses rather than
   * overwriting. On a fresh branch (first attempt) it's a no-op: nothing to
   * lease against, nothing to clobber.
   */
  async push(branch: string, freshCloneUrl?: string): Promise<void> {
    if (freshCloneUrl) {
      await this.git.remote(["set-url", "origin", freshCloneUrl]);
    }
    await this.git.push("origin", branch, ["--force-with-lease", "--set-upstream"]);
    log.debug({ dir: this.path, branch, refreshed: !!freshCloneUrl }, "pushed");
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
