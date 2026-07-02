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
}
