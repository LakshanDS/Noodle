import type { Octokit } from "octokit";
import { parseRepo } from "./auth.js";

/** Plain-data views of GitHub objects — no octokit types leaking into the engine. */
export interface IssueData {
  number: number;
  title: string;
  body: string;
  labels: string[];
  html_url: string;
}
export interface CommentData {
  body: string;
  author: string;
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
    const { data } = await this.octokit.rest.pulls.list({
      owner,
      repo: name,
      state: "open",
      per_page: 100,
    });
    const pattern = new RegExp(`^${agentSlug}/issue-${issueNumber}($|-)`);
    const match = data.find(
      (pr) => typeof pr.head?.ref === "string" && pattern.test(pr.head.ref),
    );
    return match
      ? { branch: match.head.ref, number: match.number, html_url: match.html_url }
      : null;
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
}
