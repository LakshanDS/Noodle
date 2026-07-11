import { Octokit } from "octokit";

/**
 * The GitHub REST API version to target. Without this header GitHub defaults to
 * the old `2022-11-28` version and logs a deprecation warning on every request
 * (scheduled for removal March 2028). Pinning silences the warning and future-
 * proofs us against breaking changes in newer API versions.
 */
const GH_API_VERSION = "2022-11-28";

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
  return new Octokit({ auth: tok, previews: [], request: { headers: { "X-GitHub-Api-Version": GH_API_VERSION } } });
}

/** Split "owner/name" into [owner, name]. Throws on malformed input. */
export function parseRepo(repo: string): [string, string] {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(repo.trim());
  if (!m) throw new Error(`Invalid repo "${repo}". Expected "owner/name".`);
  return [m[1], m[2]];
}
