<script setup lang="ts">
/**
 * The application shell: a fixed sidebar on the left and a main content column
 * on the right. This is the desktop-first control-panel layout (Linear / Vercel
 * / Stripe), replacing the old mobile bottom-tab shell.
 *
 * The sidebar holds the brand, primary nav (Runs / Crons / Settings), and a
 * footer with the sign-out action. The top bar renders the current page title
 * and a trailing slot for contextual actions (refresh, cancel, etc.). The
 * default slot is the page body, centered with a max width.
 *
 * Login + Setup opt out of the shell (they're full-screen), so this component
 * is only mounted by the authed views.
 */
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import Icon from "./ui/Icon.vue";
import { logout } from "../composables/useAuth.js";

const route = useRoute();
const router = useRouter();

interface NavItem {
  name: string;
  label: string;
  icon: string;
  target: { name: string };
  /** Routes that should highlight this nav item. */
  activeOn: string[];
}

const NAV: NavItem[] = [
  { name: "runs", label: "Runs", icon: "runs", target: { name: "runs" }, activeOn: ["runs", "run-detail"] },
  { name: "crons", label: "Crons", icon: "cron", target: { name: "crons" }, activeOn: ["crons", "cron-detail", "cron-new"] },
  { name: "settings", label: "Settings", icon: "settings", target: { name: "settings" }, activeOn: ["settings"] },
];

const activeGroup = computed(() => {
  const n = String(route.name ?? "");
  return NAV.find((item) => item.activeOn.includes(n))?.name ?? null;
});

const pageTitle = computed(() => {
  const map: Record<string, string> = {
    runs: "Runs",
    "run-detail": "Run detail",
    crons: "Crons",
    "cron-detail": "Edit cron",
    "cron-new": "New cron",
    settings: "Settings",
  };
  return map[String(route.name ?? "")] ?? "Dashboard";
});

function go(item: NavItem): void {
  void router.push(item.target);
}

async function onLogout(): Promise<void> {
  await logout();
  await router.replace({ name: "login" });
}
</script>

<template>
  <div class="shell">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark"><Icon name="logo" :size="20" /></span>
        <span class="brand-name">Noodle</span>
      </div>

      <nav class="nav">
        <button
          v-for="item in NAV"
          :key="item.name"
          class="nav-item"
          :class="{ active: activeGroup === item.name }"
          @click="go(item)"
        >
          <Icon :name="item.icon" :size="17" />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <div class="sidebar-foot">
        <button class="nav-item" @click="onLogout">
          <Icon name="logout" :size="17" />
          <span>Sign out</span>
        </button>
      </div>
    </aside>

    <!-- Main column -->
    <div class="main">
      <header class="topbar">
        <h1 class="page-title">{{ pageTitle }}</h1>
        <div class="topbar-actions">
          <slot name="actions" />
        </div>
      </header>

      <main class="content">
        <div class="content-inner">
          <slot />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
  height: 100dvh;
  background: var(--surface-0);
}

/* ---------- Sidebar ---------- */
.sidebar {
  display: flex;
  flex-direction: column;
  background: var(--surface-1);
  border-right: 1px solid var(--border);
  padding: var(--space-4) var(--space-3);
  height: 100dvh;
  position: sticky;
  top: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2-5, 10px);
  padding: var(--space-2) var(--space-3) var(--space-5);
}
.brand-mark {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background: var(--accent-weak);
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
}
.brand-name {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  color: var(--text);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: 34px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-2);
  width: 100%;
  text-align: left;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.nav-item:hover {
  background: var(--surface-2);
  color: var(--text);
}
.nav-item.active {
  background: var(--accent-weak);
  color: var(--accent);
}

.sidebar-foot {
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

/* ---------- Main column ---------- */
.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100dvh;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  height: var(--topbar-h);
  padding: 0 var(--space-6);
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-0) 80%, transparent);
  backdrop-filter: blur(8px);
  position: sticky;
  top: 0;
  z-index: 10;
}
.page-title {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  color: var(--text);
}
.topbar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.content {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: var(--space-6);
}
.content-inner {
  max-width: var(--content-max);
  margin: 0 auto;
}
</style>
