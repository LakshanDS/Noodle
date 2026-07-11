/**
 * Auth state + login/logout. A tiny shared reactive module (one singleton),
 * since there's exactly one session per page load.
 *
 * On boot we probe GET /api/runs: a 200 means the cookie is valid, anything
 * else means we need the login screen. This mirrors the original UI's init().
 */
import { reactive } from "vue";
import { getJson, sendJson, UnauthorizedError } from "../api/client.js";

interface AuthState {
  /** null = not yet probed; true = logged in; false = needs login. */
  known: boolean | null;
  loggedIn: boolean;
  /** True while a login attempt is in flight. */
  loggingIn: boolean;
}

const state = reactive<AuthState>({ known: null, loggedIn: false, loggingIn: false });

/** Probe the cookie; sets known + loggedIn. Call once at app start. */
export async function probeAuth(): Promise<void> {
  try {
    await getJson("/api/runs");
    state.known = true;
    state.loggedIn = true;
  } catch (e) {
    state.known = true;
    state.loggedIn = e instanceof UnauthorizedError ? false : false;
  }
}

/** Submit the password; resolves true on success. */
export async function login(password: string): Promise<boolean> {
  state.loggingIn = true;
  try {
    await sendJson("/api/login", "POST", { password });
    state.loggedIn = true;
    return true;
  } finally {
    state.loggingIn = false;
  }
}

/** Clear the cookie server-side. */
export async function logout(): Promise<void> {
  try {
    await sendJson("/api/logout", "POST");
  } catch {
    /* ignore — we navigate to login regardless */
  }
  state.loggedIn = false;
}

/** Mark the session as lapsed (after a 401 mid-use). */
export function markLoggedOut(): void {
  state.loggedIn = false;
}

export function useAuth() {
  return { state };
}
