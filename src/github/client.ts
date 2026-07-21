import type { Octokit } from "octokit";
import { parseRepo } from "./auth.js";

/** Plain-data views of GitHub objects — no octokit types leaking into the engine. */
export interface IssueData {
  number: number;
  title: string;
  body: string;
  labels: string[];
  html_url: string;
  /** True when this issue number is actually a pull request. GitHub serves PRs
   *  through the issues API; this flag lets runJob switch to PR mode (clone the
   *  PR's head branch, push back to it) without a separate lookup. */
  pull_request?: boolean;
}
export interface CommentData {
  body: string;
  author: string;
}
/**
 * The branches of a pull request. `head_repo` differs from the target repo for
 * fork PRs — Noodle can only push to same-repo PRs, so runJob checks it.
 */
export interface PullRequestData {
  number: number;
  title: string;
  body: string;
  /** The PR's source branch (e.g. "noodle/issue-7" or "feature/x"). */
  head_branch: string;
  /** The repo the head branch lives in ("owner/name"). Same as target for same-repo PRs. */
  head_repo: string;
  /** The branch the PR targets (e.g. "main"). */
  base_branch: string;
  /** True when the head lives in a fork (different repo) Noodle can't push to. */
  is_fork: boolean;
  html_url: string;
  state: string;
}

/** A repo the authenticated user/app can access (for the dashboard's repo picker). */
export interface RepoData {
  full_name: string;
  default_branch: string;
}

/** A branch in a repo (for the dashboard's branch picker). */
export interface BranchData {
  name: string;
}

/**
 * Thin GitHub client. Methods map 1:1 to REST calls and return plain data.
 * The engine orchestrates these; no business logic here.
 */
export class GitHubClient {
  constructor(private octokit: Octokit) {}

  async getIssue(repo: string, number: number): Promise<IssueData> {
    const [owner, name] = parseRepo(repo);
    const { data } = await this.octokit.rest.issues.get({ owner, repo: name, issue_number: number });
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      labels: data.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
      html_url: data.html_url,
      // GitHub embeds a `pull_request` object on PR rows served via the issues
      // API. Its mere presence marks this as a PR — runJob uses the flag to
      // switch to PR mode (clone the PR's head branch, push back to it).
      pull_request: !!("pull_request" in data && data.pull_request),
    };
  }

  async getIssueComments(repo: string, number: number): Promise<CommentData[]> {
    const [owner, name] = parseRepo(repo);
    const { data } = await this.octokit.rest.issues.listComments({
      owner,
      repo: name,
      issue_number: number,
      per_page: 100,
    });
    return data.map((c) => ({ body: c.body ?? "", author: c.user?.login ?? "unknown" }));
  }

  async addIssueLabel(repo: string, number: number, label: string): Promise<void> {
    const [owner, name] = parseRepo(repo);
    await this.octokit.rest.issues.addLabels({
      owner,
      repo: name,
      issue_number: number,
      labels: [label],
    });
  }

  /**
   * Ensure a repo label exists with the given color + description, creating it
   * if missing. Idempotent: a no-op when the label is already present. Tolerates
   * the rare create-after-404 race (ignores 422 "already exists").
   *
   * `color` is a 6-char hex string without `#` (GitHub API convention).
   */
  async ensureLabel(
    repo: string,
    name: string,
    color: string,
    description: string,
  ): Promise<void> {
    const [owner, repoName] = parseRepo(repo);
    try {
      await this.octokit.rest.issues.getLabel({ owner, repo: repoName, name });
      return; // exists — nothing to do
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== 404) throw e;
    }
    try {
      await this.octokit.rest.issues.createLabel({
        owner,
        repo: repoName,
        name,
        color,
        description,
      });
    } catch (e) {
      // Race: another process created it between our get and create.
      const status = (e as { status?: number }).status;
      if (status !== 422) throw e;
    }
  }

  async removeIssueLabel(repo: string, number: number, label: string): Promise<void> {
    const [owner, name] = parseRepo(repo);
    try {
      await this.octokit.rest.issues.removeLabel({
        owner,
        repo: name,
        issue_number: number,
        name: label,
      });
    } catch (e) {
      // 404 = label isn't on the issue (or doesn't exist) — benign, nothing to remove.
      // Anything else is a real failure the caller should see (was previously swallowed,
      // which left the cooking label stuck on the issue alongside the cooked one).
      const status = (e as { status?: number }).status;
      if (status !== 404) throw e;
    }
  }

  async createIssueComment(repo: string, number: number, body: string): Promise<string> {
    const [owner, name] = parseRepo(repo);
    const { data } = await this.octokit.rest.issues.createComment({
      owner,
      repo: name,
      issue_number: number,
      body,
    });
    return data.html_url;
  }

  /**
   * Open a new issue in the repo. Used by cron runs, whose output IS an issue
   * (e.g. a bug-finding sweep opens one issue per finding). Optional labels are
   * applied atomically at creation. Returns the new issue number + URL.
   */
  async createIssue(
    repo: string,
    title: string,
    body: string,
    labels?: string[],
  ): Promise<{ number: number; html_url: string }> {
    const [owner, name] = parseRepo(repo);
    const { data } = await this.octokit.rest.issues.create({
      owner,
      repo: name,
      title,
      body,
      labels: labels ?? [],
    });
    return { number: data.number, html_url: data.html_url };
  }

  /** Get the repo's default branch name (e.g. "main", "master", "develop"). */
  async defaultBranch(repo: string): Promise<string> {
    const [owner, name] = parseRepo(repo);
    const { data } = await this.octokit.rest.repos.get({ owner, repo: name });
    return data.default_branch;
  }

  /** Get the default branch's sha (or a named branch's sha). */
  async defaultBranchSha(repo: string, branch?: string): Promise<string> {
    const [owner, name] = parseRepo(repo);
    if (!branch) {
      branch = await this.defaultBranch(repo);
    }
    const { data } = await this.octokit.rest.git.getRef({
      owner,
      repo: name,
      ref: `heads/${branch}`,
    });
    return data.object.sha;
  }

  /**
   * Find an open PR whose head branch matches this issue's branch pattern.
   * Matches both the bare first-attempt name (`<agent>/issue-<n>`) and any
   * suffixed retry (`<agent>/issue-<n>-<hash>`), so a follow-up run reuses
   * whichever branch the previous attempt left open. Returns null when there's
   * no open PR — the caller then starts a fresh branch.
   */
  async findOpenPRForIssue(
    repo: string,
    issueNumber: number,
    agentSlug: string,
  ): Promise<{ branch: string; number: number; html_url: string } | null> {
    const [owner, name] = parseRepo(repo);
    // Escape regex metacharacters in the agent slug so a name like `noodle.v1`
    // matches literally instead of treating the `.` as "any char". Same escape
    // pattern as triggers/check.ts, commands/match.ts, profiles/resolve.ts.
    const escapedSlug = agentSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escapedSlug}/issue-${issueNumber}($|-)`);
    // Paginate through all open PRs — repos with >100 open PRs would otherwise
    // miss a matching branch on the first page.
    for await (const response of this.octokit.paginate.iterator(this.octokit.rest.pulls.list, {
      owner,
      repo: name,
      state: "open",
      per_page: 100,
    })) {
      const match = response.data.find(
        (pr) => typeof pr.head?.ref === "string" && pattern.test(pr.head.ref),
      );
      if (match) {
        return { branch: match.head.ref, number: match.number, html_url: match.html_url };
      }
    }
    return null;
  }

  async createPullRequest(
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<{ number: number; html_url: string }> {
    const [owner, name] = parseRepo(repo);
    const { data } = await this.octokit.rest.pulls.create({
      owner,
      repo: name,
      head,
      base,
      title,
      body,
    });
    return { number: data.number, html_url: data.html_url };
  }

  /**
   * Find an open PR whose head branch exactly matches `branch`. Used by
   * scheduler runs to detect whether a trunk branch (e.g.
   * `noodle/schedule-bug-hunt`) already has a pending PR — if so, the next run
   * stacks onto a fresh branch derived from it; if not, the run works on the
   * trunk directly and opens a new PR against the default branch.
   *
   * Paginates through all open PRs (same pattern as findOpenPRForIssue) so a
   * repo with >100 open PRs still finds the match. Returns null when no PR has
   * `branch` as its head.
   */
  async findOpenPRByBranch(
    repo: string,
    branch: string,
  ): Promise<{ number: number; html_url: string } | null> {
    const [owner, name] = parseRepo(repo);
    for await (const response of this.octokit.paginate.iterator(this.octokit.rest.pulls.list, {
      owner,
      repo: name,
      state: "open",
      per_page: 100,
    })) {
      const match = response.data.find(
        (pr) => typeof pr.head?.ref === "string" && pr.head.ref === branch,
      );
      if (match) {
        return { number: match.number, html_url: match.html_url };
      }
    }
    return null;
  }

  /**
   * Fetch a single pull request by number. Returns the head + base branches and
   * whether the PR originates from a fork. Used by runJob in PR mode to clone
   * the PR's head branch and push back to it — fork PRs (different head repo)
   * can't be pushed to, so runJob checks `is_fork` and bails with a comment.
   *
   * The PR's head ref lives in `data.head.repo.full_name` (which equals the
   * target repo for same-repo PRs and differs for forks) and `data.head.ref`
   * (the branch name within that repo).
   */
  async getPullRequest(repo: string, number: number): Promise<PullRequestData> {
    const [owner, name] = parseRepo(repo);
    const { data } = await this.octokit.rest.pulls.get({ owner, repo: name, pull_number: number });
    const headRepo = data.head?.repo?.full_name ?? repo;
    const headBranch = data.head?.ref ?? "";
    const baseBranch = data.base?.ref ?? "";
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      head_branch: headBranch,
      head_repo: headRepo,
      base_branch: baseBranch,
      // Fork = the head ref lives in a different repo than the target.
      is_fork: !!headRepo && headRepo.toLowerCase() !== repo.toLowerCase(),
      html_url: data.html_url,
      state: data.state,
    };
  }

  /** Verify the token by fetching the authenticated user's login. */
  async currentUserLogin(): Promise<string> {
    const { data } = await this.octokit.rest.users.getAuthenticated();
    return data.login;
  }

  /**
   * List a repo's open issues, newest-updated first. `since` (ISO 8601) filters
   * to issues updated at or after the timestamp — the scheduler uses it to find
   * only what's changed since its last scan. Pull requests are excluded by
   * GitHub when state is "open" only if the REST filter cooperates; we drop any
   * `pull_request` entries defensively here.
   */
  async listOpenIssues(repo: string, since?: string): Promise<IssueData[]> {
    const [owner, name] = parseRepo(repo);
    const { data } = await this.octokit.rest.issues.listForRepo({
      owner,
      repo: name,
      state: "open",
      since,
      sort: "created",
      direction: "desc",
      per_page: 100,
    });
    return data
      .filter((i) => !("pull_request" in i))
      .map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        labels: i.labels
          .map((l) => (typeof l === "string" ? l : l.name ?? ""))
          .filter(Boolean),
        html_url: i.html_url,
      }));
  }

  /**
   * Fetch the installation id of the configured GitHub App on a repo (Phase 2
   * scheduler/webhook: maps a repo to its installation token). Returns null if
   * the app isn't installed.
   */
  async repoInstallationId(repo: string): Promise<number | null> {
    const [owner, name] = parseRepo(repo);
    try {
      const { data } = await this.octokit.rest.apps.getRepoInstallation({
        owner,
        repo: name,
      });
      return data.id;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) return null;
      throw e;
    }
  }

  /**
   * List repos the authenticated user (PAT) or installation (App) can access.
   * Used by the dashboard's repo picker on the cron form. Returns up to 100;
   * the UI filters client-side as the user types.
   */
  async listRepos(): Promise<RepoData[]> {
    const { data } = await this.octokit.rest.repos.listForAuthenticatedUser({
      per_page: 100,
      sort: "updated",
      direction: "desc",
    });
    return data.map((r) => ({ full_name: r.full_name, default_branch: r.default_branch }));
  }

  /**
   * List branches in a repo. Used by the dashboard's branch picker — loaded when
   * the user selects/types a repo on the cron form.
   */
  async listBranches(repo: string): Promise<BranchData[]> {
    const [owner, name] = parseRepo(repo);
    const { data } = await this.octokit.rest.repos.listBranches({
      owner,
      repo: name,
      per_page: 100,
    });
    return data.map((b) => ({ name: b.name }));
  }

  /**
   * List a repo's open pull requests, newest first (up to 100). Used by the
   * system-prompt template tags ({pr}, {pr.0}, etc.) to give the agent awareness
   * of open PRs in the repo.
   */
  async listOpenPRs(repo: string): Promise<PullRequestData[]> {
    const [owner, name] = parseRepo(repo);
    const { data } = await this.octokit.rest.pulls.list({
      owner,
      repo: name,
      state: "open",
      sort: "created",
      direction: "desc",
      per_page: 100,
    });
    return data.map((p) => ({
      number: p.number,
      title: p.title,
      body: p.body ?? "",
      head_branch: p.head?.ref ?? "",
      head_repo: p.head?.repo?.full_name ?? repo,
      base_branch: p.base?.ref ?? "",
      is_fork: (p.head?.repo?.full_name ?? repo).toLowerCase() !== repo.toLowerCase(),
      html_url: p.html_url,
      state: p.state,
    }));
  }
}
