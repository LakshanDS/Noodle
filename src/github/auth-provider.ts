import { Octokit } from "octokit";
import { GithubAppAuth } from "./app-auth.js";
import { GitHubClient } from "./client.js";
import type { SettingStore } from "../server/settings-store.js";
import { log } from "../util/log.js";

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
  /** List repos accessible to the configured credentials (PAT or App installation). */
  listRepos(): Promise<import("./client.js").RepoData[]>;
}

/** PAT mode: a single constant token from GITHUB_TOKEN. */
export class PatAuthProvider implements AuthProvider {
  constructor(private readonly token: string) {}

  async forRepo(): Promise<{ gh: GitHubClient; token: string }> {
    return { gh: new GitHubClient(new Octokit({ auth: this.token, request: { headers: { "X-GitHub-Api-Version": GH_API_VERSION } } })), token: this.token };
  }

  async listRepos(): Promise<import("./client.js").RepoData[]> {
    const { gh } = await this.forRepo();
    return gh.listRepos();
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

  /**
   * List repos accessible to any installation of this App. Finds the first
   * installation and uses its token to call the correct endpoint:
   * `GET /installation/repositories` (not `GET /user/repos`, which returns 403
   * for App tokens — "Resource not accessible by integration").
   */
  async listRepos(): Promise<import("./client.js").RepoData[]> {
    const installations = await this.appAuth.listInstallations();
    if (installations.length === 0) return [];
    const token = await this.appAuth.getInstallationToken(installations[0].id);
    const octokit = new Octokit({ auth: token, request: { headers: { "X-GitHub-Api-Version": GH_API_VERSION } } });
    const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100 });
    return data.repositories.map((r) => ({ full_name: r.full_name, default_branch: r.default_branch }));
  }
}

/**
 * A lazy auth provider that re-reads GitHub credentials from the settings DB on
 * every `forRepo()` call. This means PAT, App ID, and private key changes take
 * effect immediately — no restart needed. The selection (App vs PAT vs none) is
 * re-evaluated each call against the current DB state, so switching modes (e.g.
 * adding a PAT after the App creds are cleared) also works live.
 *
 * Precedence — App first, PAT fallback:
 *   When App creds are present (GITHUB_APP_ID + GITHUB_PRIVATE_KEY or a
 *   GITHUB_PRIVATE_KEY_FILE), we try the App provider first. If it throws (App
 *   uninstalled on the repo, revoked, key rotated, etc.) AND a PAT is also
 *   configured, we fall back to the PAT so a run isn't lost. If no PAT is
 *   configured, the original App error is re-thrown so the operator sees the
 *   real cause. When only a PAT is present, PAT is used directly. When neither
 *   is present, the Noop provider throws the setup prompt.
 *
 *   This lets an operator keep both configured at once: App as the primary, PAT
 *   as the backup. The App is always preferred on the happy path, so the common
 *   (App-only) case has zero extra calls.
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
  /**
   * @param store Settings DB (re-queried every call for hot reload).
   * @param appProviderFactory Builds the App provider from resolved creds.
   *   Defaults to the real `GithubAppAuth` + `GithubAppAuthProvider`; injectable
   *   for tests so the App-throws → PAT-fallback path can be exercised without
   *   real keys or network.
   */
  constructor(
    private readonly store: SettingStore,
    private readonly appProviderFactory: (appId: string, privateKey: string | undefined) => AuthProvider = (appId, privateKey) =>
      new GithubAppAuthProvider(new GithubAppAuth({ appId, privateKey })),
  ) {}
  /** Cached App provider + the credential fingerprint it was built from. */
  private appCache: { fingerprint: string; provider: AuthProvider } | null = null;

  /**
   * Resolve the cached App provider for the current DB creds, rebuilding it only
   * when the (appId|privateKey) fingerprint changes. Returns null when App creds
   * are absent — callers then drop the cache and fall through to PAT/Noop.
   */
  private resolveAppProvider(): AuthProvider | null {
    const appId = this.store.get("GITHUB_APP_ID");
    const privateKey = this.store.get("GITHUB_PRIVATE_KEY");
    if (!appId || !(privateKey || process.env.GITHUB_PRIVATE_KEY_FILE)) {
      // App creds absent — drop any stale App cache so a future re-add starts clean.
      this.appCache = null;
      return null;
    }
    const fingerprint = `${appId}|${privateKey ?? ""}`;
    if (!this.appCache || this.appCache.fingerprint !== fingerprint) {
      this.appCache = { fingerprint, provider: this.appProviderFactory(appId, privateKey ?? undefined) };
    }
    return this.appCache.provider;
  }

  async forRepo(repo: string, installationId?: number): Promise<{ gh: GitHubClient; token: string }> {
    const appProvider = this.resolveAppProvider();
    if (appProvider) {
      try {
        return await appProvider.forRepo(repo, installationId);
      } catch (appErr) {
        // App creds exist but failed (uninstalled/revoked/key invalid). Fall
        // back to the PAT if one is configured so the run can still proceed.
        const token = this.store.get("GITHUB_TOKEN");
        if (token) {
          log.warn({ repo, err: (appErr as Error).message }, "GitHub App auth failed; falling back to PAT");
          return new PatAuthProvider(token).forRepo();
        }
        // No fallback available — re-throw so the caller sees the real cause.
        throw appErr;
      }
    }
    const token = this.store.get("GITHUB_TOKEN");
    if (token) {
      return new PatAuthProvider(token).forRepo();
    }
    return new NoopAuthProvider().forRepo();
  }

  async listRepos(): Promise<import("./client.js").RepoData[]> {
    const appProvider = this.resolveAppProvider();
    if (appProvider) {
      try {
        return await appProvider.listRepos();
      } catch (appErr) {
        const token = this.store.get("GITHUB_TOKEN");
        if (token) {
          log.warn({ err: (appErr as Error).message }, "GitHub App auth failed; falling back to PAT for repo listing");
          return new PatAuthProvider(token).listRepos();
        }
        throw appErr;
      }
    }
    const token = this.store.get("GITHUB_TOKEN");
    if (token) {
      return new PatAuthProvider(token).listRepos();
    }
    return new NoopAuthProvider().listRepos();
  }
}

/**
 * Exported for tests so the App-throws → PAT-fallback path can be exercised with
 * an injectable App provider (no real keys or network). Production builds it via
 * `resolveAuthProvider`, which uses the real factory.
 */
export const LazyAuthProviderForTest = LazyAuthProvider;

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

  async listRepos(): Promise<import("./client.js").RepoData[]> {
    return [];
  }
}

/** True when the settings DB has GitHub-App credentials (App mode). */
export function isAppMode(store: SettingStore): boolean {
  return Boolean(
    store.has("GITHUB_APP_ID") &&
      (store.has("GITHUB_PRIVATE_KEY") || process.env.GITHUB_PRIVATE_KEY_FILE),
  );
}
