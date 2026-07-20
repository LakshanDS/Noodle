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

  /**
   * Re-wrap an existing on-disk clone (no git activity). Used by the Chats
   * runtime to resume a chat whose workspace was cloned in a prior server
   * lifetime — the dir still exists, we just need a `simpleGit` handle onto it.
   */
  static rewrap(dir: string): Workspace {
    return new Workspace(dir);
  }

  /**
   * Check out a remote branch by name. Used by the Chats runtime after a fresh
   * clone: clones leave you on the default branch, so when the user picked a
   * different branch we fetch it from origin and switch. Creates a local
   * tracking branch if one doesn't exist (`checkout -B`).
   */
  async checkoutRemote(branch: string): Promise<void> {
    await this.git.fetch("origin", branch);
    await this.git.checkout(["-B", branch, `origin/${branch}`]);
    log.debug({ dir: this.path, branch }, "checked out remote branch");
  }

  /** Create and checkout a new branch off the current HEAD (fresh attempt). */
  async branch(name: string): Promise<void> {
    await this.git.checkoutLocalBranch(name);
    log.debug({ dir: this.path, branch: name }, "created branch");
  }

  /**
   * Create a new local branch from a remote branch. Fetches `remoteBranch` from
   * the remote, then creates `newBranch` at FETCH_HEAD. Used when an issue has
   * an open PR — the agent works on a fresh branch derived from the PR's branch
   * rather than reusing the PR branch directly.
   */
  async branchFrom(newBranch: string, remoteBranch: string, freshCloneUrl?: string): Promise<void> {
    if (freshCloneUrl) {
      await this.git.remote(["set-url", "origin", freshCloneUrl]);
    }
    await this.git.fetch("origin", remoteBranch);
    await this.git.checkoutLocalBranch(newBranch);
    await this.git.reset(["--hard", "FETCH_HEAD"]);
    log.debug({ dir: this.path, newBranch, from: remoteBranch }, "created branch from remote");
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
    // Fetching from a raw URL (not "origin") only sets FETCH_HEAD — it does NOT
    // create a refs/remotes/origin/<name> tracking ref.
    await this.git.fetch(freshCloneUrl, name);
    // Create-or-reset the local branch at FETCH_HEAD, then check it out. The
    // old sequence (reset --hard FETCH_HEAD; checkout name) left HEAD detached
    // with no local branch named <name>, so the checkout failed with
    // "pathspec did not match". `checkout -B` resolves both in one step.
    await this.git.checkout(["-B", name, "FETCH_HEAD"]);
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
    try {
      const diff = await this.git.diff(["--name-only", "HEAD~1"]);
      return diff.split("\n").filter(Boolean);
    } catch {
      // Shallow clone with only 1 commit — HEAD~1 doesn't exist. Fall back to
      // diffing against the empty tree (shows all tracked files as "changed").
      const diff = await this.git.diff(["--name-only", "--root", "HEAD"]);
      return diff.split("\n").filter(Boolean);
    }
  }

  /**
   * Merge the repo's base (default) branch into the current branch. Used by
   * scheduler runs to sync a long-lived trunk branch with `main` before each
   * run, so the trunk never drifts into an unmergeable state.
   *
   * Fetches `baseBranch` first — a `--depth 50` shallow clone may not have it
   * if it isn't the default branch the clone landed on. Then runs
   * `git merge origin/<baseBranch>` and inspects the result:
   *  - clean merge / already up to date → `{ conflicted: false, files: [] }`
   *  - conflict → `{ conflicted: true, files: [...] }` (caller must resolve or
   *    abort; the worktree is left with conflict markers in the index)
   *
   * `freshCloneUrl` (optional) embeds a re-minted token and is used to fetch,
   * avoiding a 401 on long runs where the clone-time token has expired.
   *
   * simple-git notes: when `git merge` exits non-zero with conflicts, the
   * simple-git promise REJECTS (does not resolve) — the conflict list lives on
   * `err.git.conflicts` as `[{ reason, file }, ...]`. We catch that and turn it
   * into the return shape; any other throw (network, auth) is re-thrown.
   */
  async mergeMain(
    baseBranch: string,
    freshCloneUrl?: string,
  ): Promise<{ conflicted: boolean; files: string[] }> {
    if (freshCloneUrl) {
      await this.git.remote(["set-url", "origin", freshCloneUrl]);
    }
    await this.git.fetch("origin", baseBranch);
    try {
      // Pass the ref as a single token (`origin/<base>`) — simple-git forwards
      // the array elements as separate argv, and `git merge origin main` would
      // be misread as merging two unrelated refs.
      await this.git.merge([`origin/${baseBranch}`]);
      log.debug({ dir: this.path, baseBranch }, "merged base branch into current branch");
      return { conflicted: false, files: [] };
    } catch (e) {
      const conflictList = (e as { git?: { conflicts?: { file?: string; reason?: string }[] } }).git?.conflicts;
      if (conflictList && conflictList.length > 0) {
        const files = conflictList.map((c) => c.file).filter((f): f is string => !!f);
        log.warn({ dir: this.path, baseBranch, files }, "merge produced conflicts");
        return { conflicted: true, files };
      }
      // Not a conflict — a real error (network, auth, malformed merge). Re-throw
      // so the caller surfaces it instead of silently treating it as a conflict.
      throw e;
    }
  }

  /**
   * Abort an in-progress merge, restoring the worktree to its pre-merge state.
   * Used when a merge conflict can't be resolved — the caller aborts rather than
   * leaving the trunk in a broken conflicted state. No-op when no merge is in
   * progress (git itself silently succeeds).
   */
  async abortMerge(): Promise<void> {
    await this.git.merge(["--abort"]);
    log.debug({ dir: this.path }, "aborted in-progress merge");
  }

  /**
   * Check whether the index still has unmerged paths after a conflict-resolver
   * agent pass. Used to verify the resolver actually cleared every conflict
   * before the caller commits and pushes the trunk.
   *
   * Uses `git status`'s `conflicted` list (the canonical git signal for
   * "unresolved conflict"). `git diff --check` is NOT reliable here: it only
   * reports whitespace/trailing-space errors on staged content, and exits clean
   * on a tree that still has the standard `<<<<<<<` markers in unmerged paths.
   */
  async hasConflictMarkers(): Promise<boolean> {
    const status = await this.git.status();
    return !!status.conflicted && status.conflicted.length > 0;
  }

  /**
   * Push the current branch to origin. If `freshCloneUrl` is given, the origin
   * remote is re-pointed first — used on long agent runs where the token baked
   * into the clone-time URL has since expired.
   *
   * `reuse` selects the push mode:
   *  - false (fresh branch, first attempt): plain `--set-upstream`. A fresh
   *    branch has no remote-tracking ref for `--force-with-lease` to verify
   *    against, so git rejects it with "[rejected] (stale info)".
   *  - true (reused branch, follow-up run): `--force-with-lease`. checkoutOrReuse
   *    stacked this run's commits on top of the previous attempt's branch, so
   *    the remote tip has diverged and a fast-forward would be rejected. The
   *    lease refuses rather than clobbering commits pushed by anything else
   *    since our fetch (e.g. a concurrent same-issue run).
   */
  async push(branch: string, freshCloneUrl?: string, reuse = false): Promise<void> {
    if (freshCloneUrl) {
      await this.git.remote(["set-url", "origin", freshCloneUrl]);
    }
    const flags = reuse
      ? ["--force-with-lease", "--set-upstream"]
      : ["--set-upstream"];
    await this.git.push("origin", branch, flags);
    log.debug({ dir: this.path, branch, refreshed: !!freshCloneUrl, reuse }, "pushed");
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
