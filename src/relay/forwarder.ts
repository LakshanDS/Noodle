/**
 * Dumb pipe: forward a chat-completions request to the real provider and return
 * the response. The relay's rate limiter handles ALL timing — this module does
 * no retrying, no Retry-After parsing, no backoff. Whatever the provider
 * returns (success, 429, 5xx) is passed straight through to the agent.
 *
 * Two shapes: non-streaming (returns parsed JSON) and streaming (returns the
 * raw ReadableStream for SSE pass-through).
 */

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

/**
 * Forward a non-streaming request. Returns the parsed JSON body + status.
 * No retries — the rate limiter is the only timing authority.
 */
export async function forwardRequest(
  baseUrl: string,
  apiKey: string,
  body: unknown,
): Promise<ForwardResult> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  const headers = collectHeaders(response);
  const responseBody = response.status < 400 ? await response.json() : await response.text().catch(() => "");
  return { status: response.status, headers, body: responseBody };
}

/**
 * Forward a streaming request. Returns the raw fetch Response so the caller can
 * pipe the SSE stream directly. No retries.
 */
export async function forwardRequestStream(
  baseUrl: string,
  apiKey: string,
  body: unknown,
): Promise<{ status: number; headers: Record<string, string>; stream: ReadableStream }> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  const headers = collectHeaders(response);

  if (response.status >= 400 || !response.body) {
    // Read the error body so the caller can surface it.
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Upstream ${response.status}: ${errorBody || response.statusText}`);
  }

  return { status: response.status, headers, stream: response.body };
}
