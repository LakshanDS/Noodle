import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { log } from "../util/log.js";

/**
 * GitHub App authentication — hand-rolled, zero extra deps.
 *
 * Flow (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app):
 *  1. Build an RS256 JWT signed with the app's PEM private key
 *     (iss = app id, iat = now, exp = now + 10min).
 *  2. Exchange that JWT for a per-installation access token via
 *     POST /app/installations/{id}/access_tokens (1h TTL).
 *
 * Installation tokens are cached per-installationId and refreshed ~10 minutes
 * before expiry so the worker never stalls on a 401 mid-job.
 *
 * Kept self-contained (no `@octokit/auth-app`) to honor the stdlib-first
 * principle; if it proves fragile, swap this one module for that library.
 */

const GITHUB_API = "https://api.github.com";

/** Result of an installation-token exchange. */
export interface InstallationToken {
  token: string;
  expiresAt: number; // epoch ms
}

/**
 * Normalize a PEM private key. Allows pasted PEMs with literal "\n" (common when
 * stored as a string in the DB or pasted in the UI). Also falls back to reading
 * from a file path (GITHUB_PRIVATE_KEY_FILE env) when the inline value looks
 * like a file path — a deployment convenience for Kubernetes/Docker secrets.
 */
export function loadPrivateKey(inline?: string): string {
  if (inline && inline.trim()) {
    return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
  }
  const file = process.env.GITHUB_PRIVATE_KEY_FILE;
  if (file) return readFileSync(file, "utf8");
  throw new Error(
    "GitHub App private key not found. Set GITHUB_PRIVATE_KEY in the settings.",
  );
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/**
 * Build a signed GitHub App JWT (RS256). Exported for unit testing — the test
 * generates an RSA keypair, builds a JWT, and verifies the signature with the
 * public key.
 */
export function buildAppJwt(appId: string | number, privateKeyPem: string, now: number = Date.now()): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: Math.floor(now / 1000) - 60, // 60s skew tolerance (GitHub recommendation)
    exp: Math.floor(now / 1000) + 10 * 60, // 10 min max
    iss: String(appId),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * Mints and caches per-installation access tokens. One instance per server
 * process; safe to call concurrently (the cache write is idempotent).
 */
export class GithubAppAuth {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly cache = new Map<number, InstallationToken>();
  /** repo ("owner/name") → installation id, cached after first lookup. */
  private readonly repoInstallations = new Map<string, number>();
  /** Override for tests. Production uses global fetch. */
  private readonly fetchImpl: typeof fetch;

  constructor(opts?: {
    appId?: string;
    privateKey?: string;
    fetchImpl?: typeof fetch;
  }) {
    const appId = opts?.appId;
    const privateKey = opts?.privateKey !== undefined ? loadPrivateKey(opts.privateKey) : loadPrivateKey();
    if (!appId) throw new Error("GITHUB_APP_ID is not set.");
    this.appId = String(appId);
    this.privateKey = privateKey;
    this.fetchImpl = opts?.fetchImpl ?? fetch;
  }

  /**
   * Get a valid installation access token, refreshing from GitHub when the
   * cached one is within `refreshSkewMs` of expiry (default 10 min).
   */
  async getInstallationToken(
    installationId: number,
    refreshSkewMs: number = 10 * 60 * 1000,
  ): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt - Date.now() > refreshSkewMs) {
      return cached.token;
    }
    const fresh = await this.exchangeToken(installationId);
    this.cache.set(installationId, fresh);
    return fresh.token;
  }

  /**
   * Resolve the installation id for a repo ("owner/name") via the App's JWT.
   * This is the bootstrap path for sources with no webhook payload — cron jobs
   * and the manual "Run Now" button know the repo but not its installation id.
   * Uses App-level auth (the JWT), not an installation token (chicken-and-egg:
   * you need the id to mint the token). Results are cached per-repo.
   *
   * Returns null when the App isn't installed on the repo (404).
   */
  async getInstallationIdForRepo(repo: string): Promise<number | null> {
    const cached = this.repoInstallations.get(repo);
    if (cached !== undefined) return cached;
    const jwt = buildAppJwt(this.appId, this.privateKey);
    const res = await this.fetchImpl(`${GITHUB_API}/repos/${repo}/installation`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Failed to resolve installation for ${repo} (${res.status}): ${body.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as { id: number };
    this.repoInstallations.set(repo, data.id);
    return data.id;
  }

  /** Clear the cache (used on shutdown / forced re-auth). */
  clearCache(): void {
    this.cache.clear();
    this.repoInstallations.clear();
  }

  private async exchangeToken(installationId: number): Promise<InstallationToken> {
    const jwt = buildAppJwt(this.appId, this.privateKey);
    const res = await this.fetchImpl(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `GitHub App token exchange failed (${res.status}) for installation ${installationId}: ${body.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as { token: string; expires_at: string };
    const expiresAt = new Date(data.expires_at).getTime();
    log.debug({ installationId, expiresAt: new Date(expiresAt).toISOString() }, "minted installation token");
    return { token: data.token, expiresAt };
  }
}
