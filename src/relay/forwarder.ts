import { log } from "../util/log.js";

/**
 * Dumb pipe: forward a chat-completions request to the real provider and return
 * the response. The relay's rate limiter handles request SPACING; this module
 * handles the actual HTTP forward.
 *
 * The ONE thing it does beyond a raw proxy: retry on 429. NVIDIA NIM's free
 * tier is shared infrastructure — you can get 429'd by platform load even when
 * your own request rate is well under the limit. Retrying inside the relay
 * (with a backoff longer than the agent's) means the agent never sees these
 * transient platform 429s — from its perspective the request just took a few
 * extra seconds, like a slow network.
 *
 * It reads Retry-After when the provider sends it; otherwise uses an
 * exponential backoff (5s, 10s, 20s, 40s, 60s capped).
 */

const RETRY_429_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Headers we send on every forwarded request. */
function authHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

/** Collect response headers into a plain object. */
function collectHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/** Parse a Retry-After header (seconds or HTTP date) into ms. Returns 0 if absent/invalid. */
function parseRetryAfterMs(value: string | null): number {
  if (!value) return 0;
  const secs = Number(value);
  if (!Number.isNaN(secs)) return secs * 1000;
  const date = new Date(value).getTime();
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 0;
}

/**
 * Wait for a 429 retry: use Retry-After when present, else our exponential
 * schedule. Caps at 60s so we never hang forever.
 */
async function waitFor429Retry(headers: Record<string, string>, attempt: number): Promise<void> {
  const retryAfterMs = parseRetryAfterMs(headers["retry-after"] ?? null);
  const delay = retryAfterMs > 0
    ? Math.min(retryAfterMs, 60_000)
    : RETRY_429_DELAYS_MS[Math.min(attempt, RETRY_429_DELAYS_MS.length - 1)];
  log.warn({ delayMs: delay, retryAfter: retryAfterMs > 0, attempt: attempt + 1 }, "relay: 429 — waiting before retry");
  await sleep(delay);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Forward a non-streaming request. Retries on 429 (up to 5 times with backoff)
 * so the agent never sees transient platform rate-limiting. Other errors pass
 * straight through.
 */
export async function forwardRequest(
  baseUrl: string,
  apiKey: string,
  body: unknown,
): Promise<ForwardResult> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  for (let attempt = 0; attempt <= RETRY_429_DELAYS_MS.length; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
    });
    const headers = collectHeaders(response);

    if (response.status === 429 && attempt < RETRY_429_DELAYS_MS.length) {
      await waitFor429Retry(headers, attempt);
      continue;
    }

    const responseBody = response.status < 400 ? await response.json() : await response.text().catch(() => "");
    return { status: response.status, headers, body: responseBody };
  }

  // Exhausted all 429 retries — return the last 429 so the agent can react.
  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  const headers = collectHeaders(response);
  const errorBody = await response.text().catch(() => "");
  return { status: response.status, headers, body: errorBody };
}

/**
 * Forward a streaming request. Retries on 429 (up to 5 times with backoff)
 * BEFORE opening the SSE pipe — once streaming starts we can't retry without
 * sending partial output. Other errors throw.
 */
export async function forwardRequestStream(
  baseUrl: string,
  apiKey: string,
  body: unknown,
): Promise<{ status: number; headers: Record<string, string>; stream: ReadableStream }> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  for (let attempt = 0; attempt <= RETRY_429_DELAYS_MS.length; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
    });

    if (response.status === 429 && attempt < RETRY_429_DELAYS_MS.length) {
      const headers = collectHeaders(response);
      await response.body?.cancel().catch(() => {});
      await waitFor429Retry(headers, attempt);
      continue;
    }

    const headers = collectHeaders(response);
    if (response.status >= 400 || !response.body) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`Upstream ${response.status}: ${errorBody || response.statusText}`);
    }
    return { status: response.status, headers, stream: response.body };
  }

  // Exhausted all 429 retries — throw so the agent sees the error.
  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  const errorBody = await response.text().catch(() => "");
  throw new Error(`Upstream 429: ${errorBody || "Too Many Requests (after relay retries exhausted)"}`);
}
