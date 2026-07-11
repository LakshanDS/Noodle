<script setup lang="ts">
/**
 * Password login — a full-screen centered card, outside the app shell (you can't
 * show a sidebar to someone who isn't authed yet). A faint accent glow behind
 * the card gives the screen depth without busy decoration.
 */
import { ref } from "vue";
import { useRouter } from "vue-router";
import { login, useAuth } from "../composables/useAuth.js";
import { ApiRequestError } from "../api/client.js";
import Icon from "../components/ui/Icon.vue";

const router = useRouter();
const { state } = useAuth();

const password = ref("");
const errorMsg = ref("");

async function onSubmit(): Promise<void> {
  errorMsg.value = "";
  if (!password.value) return;
  try {
    await login(password.value);
    password.value = "";
    await router.push({ name: "runs" });
  } catch (e) {
    password.value = "";
    errorMsg.value = e instanceof ApiRequestError ? "Wrong password" : "Could not reach server";
  }
}
</script>

<template>
  <div class="login-screen">
    <div class="ambient" aria-hidden="true" />
    <form class="login-card" autocomplete="on" @submit.prevent="onSubmit">
      <div class="brand-row">
        <span class="brand-mark"><Icon name="logo" :size="22" /></span>
        <span class="brand-name">Noodle</span>
      </div>

      <h1 class="title">Sign in</h1>
      <p class="sub">Enter your password to open the dashboard.</p>

      <div class="input-wrap">
        <span class="input-ico"><Icon name="lock" :size="16" /></span>
        <input
          v-model="password"
          :type="'password'"
          name="password"
          placeholder="Password"
          autocomplete="current-password"
          :disabled="state.loggingIn"
          :class="{ error: errorMsg }"
        />
      </div>

      <div class="err" role="alert">{{ errorMsg }}</div>

      <button type="submit" class="submit" :disabled="state.loggingIn || !password">
        <span v-if="state.loggingIn" class="spinner" />
        {{ state.loggingIn ? "Signing in…" : "Sign in" }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100dvh;
  position: relative;
  overflow: hidden;
}
/* A soft accent glow anchored behind the card — the only decoration. */
.ambient {
  position: absolute;
  width: 520px;
  height: 520px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--accent-weaker) 0%, transparent 60%);
  filter: blur(40px);
  pointer-events: none;
}

.login-card {
  position: relative;
  width: 100%;
  max-width: 360px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: var(--space-8);
  box-shadow: var(--shadow-lg);
}

.brand-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-8);
}
.brand-mark {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background: var(--accent-weak);
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
}
.brand-name {
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  color: var(--text);
}

.title {
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  margin-bottom: var(--space-1);
}
.sub {
  font-size: var(--text-sm);
  color: var(--text-2);
  margin-bottom: var(--space-6);
}

.input-wrap {
  position: relative;
  margin-bottom: var(--space-2);
}
.input-ico {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
  display: flex;
}
input {
  width: 100%;
  height: 42px;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text);
  font-size: var(--text-sm);
  padding: 0 12px 0 38px;
  transition:
    border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}
input::placeholder {
  color: var(--text-3);
}
input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weaker);
}
input.error {
  border-color: var(--danger);
}

.err {
  color: var(--danger);
  font-size: var(--text-xs);
  min-height: 18px;
  margin-bottom: var(--space-3);
}

.submit {
  width: 100%;
  height: 42px;
  border-radius: var(--radius-md);
  background: var(--accent);
  color: var(--text-inverse);
  font-weight: var(--weight-semibold);
  font-size: var(--text-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  transition:
    background var(--dur-fast) var(--ease),
    opacity var(--dur-fast) var(--ease);
}
.submit:not(:disabled):hover {
  background: var(--accent-hover);
}
.submit:disabled {
  opacity: 0.5;
}
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-bottom-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
