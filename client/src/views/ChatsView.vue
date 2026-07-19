<script setup lang="ts">
/**
 * Chats landing — the composer-first entry point for the Chats feature.
 *
 * Not a list view anymore: the page is a centered composer card (repo, branch,
 * textarea, profile, thinking level) that creates a chat on first send and
 * hands the prompt off to ChatDetailView. Below the composer, a compact
 * "Recent chats" list lets the user resume a prior session.
 *
 * Prefill rule: if at least one chat already exists, the composer is seeded
 * from the most recent chat's repo / branch / profile / thinking so a
 * returning user can just type. When no chat exists yet, every selector
 * starts at its "Select…" placeholder and Send is blocked until repo + branch
 * are chosen.
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getJson, sendJson, isAuthError } from "../api/client.js";
import type {
  ChatsResponse,
  ChatRow,
  ChatMutationResponse,
  NewChatInput,
  ProfilesResponse,
  ProfileListItem,
  ReposResponse,
  BranchesResponse,
  ThinkingLevel,
} from "../api/types.js";
import { fmtTime } from "../lib/format.js";
import { setPendingFirstMessage } from "../lib/pending-chat.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Select from "../components/ui/Select.vue";
import type { SelectOption } from "../components/ui/Select.vue";
import Icon from "../components/ui/Icon.vue";

const router = useRouter();

/* ---- Thinking levels (mirror ProfileDetailView's selector) ---- */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_THINKING: ThinkingLevel = "medium";

/* ---- Data ---- */
const chats = ref<ChatRow[]>([]);
const repos = ref<{ full_name: string; default_branch: string }[]>([]);
const branches = ref<string[]>([]);
const profiles = ref<ProfileListItem[]>([]);
const defaultProfile = ref("");

/* ---- Composer state ---- */
const selectedRepo = ref("");
const selectedBranch = ref("");
const selectedProfile = ref<string>("");
const selectedThinking = ref<ThinkingLevel>(DEFAULT_THINKING);
const draft = ref("");
const sending = ref(false);

/* ---- Loading / errors ---- */
const loading = ref(false);
const loadError = ref("");
const sendError = ref("");
/** Repo dropdown loads in the background (live GitHub API call — slow). The
 *  recent list + profile/thinking selectors render immediately off the DB. */
const reposLoading = ref(false);

/** Recent-chats panel: collapsed by default, shows as a peeking bottom-right
 *  chip. Toggles on chip click; closes on outside click / Escape. */
const recentOpen = ref(false);

const profileOptions = computed<SelectOption[]>(() => {
  const opts: SelectOption[] = [];
  // The instance default profile is offered as a labelled "Instance default"
  // entry whose value is "" — that's how the server stores "no explicit pin".
  opts.push({ value: "", label: defaultProfile.value ? `Default (${defaultProfile.value})` : "Instance default" });
  for (const p of profiles.value) opts.push({ value: p.name, label: p.name });
  return opts;
});

const thinkingOptions = computed<SelectOption[]>(() =>
  THINKING_LEVELS.map((l) => ({ value: l, label: l })),
);

const repoOptions = computed<SelectOption[]>(() => {
  if (reposLoading.value && repos.value.length === 0) {
    return [{ value: "", label: "Loading repos…" }];
  }
  return [
    { value: "", label: "Select repo…" },
    ...repos.value.map((r) => ({ value: r.full_name, label: r.full_name })),
  ];
});

const branchOptions = computed<SelectOption[]>(() => [
  { value: "", label: "Select branch…" },
  ...branches.value.map((b) => ({ value: b, label: b })),
]);

const canSend = computed(() => {
  if (sending.value) return false;
  if (!selectedRepo.value || !selectedBranch.value) return false;
  return draft.value.trim().length > 0;
});

/* ---- Load on mount ----
 *
 * Two phases so the recent list shows instantly:
 *  1. Fast (awaited): /api/chats + /api/profiles — both DB-backed, milliseconds.
 *     The recent list renders here, and the composer prefills from the newest
 *     chat (repo/branch text set even before the repo dropdown is populated).
 *  2. Slow (background): /api/github/repos — a live GitHub API call that can
 *     take seconds. Fires without blocking phase 1. When it lands, the repo
 *     dropdown fills and the prefilled repo's branches load behind it.
 */
async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const [chatsRes, profilesRes] = await Promise.all([
      getJson<ChatsResponse>("/api/chats"),
      getJson<ProfilesResponse>("/api/profiles"),
    ]);
    chats.value = chatsRes.chats ?? [];
    profiles.value = profilesRes.items ?? [];
    defaultProfile.value = profilesRes.default ?? "";

    // Prefill from the most recent chat (if any) so a returning user can
    // just start typing. New users land on "Select…" placeholders.
    const latest = chats.value[0];
    if (latest) {
      selectedRepo.value = latest.repo;
      selectedThinking.value = latest.thinking_level ?? DEFAULT_THINKING;
      selectedProfile.value = latest.profile ?? "";
      selectedBranch.value = latest.branch;
      // Branches are repo-scoped — load in the background so the recent list
      // isn't held up by another live GitHub call.
      void loadBranches(latest.repo);
    } else {
      selectedProfile.value = ""; // instance default
      selectedThinking.value = DEFAULT_THINKING;
    }
  } catch (e) {
    if (!isAuthError(e)) loadError.value = "Could not load chats or profiles.";
  } finally {
    loading.value = false;
  }

  // Phase 2: repo dropdown (slow GitHub call) — never blocks the UI. Errors
  // are surfaced as an empty repo list; the user can retry via Refresh.
  reposLoading.value = true;
  try {
    const reposRes = await getJson<ReposResponse>("/api/github/repos");
    repos.value = reposRes.repos ?? [];
  } catch (e) {
    if (!isAuthError(e)) repos.value = [];
  } finally {
    reposLoading.value = false;
  }
}

async function loadBranches(repo: string): Promise<void> {
  branches.value = [];
  if (!repo) return;
  const [owner, name] = repo.split("/");
  if (!owner || !name) return;
  try {
    const res = await getJson<BranchesResponse>(`/api/github/repos/${owner}/${name}/branches`);
    branches.value = (res.branches ?? []).map((b) => b.name);
  } catch {
    /* keep branches empty — user can re-pick the repo to retry */
  }
}

async function onRepoChange(): Promise<void> {
  selectedBranch.value = "";
  await loadBranches(selectedRepo.value);
  // Default-branch pre-selection: try the repo's default, else first branch.
  const repo = repos.value.find((r) => r.full_name === selectedRepo.value);
  const def = repo?.default_branch;
  if (def && branches.value.includes(def)) selectedBranch.value = def;
  else if (branches.value.length > 0) selectedBranch.value = branches.value[0];
}

/* ---- Send: create the chat + hand off the prompt to ChatDetailView ---- */
async function send(): Promise<void> {
  const text = draft.value.trim();
  sendError.value = "";
  if (!text) return;
  if (!selectedRepo.value || !selectedBranch.value) {
    sendError.value = "Pick a repo and branch first.";
    return;
  }
  if (sending.value) return;
  sending.value = true;
  try {
    // Derive a useful title from the first ~60 chars so the recent list isn't
    // a wall of "New chat" rows.
    const title = text.length > 60 ? text.slice(0, 60).trim() + "…" : text;
    const payload: NewChatInput = {
      repo: selectedRepo.value,
      branch: selectedBranch.value,
      profile: selectedProfile.value || null,
      thinking_level: selectedThinking.value,
      title,
    };
    const { chat: created } = await sendJson<ChatMutationResponse>("/api/chats", "POST", payload);
    setPendingFirstMessage(text);
    void router.replace({ name: "chat-detail", params: { id: String(created.id) } });
  } catch (e) {
    if (!isAuthError(e)) {
      sendError.value = e instanceof Error ? e.message : "Could not start chat.";
    }
  } finally {
    sending.value = false;
  }
}

function open(id: number): void {
  void router.push({ name: "chat-detail", params: { id: String(id) } });
}

/* ---- Keyboard: Enter sends, Shift+Enter newline ---- */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

/** Status pill colour class — reused verbatim from the old list view. */
function statusClass(status: string): string {
  if (status === "running") return "status-running";
  if (status === "errored") return "status-errored";
  return "status-idle";
}

/** Auto-grow the textarea up to a sane cap. */
function autosize(e: Event): void {
  const el = e.target as HTMLTextAreaElement;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

/** Close the recent panel when clicking outside it (or its chip). */
function onDocClick(e: MouseEvent): void {
  if (!recentOpen.value) return;
  const target = e.target as Node | null;
  if (!target) return;
  // The panel + chip both live in `.recent-anchor`; clicks inside either are
  // handled by their own handlers. Anything else closes the panel.
  const anchor = document.querySelector(".recent-anchor");
  if (anchor && !anchor.contains(target)) recentOpen.value = false;
}

/** Escape closes the panel (standard dismiss affordance). */
function onPanelKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && recentOpen.value) recentOpen.value = false;
}

onMounted(() => {
  load();
  document.addEventListener("mousedown", onDocClick);
  window.addEventListener("keydown", onPanelKeydown);
});
onUnmounted(() => {
  document.removeEventListener("mousedown", onDocClick);
  window.removeEventListener("keydown", onPanelKeydown);
});
// Refocus-friendly: keep `nextTick` import alive even if unused after edits.
void nextTick;
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="ghost" size="sm" icon="refresh" :loading="loading" @click="load">
        <span class="btn-label">Refresh</span>
      </Button>
    </template>

    <div v-if="loadError" class="banner err">{{ loadError }}</div>

    <!-- Composer stage — fills the viewport and centers the composer card
         vertically so it sits in the middle of the screen, with breathing
         room above. The recent list flows below the stage. -->
    <div class="composer-stage">
      <section class="composer-card" :class="{ loading }">
        <div class="selector-row">
          <div class="selector-field">
            <label class="selector-label">Repository</label>
            <Select
              v-model="selectedRepo"
              :options="repoOptions"
              placeholder="Select repo…"
              @update:model-value="onRepoChange"
            />
          </div>
          <div class="selector-field">
            <label class="selector-label">Branch</label>
            <Select
              v-model="selectedBranch"
              :options="branchOptions"
              placeholder="Select branch…"
            />
          </div>
        </div>

        <textarea
          v-model="draft"
          class="composer-input"
          rows="3"
          placeholder="Ask the agent anything about this repo…  (Enter to send, Shift+Enter for a newline)"
          :disabled="sending"
          @keydown="onKeydown"
          @input="autosize"
        />

        <div class="controls-row">
          <div class="control-group">
            <div class="control-field">
              <label class="selector-label">Profile</label>
              <Select v-model="selectedProfile" :options="profileOptions" size="sm" />
            </div>
            <div class="control-field">
              <label class="selector-label">Thinking</label>
              <Select v-model="selectedThinking" :options="thinkingOptions" size="sm" />
            </div>
          </div>
          <Button
            variant="primary"
            size="md"
            icon="message"
            :loading="sending"
            :disabled="!canSend"
            @click="send"
          >
            Send
          </Button>
        </div>

        <div v-if="sendError" class="send-error">{{ sendError }}</div>
      </section>
    </div>

    <!-- Recent chats — peeking chip in the bottom-right corner that expands
         into a floating panel. Both live inside one anchor so click-outside
         detection treats them as a single unit. Overlays the page (doesn't
         push the composer), so the centered composer stays put. Hidden
         entirely when no chats exist. -->
    <div v-if="chats.length > 0" class="recent-anchor">
      <Transition name="panel-pop">
        <div v-if="recentOpen" class="recent-panel">
          <header class="recent-header">
            <span class="recent-header-title">Recent chats</span>
            <button class="recent-close" aria-label="Collapse" @click="recentOpen = false">
              <Icon name="chevronDown" :size="16" />
            </button>
          </header>
          <ul class="recent-list">
            <li
              v-for="c in chats"
              :key="c.id"
              class="recent-row"
              @click="open(c.id)"
            >
              <span class="dot" :class="statusClass(c.status)" />
              <div class="recent-meta">
                <span class="recent-title-text">{{ c.title || "Untitled chat" }}</span>
                <span class="recent-sub">{{ c.repo }} · {{ c.branch }}</span>
              </div>
              <span class="recent-time">{{ fmtTime(c.updated_at) }}</span>
              <Icon name="chevron" :size="14" class="recent-chevron" />
            </li>
          </ul>
        </div>
      </Transition>

      <!-- The peeking chip — bottom-right, visible when the panel is closed.
           Click to expand the panel above it. -->
      <Transition name="chip-pop">
        <button
          v-if="!recentOpen"
          class="recent-chip"
          aria-label="Show recent chats"
          @click="recentOpen = true"
        >
          <Icon name="message" :size="14" />
          <span class="chip-label">Recent chats</span>
          <span class="chip-count">{{ chats.length }}</span>
          <Icon name="chevron" :size="14" class="chip-chevron" />
        </button>
      </Transition>
    </div>
  </AppShell>
</template>

<style scoped>
.banner {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  margin-bottom: var(--space-4);
}
.banner.err {
  background: var(--danger-weak);
  color: var(--danger);
}

/* ---- Composer stage — fills the viewport (minus the action panel) and
   centers the composer card vertically, with breathing room above. ---- */
.composer-stage {
  /* Action panel height (44px) + its top/bottom gap (~16+16px) + a bit of
     headroom ≈ 100px. Same math as ChatDetailView's .chat-layout. */
  min-height: calc(100dvh - 100px);
  display: flex;
  align-items: center;       /* vertical center */
  justify-content: center;   /* horizontal center (card max-width handles the rest) */
  padding: var(--space-8) 0; /* extra empty space top + bottom */
}

/* ---- Composer card ---- */
.composer-card {
  width: 100%;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  box-shadow: var(--shadow-md);
}
.composer-card.loading {
  opacity: 0.65;
}

.selector-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.selector-label {
  display: block;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-3);
  margin-bottom: var(--space-1);
}
.selector-field {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.composer-input {
  width: 100%;
  min-height: 80px;
  max-height: 200px;
  resize: none;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text);
  font-size: var(--text-sm);
  font-family: var(--font-sans);
  line-height: var(--leading-relaxed);
  padding: var(--space-3);
  outline: none;
  transition:
    border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}
.composer-input::placeholder {
  color: var(--text-3);
}
.composer-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weaker);
}

.controls-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.control-group {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.control-field {
  display: flex;
  flex-direction: column;
  min-width: 140px;
}

.send-error {
  font-size: var(--text-xs);
  color: var(--danger);
  background: var(--danger-weak);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
}

/* ---- Recent chats: peeking bottom-right chip + expandable floating panel.
   Both are fixed-position overlays so they never push the centered composer.
   The anchor is a 0×0 box at bottom-right that hosts the panel/chip via
   absolute positioning relative to that corner. ---- */
.recent-anchor {
  position: fixed;
  right: var(--space-5);
  bottom: var(--space-5);
  z-index: 30;
}

/* The peeking chip — a compact pill that hints the panel is available. */
.recent-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 36px;
  padding: 0 var(--space-3);
  background: color-mix(in srgb, var(--surface-2) 94%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  color: var(--text-2);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(8px);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}
.recent-chip:hover {
  background: var(--surface-3);
  border-color: var(--border-strong);
  color: var(--text);
  transform: translateY(-1px);
}
.chip-label {
  white-space: nowrap;
}
.chip-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-full);
  background: var(--accent-weak);
  color: var(--accent);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
}
.chip-chevron {
  color: var(--text-3);
  transform: rotate(-90deg); /* points up — "expand" affordance */
}

/* The expanded panel — floats above the chip, anchored to the bottom-right
   corner. Width is capped so a long list doesn't take the whole screen. */
.recent-panel {
  position: absolute;
  right: 0;
  bottom: calc(36px + var(--space-2)); /* sit above the chip's slot */
  width: min(440px, calc(100vw - 2 * var(--space-5)));
  max-height: min(60vh, 520px);
  display: flex;
  flex-direction: column;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.recent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}
.recent-header-title {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-3);
}
.recent-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.recent-close:hover {
  background: var(--surface-3);
  color: var(--text);
}

.recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.recent-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.recent-row:last-child {
  border-bottom: none;
}
.recent-row:hover {
  background: var(--surface-3);
}
.recent-meta {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.recent-title-text {
  font-weight: var(--weight-medium);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recent-sub {
  font-size: var(--text-xs);
  color: var(--text-3);
}
.recent-time {
  flex: 0 0 auto;
  font-size: var(--text-xs);
  color: var(--text-3);
  white-space: nowrap;
}
.recent-chevron {
  flex: 0 0 auto;
  color: var(--text-3);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
  flex: 0 0 auto;
}
.dot.status-running { background: var(--accent); }
.dot.status-errored { background: var(--danger); }
.dot.status-idle    { background: var(--success); }

/* ---- Transitions ---- */
/* Panel slides + fades up from the chip corner. */
.panel-pop-enter-active,
.panel-pop-leave-active {
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.panel-pop-enter-from,
.panel-pop-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
/* Chip fades + scales in when the panel closes. */
.chip-pop-enter-active,
.chip-pop-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}
.chip-pop-enter-from,
.chip-pop-leave-to {
  opacity: 0;
  transform: scale(0.92);
}

/* ---------- Mobile ---------- */
@media (max-width: 768px) {
  /* Mobile action panel is taller (~92px) — match ChatDetailView's math. */
  .composer-stage {
    min-height: calc(100dvh - 148px);
    padding: var(--space-5) 0;
  }
  .selector-row {
    grid-template-columns: 1fr;
  }
  .controls-row {
    flex-direction: column;
    align-items: stretch;
  }
  .control-group {
    width: 100%;
  }
  .control-field {
    flex: 1 1 auto;
    min-width: 0;
  }
  .controls-row :deep(.btn) {
    width: 100%;
  }
  /* Keep the recent chip clear of the mobile safe-area inset. */
  .recent-anchor {
    right: var(--space-3);
    bottom: max(var(--space-3), env(safe-area-inset-bottom));
  }
  /* Panel spans most of the viewport on mobile. */
  .recent-panel {
    width: calc(100vw - 2 * var(--space-3));
  }
}
</style>
