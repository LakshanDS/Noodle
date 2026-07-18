/**
 * Auth state + login/logout. A tiny shared reactive module (one singleton),
 * since there's exactly one session per page load.
 *
 * On boot we probe GET /api/runs: a 200 means the cookie is valid, anything
 * else means we need the login screen. This mirrors the original UI's init().
 */
import { reactive } from "vue";
import { getJson, sendJson, setUnauthorizedHandler } from "../api/client.js";

interface AuthState {
  /** null = not yet probed; true = logged in; false = needs login. */
  known: boolean | null;
  loggedIn: boolean;
  /** True while a login attempt is in flight. */
  loggingIn: boolean;
}

const state = reactive<AuthState>({ known: null, loggedIn: false, loggingIn: false });

/** Whether the global 401 handler is active. Suppressed during probeAuth so
 *  the initial 401 doesn't fire markLoggedOut twice (probeAuth sets the state
 *  directly; the handler is for mid-session expiry only). */
let handlerActive = false;

/** Probe the cookie; sets known + loggedIn. Call once at app start. */
export async function probeAuth(): Promise<void> {
  try {
    await getJson("/api/runs");
    state.known = true;
    state.loggedIn = true;
  } catch (e) {
    state.known = true;
    state.loggedIn = false;
  }
  // Activate the global 401 handler after the probe — subsequent 401s are
  // mid-session expirations that need the redirect.
  handlerActive = true;
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

// Register the global 401 handler: any API call that receives a 401 triggers
// the handler, which flips state.loggedIn → false → the watcher in App.vue
// redirects to /login. Suppressed during probeAuth (the initial probe handles
// the not-logged-in state directly; the handler is for mid-session expiry).
setUnauthorizedHandler(() => {
  if (handlerActive) markLoggedOut();
});

export function useAuth() {
  return { state };
}
