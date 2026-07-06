import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Password + signed-cookie auth for the web UI, hand-rolled to match the
 * project's existing pattern (`src/github/webhook.ts` hand-rolls HMAC for
 * webhook signatures rather than reaching for a plugin). No `@fastify/cookie`,
 * no bcrypt — the password is operator-set via `NOODLE_UI_PASSWORD` and
 * compared in constant time.
 *
 * Token format (the cookie value): `base64url(payload).base64url(hmac)`, where
 * payload is `{v:1, exp}` (expiry, ms since epoch) and hmac is HMAC-SHA256 over
 * the payload using the password as the secret. The secret doubles as both the
 * password verifier AND the signing key: a wrong password can't forge a token.
 *
 * The UI layer is fail-closed: if no password is configured, `serve.ts` never
 * calls `registerUiRoutes`, so none of this runs.
 */

export const COOKIE_NAME = "noodle_auth";
/** Cookie lifetime: 7 days, in seconds (for Max-Age). */
const MAX_AGE_SEC = 7 * 24 * 60 * 60;
const MAX_AGE_MS = MAX_AGE_SEC * 1000;

const b64uEncode = (s: string): string =>
  Buffer.from(s, "utf8").toString("base64url");
const b64uDecode = (s: string): string =>
  Buffer.from(s, "base64url").toString("utf8");

/** HMAC-SHA256 over `data`, hex output — used for both password + token signing. */
function hmac(secret: string, data: string): string {
  return crypto.createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/** Constant-time string compare; returns false on length mismatch (no throw). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify the operator password in constant time. Both sides are SHA-256 hashed
 * first so the comparison is over fixed-length 32-byte digests — this makes the
 * length leak (timingSafeEqual requires equal lengths) independent of the
 * password length, matching how `verifySignature` handles the webhook secret.
 */
export function verifyPassword(guess: string, expected: string): boolean {
  const gh = crypto.createHash("sha256").update(guess, "utf8").digest();
  const eh = crypto.createHash("sha256").update(expected, "utf8").digest();
  // Both are 32 bytes by construction, so length always matches.
  return crypto.timingSafeEqual(gh, eh);
}

/** Mint a signed token for a successful login. Expires in 7 days. */
export function signToken(secret: string, now = Date.now()): string {
  const payload = JSON.stringify({ v: 1, exp: now + MAX_AGE_MS });
  const encoded = b64uEncode(payload);
  const sig = hmac(secret, encoded);
  return `${encoded}.${sig}`;
}

/** Verify a token. Returns true iff the signature matches and `exp` is in the future. */
export function verifyToken(token: string | undefined, secret: string, now = Date.now()): boolean {
  if (!token || !token.includes(".")) return false;
  const dot = token.lastIndexOf(".");
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(secret, encoded);
  if (!safeEqual(sig, expected)) return false;
  try {
    const { exp } = JSON.parse(b64uDecode(encoded)) as { v?: number; exp?: number };
    return typeof exp === "number" && exp > now;
  } catch {
    return false;
  }
}

/** Pull our cookie value out of a Cookie header, or undefined if absent. */
export function readCookie(req: FastifyRequest): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The Set-Cookie value for a fresh login. */
export function loginCookieValue(secret: string): string {
  return `${COOKIE_NAME}=${signToken(secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_SEC}`;
}

/** The Set-Cookie value that clears the cookie (logout / expiry). */
export function clearCookieValue(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * Fastify preHandler: reject the request with 401 unless the bearer of a valid
 * cookie. UI routes attach this so every `/api/*` (and the HTML shell at `/`)
 * fails closed.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply, secret: string): Promise<boolean> {
  if (verifyToken(readCookie(req), secret)) {
    return true;
  }
  await reply.code(401).send({ error: "unauthorized" });
  return false;
}
