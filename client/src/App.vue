<script setup lang="ts">
/**
 * Root shell. Two responsibilities:
 *   1. Render <RouterView/> — routing + navigation guard live in router.ts.
 *   2. Watch auth state: when a session expires mid-use (loggedIn flips to
 *      false), redirect to /login. The initial-route redirect is handled by
 *      the beforeEach guard in router.ts (registered before the initial
 *      navigation, unlike a guard added in setup()).
 */
import { computed, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "./composables/useAuth.js";

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
    if (!loggedIn && name !== "login") {
      void router.replace({ name: "login" });
    }
  },
);
</script>

<template>
  <div class="app-shell">
    <RouterView v-if="loaded" />
  </div>
</template>
