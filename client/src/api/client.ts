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
