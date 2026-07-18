import { Octokit } from "octokit";
import { GithubAppAuth } from "./app-auth.js";
import { GitHubClient } from "./client.js";
import type { SettingStore } from "../server/settings-store.js";

/**
 * The GitHub REST API version to target (silences the deprecation warning from
 * requests without the header). See auth.ts for details.
 */
const GH_API_VERSION = "2022-11-28";

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

/** PAT mode: a single constant token from GITHUB_TOKEN. */
export class PatAuthProvider implements AuthProvider {
  constructor(private readonly token: string) {}

  async forRepo(): Promise<{ gh: GitHubClient; token: string }> {
    return { gh: new GitHubClient(new Octokit({ auth: this.token, request: { headers: { "X-GitHub-Api-Version": GH_API_VERSION } } })), token: this.token };
  }
}

/** App mode: per-installation tokens minted from the GitHub App. */
export class GithubAppAuthProvider implements AuthProvider {
  constructor(private readonly appAuth: GithubAppAuth) {}

  /**
   * Resolve credentials for a repo. When `installationId` is provided (webhook
   * payload), use it directly. When it's not (cron jobs, manual "Run Now"),
   * resolve it from the repo name via the App's JWT — the repo→installation
   * lookup is cached after the first call.
   *
   * Throws when the App isn't installed on the repo (the lookup returns null).
   */
  async forRepo(repo: string, installationId?: number): Promise<{ gh: GitHubClient; token: string }> {
    let instId = installationId;
    if (!instId) {
      instId = await this.appAuth.getInstallationIdForRepo(repo) ?? undefined;
    }
    if (!instId) {
      throw new Error(
        `GitHub App is not installed on ${repo}, or the installation could not be resolved. ` +
          "Install the App on the repo, or pass an installationId explicitly.",
      );
    }
    const token = await this.appAuth.getInstallationToken(instId);
    return { gh: new GitHubClient(new Octokit({ auth: token, request: { headers: { "X-GitHub-Api-Version": GH_API_VERSION } } })), token };
  }
}

/**
 * A lazy auth provider that re-reads GitHub credentials from the settings DB on
 * every `forRepo()` call. This means PAT, App ID, and private key changes take
 * effect immediately — no restart needed. The selection (App vs PAT vs none) is
 * re-evaluated each call against the current DB state, so switching modes (e.g.
 * adding a PAT after the App creds are cleared) also works live.
 *
 * App-mode caching: `GithubAppAuth` caches installation tokens + repo→installation
 * mappings as INSTANCE fields (one instance per process is the documented usage).
 * To preserve that caching while still picking up credential changes, we hold a
 * long-lived App provider keyed by the (appId|privateKey) we built it from, and
 * rebuild it ONLY when those values change. PAT mode is stateless, so its token
 * is read fresh every call.
 *
 * `forRepo()` is always called per-operation (per job, per webhook, per UI
 * request) and never held as a long-lived snapshot, so re-resolving here is safe.
 */
class LazyAuthProvider implements AuthProvider {
  constructor(private readonly store: SettingStore) {}
  /** Cached App provider + the credential fingerprint it was built from. */
  private appCache: { fingerprint: string; provider: GithubAppAuthProvider } | null = null;

  async forRepo(repo: string, installationId?: number): Promise<{ gh: GitHubClient; token: string }> {
    const appId = this.store.get("GITHUB_APP_ID");
    const privateKey = this.store.get("GITHUB_PRIVATE_KEY");
    if (appId && (privateKey || process.env.GITHUB_PRIVATE_KEY_FILE)) {
      const fingerprint = `${appId}|${privateKey ?? ""}`;
      if (!this.appCache || this.appCache.fingerprint !== fingerprint) {
        const appAuth = new GithubAppAuth({ appId, privateKey: privateKey ?? undefined });
        this.appCache = { fingerprint, provider: new GithubAppAuthProvider(appAuth) };
      }
      return this.appCache.provider.forRepo(repo, installationId);
    }
    // App creds absent — drop any stale App cache so a future re-add starts clean.
    this.appCache = null;
    const token = this.store.get("GITHUB_TOKEN");
    if (token) {
      return new PatAuthProvider(token).forRepo();
    }
    return new NoopAuthProvider().forRepo();
  }
}

/**
 * Build the auth provider for the process. Returns a lazy provider that re-reads
 * credentials from the settings DB on each use — so credential changes in the
 * Settings page take effect immediately without a restart. A no-op provider is
 * used implicitly (inside the lazy provider) when no creds are configured yet,
 * keeping the server bootable in setup mode.
 */
export function resolveAuthProvider(store: SettingStore): AuthProvider {
  return new LazyAuthProvider(store);
}

/**
 * A no-op auth provider for blank instances. Any git op throws a clear error
 * prompting the operator to run the setup wizard. Used only at boot when no
 * GitHub creds are configured yet.
 */
class NoopAuthProvider implements AuthProvider {
  async forRepo(): Promise<{ gh: GitHubClient; token: string }> {
    throw new Error(
      "No GitHub auth configured. Run the setup wizard at /#/setup or set GITHUB_TOKEN / GITHUB_APP_ID in the Settings page.",
    );
  }
}

/** True when the settings DB has GitHub-App credentials (App mode). */
export function isAppMode(store: SettingStore): boolean {
  return Boolean(
    store.has("GITHUB_APP_ID") &&
      (store.has("GITHUB_PRIVATE_KEY") || process.env.GITHUB_PRIVATE_KEY_FILE),
  );
}
