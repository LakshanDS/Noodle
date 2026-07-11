import { log } from "../util/log.js";

/**
 * Forward requests to the actual API provider. Handles:
 * - Adding the correct Authorization header
 * - Retrying on 429 with exponential backoff
 * - Respecting Retry-After headers
 * - Streaming: returns the raw Response for SSE pass-through
 */

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Forward a chat completions request to the real API (non-streaming).
 * Parses the JSON response body.
 */
export async function forwardRequest(
  baseUrl: string,
  apiKey: string,
  body: unknown,
  maxRetries = 3,
): Promise<ForwardResult> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      // Success — return immediately.
      if (response.status < 400) {
        const responseBody = await response.json();
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        return {
          status: response.status,
          headers: responseHeaders,
          body: responseBody,
        };
      }

      // 429 — Rate limited. Retry with backoff.
      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = response.headers.get("retry-after");
        const backoffMs = retryAfter
          ? parseRetryAfter(retryAfter) * 1000
          : 1000 * Math.pow(2, attempt); // exponential: 1s, 2s, 4s

        log.warn(
          { status: 429, attempt: attempt + 1, maxRetries, backoffMs },
          "relay rate limited, retrying",
        );
        await sleep(backoffMs);
        continue;
      }

      // Other errors — return as-is (don't retry 4xx except 429).
      const errorBody = await response.text().catch(() => "");
      return {
        status: response.status,
        headers: {},
        body: { error: errorBody || `HTTP ${response.status}` },
      };
    } catch (e) {
      // Network error — retry if we have attempts left.
      if (attempt < maxRetries) {
        const backoffMs = 1000 * Math.pow(2, attempt);
        log.warn(
          { err: (e as Error).message, attempt: attempt + 1, maxRetries },
          "relay network error, retrying",
        );
        await sleep(backoffMs);
        continue;
      }
      throw e;
    }
  }

  // Should never reach here, but TypeScript wants it.
  throw new Error("relay: max retries exceeded");
}

/**
 * Forward a streaming chat completions request. Returns the raw fetch Response
 * so the caller can pipe the SSE stream directly to the client.
 *
 * Does NOT retry on 429 for streaming — the client handles reconnection.
 */
export async function forwardRequestStream(
  baseUrl: string,
  apiKey: string,
  body: unknown,
): Promise<{ status: number; headers: Record<string, string>; stream: ReadableStream }> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (response.status >= 400) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Upstream ${response.status}: ${errorBody || response.statusText}`);
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  if (!response.body) {
    throw new Error("Upstream returned no body for streaming response");
  }

  return {
    status: response.status,
    headers: responseHeaders,
    stream: response.body,
  };
}

function parseRetryAfter(value: string): number {
  const seconds = parseInt(value, 10);
  return isNaN(seconds) ? 5 : seconds;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
