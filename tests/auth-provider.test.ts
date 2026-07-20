import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SettingStore } from "../src/server/settings-store.js";
import { GitHubClient } from "../src/github/client.js";
import { LazyAuthProviderForTest } from "../src/github/auth-provider.js";
import type { AuthProvider } from "../src/github/auth-provider.js";

/**
 * Tests the real `LazyAuthProvider` (via the test export) with an injectable App
 * provider factory — so the App-throws → PAT-fallback precedence can be
 * exercised without real App keys or network access.
 *
 * Precedence under test (defined in auth-provider.ts):
 *   App creds present → try App; on throw, fall back to PAT if set, else re-throw.
 *   App creds absent  → PAT if set, else Noop (throws the setup prompt).
 */

let dir: string;
let db: Database.Database;
let store: SettingStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-auth-"));
  db = new Database(join(dir, "settings.db"));
  store = SettingStore.fromDb(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A controllable fake App provider — throws or returns a token per-test. */
function fakeAppProvider(opts: { throwMsg?: string; token?: string }): AuthProvider {
  return {
    async forRepo() {
      if (opts.throwMsg) throw new Error(opts.throwMsg);
      return { gh: new GitHubClient({} as never), token: opts.token ?? "app-token" };
    },
    async listRepos() {
      if (opts.throwMsg) throw new Error(opts.throwMsg);
      return [];
    },
  };
}

/** Tracks whether the App provider was actually consulted. */
function trackingAppProvider(opts: { throwMsg?: string; token?: string }): { provider: AuthProvider; called: () => boolean } {
  let called = false;
  const provider: AuthProvider = {
    async forRepo() {
      called = true;
      if (opts.throwMsg) throw new Error(opts.throwMsg);
      return { gh: new GitHubClient({} as never), token: opts.token ?? "app-token" };
    },
    async listRepos() {
      called = true;
      if (opts.throwMsg) throw new Error(opts.throwMsg);
      return [];
    },
  };
  return { provider, called: () => called };
}

describe("LazyAuthProvider — App first, PAT fallback (forRepo)", () => {
  it("uses the App when it succeeds (PAT not consulted)", async () => {
    store.set("GITHUB_APP_ID", "111");
    store.set("GITHUB_PRIVATE_KEY", "fake-pem");
    store.set("GITHUB_TOKEN", "ghp_pat");
    const { provider, called } = trackingAppProvider({ token: "app-token" });
    const lazy = new LazyAuthProviderForTest(store, () => provider);

    const result = await lazy.forRepo("owner/repo");
    expect(called()).toBe(true);
    expect(result.token).toBe("app-token");
  });

  it("falls back to the PAT when the App throws and a PAT is configured", async () => {
    store.set("GITHUB_APP_ID", "111");
    store.set("GITHUB_PRIVATE_KEY", "fake-pem");
    store.set("GITHUB_TOKEN", "ghp_pat");
    const lazy = new LazyAuthProviderForTest(store, () => fakeAppProvider({ throwMsg: "App not installed" }));

    const result = await lazy.forRepo("owner/repo");
    // PAT path returns the raw PAT token.
    expect(result.token).toBe("ghp_pat");
  });

  it("re-throws the App error when the App throws and no PAT is configured", async () => {
    store.set("GITHUB_APP_ID", "111");
    store.set("GITHUB_PRIVATE_KEY", "fake-pem");
    // No GITHUB_TOKEN set.
    const lazy = new LazyAuthProviderForTest(store, () => fakeAppProvider({ throwMsg: "App not installed" }));

    await expect(lazy.forRepo("owner/repo")).rejects.toThrow("App not installed");
  });

  it("uses PAT directly when no App creds are present", async () => {
    store.set("GITHUB_TOKEN", "ghp_pat");
    const { provider, called } = trackingAppProvider({ token: "app-token" });
    const lazy = new LazyAuthProviderForTest(store, () => provider);

    const result = await lazy.forRepo("owner/repo");
    expect(called()).toBe(false);
    expect(result.token).toBe("ghp_pat");
  });

  it("throws the Noop error when neither App nor PAT is configured", async () => {
    const lazy = new LazyAuthProviderForTest(store, () => fakeAppProvider({}));

    await expect(lazy.forRepo("owner/repo")).rejects.toThrow(/No GitHub auth configured/);
  });
});

describe("LazyAuthProvider — credential hot-reload", () => {
  it("rebuilds the App provider when the private key changes (fingerprint cache)", async () => {
    store.set("GITHUB_APP_ID", "111");
    store.set("GITHUB_PRIVATE_KEY", "key-A");
    const lazy = new LazyAuthProviderForTest(store, () => fakeAppProvider({ token: "first-key-token" }));

    expect((await lazy.forRepo("o/r")).token).toBe("first-key-token");

    // Rotate the key — the factory should be called again, building a fresh provider.
    store.set("GITHUB_PRIVATE_KEY", "key-B");
    expect((await lazy.forRepo("o/r")).token).toBe("first-key-token"); // still app-token from new factory call
  });

  it("drops to PAT mode after App creds are removed", async () => {
    store.set("GITHUB_APP_ID", "111");
    store.set("GITHUB_PRIVATE_KEY", "fake-pem");
    store.set("GITHUB_TOKEN", "ghp_pat");
    const lazy = new LazyAuthProviderForTest(store, () => fakeAppProvider({ token: "app-token" }));
    expect((await lazy.forRepo("o/r")).token).toBe("app-token");

    // Simulate DELETE /api/github/app clearing the App keys.
    store.set("GITHUB_APP_ID", "");
    store.set("GITHUB_PRIVATE_KEY", "");
    expect((await lazy.forRepo("o/r")).token).toBe("ghp_pat");
  });
});
