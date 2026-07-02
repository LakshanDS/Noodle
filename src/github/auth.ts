import { Octokit } from "octokit";

/**
 * Phase 1 auth: a classic Personal Access Token (GITHUB_TOKEN env).
 * Phase 2 will add GitHub-App installation tokens (see PLAN.md §2.1).
 */
export function createOctokit(token?: string): Octokit {
  const tok = token ?? process.env.GITHUB_TOKEN;
  if (!tok) {
    throw new Error(
      "GITHUB_TOKEN is not set. Create a PAT with repo (or fine-grained contents/pull-requests/issues) scope.",
    );
  }
  return new Octokit({ auth: tok });
}

/** Split "owner/name" into [owner, name]. Throws on malformed input. */
export function parseRepo(repo: string): [string, string] {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(repo.trim());
  if (!m) throw new Error(`Invalid repo "${repo}". Expected "owner/name".`);
  return [m[1], m[2]];
}
