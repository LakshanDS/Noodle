/**
 * Thin fetch wrapper for the Noodle JSON API.
 *
 * All calls send credentials: "same-origin" so the signed auth cookie travels.
 * A 401 anywhere means the session expired — `parseBody` fires the registered
 * onUnauthorized callback (which flips the auth state and redirects to /login),
 * then throws `UnauthorizedError` so the caller's catch block can short-circuit.
 *
 * The callback is registered from composables/useAuth.ts (which can't be
 * imported here directly — circular dependency). This keeps the redirect logic
 * centralized: every API call — whether from onMounted, a click handler, or a
 * watcher — triggers the login redirect on 401 without each view needing to
 * detect UnauthorizedError individually.
 *
 * Body handling note: the production server (a shared webhook app) parses
 * application/json as a RAW string for HMAC verification, so req.body can
 * arrive as a string. We always JSON.stringify our payloads and set the right
 * content-type — the server's readJsonBody / readPassword coerce either way.
 */
import type { ApiError } from "./types.js";

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

export class ApiRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

/**
 * Check if an error is an auth failure (401). Views use this in catch blocks
 * to silently bail instead of showing a misleading error message — the global
 * 401 handler already redirects to /login.
 *
 *   } catch (e) {
 *     if (isAuthError(e)) return;
 *     loadError.value = e instanceof ApiRequestError ? e.message : "Could not load.";
 *   }
 */
export function isAuthError(e: unknown): boolean {
  return e instanceof UnauthorizedError || (e instanceof Error && e.name === "UnauthorizedError");
}

/**
 * Callback fired when any API call receives a 401. Registered by useAuth.ts at
 * app startup. Triggers the login redirect so the user never stays on a page
 * with an expired session.
 */
let onUnauthorized: (() => void) | null = null;

/** Register the global 401 handler. Called once from useAuth.ts. */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/** GET a JSON endpoint, throwing UnauthorizedError on 401. */
export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin" });
  return parseBody<T>(res);
}

/** POST/PUT/PATCH/DELETE with a JSON body. */
export async function sendJson<T>(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  return parseBody<T>(res);
}

async function parseBody<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    // Fire the global handler so the auth state flips + redirect happens,
    // no matter where this fetch was called from (onMounted, click handler, etc).
    onUnauthorized?.();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      const err = (await res.json()) as ApiError;
      if (err?.error) message = err.error;
    } catch {
      /* keep default message */
    }
    throw new ApiRequestError(message, res.status);
  }
  // 204 / empty bodies — resolve undefined as void callers expect.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export type SSECleanup = () => void;

/**
 * Open an SSE stream on `path` using `fetch` + ReadableStream reader. Uses
 * `credentials: "same-origin"` so the auth cookie travels (EventSource can't
 * set credentials on same-origin in all browsers, hence fetch-based).
 *
 * `onEvent` is called for every parsed `data:` frame (the JSON-decoded object
 * from the server). `onDone` fires once when the stream closes or an error
 * occurs. Returns a cleanup function the caller invokes on unmount / retry.
 *
 * The server emits standard SSE frames:
 *   event: <type>\ndata: {JSON}\n\n   (one per agent event)
 *   : heartbeat\n\n                    (comment, ignored by the parser)
 *   event: done\ndata: {JSON}\n\n     (terminal — triggers cleanup)
 */
export function streamSSE(
  path: string,
  onEvent: (data: Record<string, unknown>) => void,
  onDone?: () => void,
): SSECleanup {
  let active = true;
  const controller = new AbortController();

  void (async () => {
    try {
      const res = await fetch(path, {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        // Non-200 or no body — treat as no stream.
        onDone?.();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (active) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse complete SSE frames from the buffer. Frames are separated by
        // a double newline. A frame can have `event:` and `data:` lines.
        const frames = buffer.split("\n\n");
        // The last chunk is either empty or an incomplete frame — keep it in
        // the buffer for next iteration.
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          if (!frame.trim()) continue;
          // Comments (lines starting with `:`) are heartbeats — skip.
          if (frame.trimStart().startsWith(":")) continue;
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              const raw = line.slice(5).trim();
              if (!raw) continue;
              try {
                const parsed = JSON.parse(raw);
                onEvent(parsed as Record<string, unknown>);
                // The server signals the end of a turn with `event: done`.
                // Fire onDone and exit the reader loop.
                if (parsed.type === "done" || parsed.type === "error") {
                  onDone?.();
                  return;
                }
              } catch {
                // Non-JSON data line — ignore.
              }
            }
          }
        }
      }
      onDone?.();
    } catch (e) {
      // AbortController.abort() arrives here as AbortError — fire onDone so
      // the caller can clean up UI state.
      if ((e as Error).name !== "AbortError") {
        // Real stream error — log and clean up.
        console.error("[streamSSE]", (e as Error).message);
      }
      onDone?.();
    }
  })();

  return () => {
    active = false;
    controller.abort();
  };
}
