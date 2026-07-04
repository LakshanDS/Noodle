import { Octokit } from "octokit";
import { GithubAppAuth } from "./app-auth.js";
import { GitHubClient } from "./client.js";

/**
 * One interface for getting GitHub credentials for a job, regardless of whether
 * Noodle is running in PAT mode (Phase 1) or GitHub-App mode (Phase 2).
 *
 * Returns BOTH an authenticated `GitHubClient` and the raw token string — the
 * token is also needed by `cloneUrlFor` (git clone), and `runJob` consumes it
 * via `RunInput.token`. Centralizing this keeps the worker auth-mode-agnostic.
 */
export interface AuthProvider {
  forRepo(repo: string, installationId?: number): Promise<{ gh: GitHubClient; token: string }>;
}

/** Phase 1: a single constant PAT from GITHUB_TOKEN. */
export class PatAuthProvider implements AuthProvider {
  constructor(private readonly token: string) {}

  async forRepo(): Promise<{ gh: GitHubClient; token: string }> {
    return { gh: new GitHubClient(new Octokit({ auth: this.token })), token: this.token };
  }
}

/** Phase 2: per-installation tokens minted from the GitHub App. */
export class GithubAppAuthProvider implements AuthProvider {
  constructor(private readonly appAuth: GithubAppAuth) {}

  async forRepo(_repo: string, installationId?: number): Promise<{ gh: GitHubClient; token: string }> {
    if (!installationId) {
      throw new Error(
        "GithubAppAuthProvider needs an installationId. Pass one from the webhook payload or via repoInstallationId().",
      );
    }
    const token = await this.appAuth.getInstallationToken(installationId);
    return { gh: new GitHubClient(new Octokit({ auth: token })), token };
  }
}

/**
 * Pick an auth provider from the environment. App mode wins when the App env
 * vars are present; otherwise fall back to PAT. Throws if neither is configured.
 */
export function resolveAuthProvider(env: NodeJS.ProcessEnv = process.env): AuthProvider {
  if (env.GITHUB_APP_ID && (env.GITHUB_PRIVATE_KEY || env.GITHUB_PRIVATE_KEY_FILE)) {
    return new GithubAppAuthProvider(new GithubAppAuth());
  }
  if (env.GITHUB_TOKEN) {
    return new PatAuthProvider(env.GITHUB_TOKEN);
  }
  throw new Error(
    "No GitHub auth configured. Set GITHUB_TOKEN (PAT) or GITHUB_APP_ID + GITHUB_PRIVATE_KEY (App).",
  );
}

/** True when the environment has GitHub-App credentials (App mode). */
export function isAppMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GITHUB_APP_ID && (env.GITHUB_PRIVATE_KEY || env.GITHUB_PRIVATE_KEY_FILE));
}
