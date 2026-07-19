<script setup lang="ts">
/**
 * The application shell: a fixed sidebar on the left and a main content column
 * on the right. No full-width top bar — instead each page's contextual actions
 * (refresh, new, save, …) float in an elevated panel pinned to the top-right of
 * the content area. On mobile the hamburger + brand join the actions inside
 * that same panel, so there's no separate mobile header bar. The active sidebar
 * item indicates the current page, so no page title is shown.
 *
 * The sidebar holds the brand, primary nav (Runs / Crons / Settings), and a
 * footer with the sign-out action. The default slot is the page body, centered
 * with a max width.
 *
 * Login + Setup opt out of the shell (they're full-screen), so this component
 * is only mounted by the authed views.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import Icon from "./ui/Icon.vue";
import { logout } from "../composables/useAuth.js";

const route = useRoute();
const router = useRouter();

/** Mobile drawer state. On desktop (≥768px) the sidebar is always visible and
 * this ref has no effect. Below the breakpoint it drives the slide-in drawer. */
const sidebarOpen = ref(false);

interface NavItem {
  name: string;
  label: string;
  icon: string;
  target: { name: string };
  /** Routes that should highlight this nav item. */
  activeOn: string[];
  /** If set, a "+" button is revealed on hover. Holds the create route + the
   *  tooltip label (e.g. "New schedule"). */
  create?: { name: string; label: string };
}

const NAV: NavItem[] = [
  { name: "runs", label: "Runs", icon: "runs", target: { name: "runs" }, activeOn: ["runs", "run-detail"] },
  { name: "chats", label: "Chats", icon: "message", target: { name: "chats" }, activeOn: ["chats", "chat-detail"], create: { name: "chats", label: "New chat" } },
  { name: "skills", label: "Skills", icon: "book", target: { name: "skills" }, activeOn: ["skills", "skill-detail", "skill-new"], create: { name: "skill-new", label: "New skill" } },
  { name: "profiles", label: "Profiles", icon: "key", target: { name: "profiles" }, activeOn: ["profiles", "profile-detail", "profile-new"], create: { name: "profile-new", label: "New profile" } },
  { name: "triggers", label: "Triggers", icon: "zap", target: { name: "triggers" }, activeOn: ["triggers", "trigger-detail", "trigger-new"], create: { name: "trigger-new", label: "New trigger" } },
  { name: "schedulers", label: "Schedules", icon: "cron", target: { name: "schedulers" }, activeOn: ["schedulers", "scheduler-detail", "scheduler-new"], create: { name: "scheduler-new", label: "New schedule" } },
  { name: "commands", label: "Commands", icon: "command", target: { name: "commands" }, activeOn: ["commands", "command-detail", "command-new"], create: { name: "command-new", label: "New command" } },
  // GitHub bot moved to Settings page — credentials are now a section there.
  { name: "logs", label: "System log", icon: "log", target: { name: "logs" }, activeOn: ["logs"] },
  { name: "settings", label: "Settings", icon: "settings", target: { name: "settings" }, activeOn: ["settings"] },
];

const activeGroup = computed(() => {
  const n = String(route.name ?? "");
  return NAV.find((item) => item.activeOn.includes(n))?.name ?? null;
});

function go(item: NavItem): void {
  void router.push(item.target);
  sidebarOpen.value = false;
}

/** The hover "+" button: navigates to the item's create route. */
function createItem(item: NavItem): void {
  if (item.create) void router.push(item.create);
  sidebarOpen.value = false;
}

async function onLogout(): Promise<void> {
  await logout();
  await router.replace({ name: "login" });
}

/** Auto-close the drawer when the route changes (e.g. after tapping a nav item
 *  that doesn't call go(), like back/forward). */
watch(
  () => route.name,
  () => {
    sidebarOpen.value = false;
  },
);

/** Close the drawer on Escape — standard dismiss affordance. */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && sidebarOpen.value) sidebarOpen.value = false;
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="shell">
    <!-- Backdrop — dims the page behind the open drawer, click closes it. -->
    <div v-if="sidebarOpen" class="backdrop" @click="sidebarOpen = false" />

    <!-- Sidebar -->
    <aside class="sidebar" :class="{ open: sidebarOpen }">
      <div class="brand">
        <span class="brand-mark"><Icon name="logo" :size="20" /></span>
        <span class="brand-name">Noodle</span>
      </div>

      <nav class="nav">
        <div
          v-for="item in NAV"
          :key="item.name"
          class="nav-item"
          :class="{ active: activeGroup === item.name }"
        >
          <button class="nav-link" @click="go(item)">
            <Icon :name="item.icon" :size="17" />
            <span>{{ item.label }}</span>
          </button>
          <button
            v-if="item.create"
            class="nav-add"
            :title="item.create.label"
            @click.stop="createItem(item)"
          >
            <Icon name="plus" :size="14" />
          </button>
        </div>
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
      <main class="content">
        <!-- Both the action panel and the page body live inside the same
             centered box (.content-inner), which lives inside the same scroll
             container (.content). That means the panel shares one coordinate
             system with the cards — including the scrollbar gutter — so its
             right edge lines up with the cards' right edge exactly, on every
             page, scroll or no scroll. -->
        <div class="content-inner">
          <div class="action-panel">
            <!-- On mobile the hamburger + brand live inside this panel, so
                 there's no separate top bar. On desktop these are hidden. -->
            <button
              class="hamburger"
              :aria-expanded="sidebarOpen"
              aria-label="Menu"
              @click="sidebarOpen = !sidebarOpen"
            >
              <Icon name="menu" :size="20" />
            </button>
            <span class="panel-brand">
              <Icon name="logo" :size="18" />
              <span>Noodle</span>
            </span>
            <slot name="actions" />
          </div>
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
/* .nav-item is now a row wrapper holding the nav link + an optional hover-only
 * "+" button. The row carries the hover/active surface treatment. */
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  height: 34px;
  border-radius: var(--radius-md);
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
.nav-link {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: inherit;
  text-align: left;
}
/* Hover-revealed "+" — creates a new item for this section. Hidden by default,
 * fades in on row hover. No background chip: the only hover affordance is the
 * icon scaling up + thickening its stroke (reads as "bold"). */
.nav-add {
  flex: 0 0 auto;
  margin-right: var(--space-2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}
.nav-add :deep(svg) {
  transition:
    transform var(--dur-fast) var(--ease),
    stroke-width var(--dur-fast) var(--ease);
}
.nav-item:hover > .nav-add {
  opacity: 1;
}
.nav-add:hover {
  color: var(--text);
}
.nav-add:hover :deep(svg) {
  transform: scale(1.18);
  stroke-width: 2.4;
}

.sidebar-foot {
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}
/* The sign-out button reuses .nav-item for its hover/height treatment, but
 * unlike the rows above it has no inner .nav-link to carry the indent. Mirror
 * that indent here so the icon + label line up with the nav rows on both
 * desktop and mobile. */
.sidebar-foot .nav-item {
  width: 100%;
  gap: var(--space-3);
  padding: 0 var(--space-3);
}

/* ---------- Main column ---------- */
/* .main is the scroll container for the whole page. The action panel and the
 * page body both live inside the same centered box within it, so they share
 * one coordinate system (scrollbar gutter included) and always align. */
.main {
  min-width: 0;
  height: 100dvh;
  overflow-y: auto;
  /* Reserve a scrollbar gutter on every page so the centered content box keeps
   * a constant width whether or not the page scrolls. */
  scrollbar-gutter: stable;
  /* Top padding = the gap above the floating panel. The panel itself occupies
   * real flow space below, pushing the first card clear of it. */
  padding: var(--space-4) var(--space-6) var(--space-6);
}
.content-inner {
  max-width: var(--content-max);
  margin: 0 auto;
  position: relative;
}

/* Floating action panel — elevated, no full-width bar. It sits at the top of
 * .content-inner (the same centered box as the page cards) and is sticky, so
 * it rides along as the page scrolls. `margin-left: auto` right-aligns it to
 * the box's right edge = the cards' right edge, exactly.
 *
 * It occupies real vertical space (no overlap): its own height + the bottom
 * margin gap pushes the first card below it, and `top: 0` keeps it pinned to
 * the top of the scroll container as you scroll. Fixed height; width flexes
 * with its contents (1 button → narrow, a select → wider). */
.action-panel {
  position: sticky;
  top: 0;
  z-index: 20;
  width: fit-content;
  margin-left: auto;
  margin-bottom: var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 44px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--surface-2) 92%, transparent);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-md);
  backdrop-filter: blur(8px);
  white-space: nowrap;
}

/* Hamburger + in-panel brand are mobile-only; hidden on desktop where the
 * sidebar brand is always visible. */
.hamburger {
  display: none;
}
.panel-brand {
  display: none;
}

/* ---------- Mobile (≤768px) ----------
 * No separate top bar: the sidebar becomes a slide-in drawer, and the hamburger
 * + brand move into the floating action panel — one elevated bar across the
 * top (brand left, actions right). Content padding shrinks to reclaim
 * horizontal space on phones. */
.backdrop {
  display: none;
}

@media (max-width: 768px) {
  .shell {
    grid-template-columns: 1fr;
  }

  /* Hamburger + in-panel brand now visible inside the action panel. */
  .hamburger {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    flex: 0 0 auto;
    border-radius: var(--radius-md);
    color: var(--text-2);
  }
  .hamburger:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .panel-brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
    color: var(--text);
    /* Push everything after the brand (the page actions) to the right edge. */
    margin-right: auto;
  }
  .panel-brand :deep(svg) {
    color: var(--accent);
  }

  /* Sidebar — off-canvas drawer, slides in via .open. */
  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(280px, 85vw);
    z-index: 40;
    transform: translateX(-100%);
    transition: transform var(--dur) var(--ease);
    box-shadow: var(--shadow-lg);
  }
  .sidebar.open {
    transform: translateX(0);
  }
  .nav-item {
    min-height: 44px;
  }
  /* Widen the row gap on mobile so the taller 44px pills read as separate
   * items instead of a cramped stack. Desktop keeps the tight 2px density. */
  .nav {
    gap: var(--space-1);
  }

  /* Backdrop dims + dismisses. */
  .backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 35;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px);
  }

  /* Content reclaims horizontal space. */
  .main {
    height: 100dvh;
    min-height: 0;
    /* Disable the desktop scrollbar gutter — it wastes width on mobile. */
    scrollbar-gutter: auto;
    padding: var(--space-3) var(--space-3) var(--space-6);
  }
  /* The panel becomes a full-width header bar: brand on the left, page actions
   * pushed to the right by the brand's margin-right: auto. Height is auto so it
   * can grow to fit wrapped actions (e.g. the log page's select + 2 buttons) —
   * the desktop fixed height would clip the second row. Vertical padding gives
   * the buttons clearance so their hover backgrounds don't touch the panel's
   * top/bottom border (the base rule has 0 vertical padding). */
  .action-panel {
    /* Drop sticky on mobile — it's a simple header bar that scrolls with the
     * page. Without sticky the panel's containing block is .content-inner
     * (not the scroll container .main), so width:100% stretches it to the
     * exact same box the cards use → edges align perfectly. */
    position: static;
    width: 100%;
    box-sizing: border-box;
    height: auto;
    min-height: 44px;
    /* Vertical padding keeps button hover bg clear of the top/bottom border;
     * horizontal padding is larger so the right-aligned button cluster has the
     * same breathing room on the right edge as it does top/bottom (the buttons
     * were visually crammed against the right border). */
    padding: var(--space-1) var(--space-2);
    /* Full-bleed header (margin 0) but restore the bottom gap the desktop rule
     * provides — without it the header sits hard against the first card. */
    margin: 0 0 var(--space-4);
    justify-content: flex-end;
    flex-wrap: wrap;
    white-space: normal;
  }
}
</style>

<!--
  Global (unscoped) — hide button text labels on mobile so action panels stay
  compact (icon-only buttons). Each view wraps its label text in <span class="btn-label">.
-->
<style>
@media (max-width: 768px) {
  .btn-label {
    display: none;
  }
}
</style>
