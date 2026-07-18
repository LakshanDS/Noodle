import { Octokit } from "octokit";

/**
 * The GitHub REST API version to target. Without this header GitHub defaults to
 * the old `2022-11-28` version and logs a deprecation warning on every request
 * (scheduled for removal March 2028). Pinning silences the warning and future-
 * proofs us against breaking changes in newer API versions.
 */
const GH_API_VERSION = "2022-11-28";

/**
 * Create an Octokit instance authenticated with a PAT. The token is passed
 * explicitly — callers read it from the settings DB (no env-var fallback).
 */
export function createOctokit(token: string): Octokit {
  if (!token) {
    throw new Error(
      "No GitHub token. Set GITHUB_TOKEN in the Settings page.",
    );
  }
  return new Octokit({ auth: token, previews: [], request: { headers: { "X-GitHub-Api-Version": GH_API_VERSION } } });
}

/** Split "owner/name" into [owner, name]. Throws on malformed input. */
export function parseRepo(repo: string): [string, string] {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(repo.trim());
  if (!m) throw new Error(`Invalid repo "${repo}". Expected "owner/name".`);
  return [m[1], m[2]];
}
