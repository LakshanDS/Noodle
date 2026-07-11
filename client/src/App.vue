<script setup lang="ts">
/**
 * Root shell. Two responsibilities:
 *   1. Render <RouterView/> — all routing is hash-based (see router.ts).
 *   2. Guard navigation: until auth is probed, show nothing; if not logged in
 *      and on any route other than /login (or /setup, a future first-run
 *      exception), bounce to /login. On a 401 mid-session, the auth composable
 *      flips loggedIn and this guard catches it.
 */
import { computed, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuth, markLoggedOut } from "./composables/useAuth.js";
import { UnauthorizedError } from "./api/client.js";

const router = useRouter();
const { state } = useAuth();

// While auth is unknown, the shell renders blank (avoids a login flash for an
// already-valid session). probeAuth() in main.ts resolves this before mount.
const loaded = computed(() => state.known === true);

// When the session lapses (loggedIn flips to false), bounce to /login unless
// we're already on a public route.
watch(
  () => state.loggedIn,
  (loggedIn) => {
    const name = router.currentRoute.value.name;
    if (!loggedIn && name !== "login" && name !== "setup") {
      void router.replace({ name: "login" });
    }
  },
);

// Navigation guard: require login for everything except /login and /setup.
router.beforeEach((to) => {
  if (state.known !== true) return true; // still probing — allow through; the shell guards render
  const publicRoutes = new Set(["login", "setup"]);
  if (!publicRoutes.has(String(to.name)) && !state.loggedIn) {
    return { name: "login" };
  }
  // If already logged in and somehow on /login, go to runs.
  if (to.name === "login" && state.loggedIn) {
    return { name: "runs" };
  }
  return true;
});

// Surface UnauthorizedError from async view setup. Views call into the API
// directly and may reject; re-derive loggedIn from the error type here.
router.onError((err) => {
  if (err instanceof UnauthorizedError) markLoggedOut();
});
</script>

<template>
  <div class="app-shell">
    <RouterView v-if="loaded" />
  </div>
</template>
