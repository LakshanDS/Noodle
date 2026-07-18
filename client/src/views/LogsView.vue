<script setup lang="ts">
/**
 * System log — a live, auto-refreshing view of the server's in-memory log ring
 * buffer (GET /api/logs). This mirrors what `docker logs` shows for Noodle's own
 * output. Entries arrive oldest-first; newest lines appear at the bottom.
 * The viewport auto-scrolls down as new entries arrive.
 *
 * The buffer is per-boot and bounded, so this shows recent history (not the
 * full container lifetime) — same as `docker logs --since` on a fresh process.
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { getJson, ApiRequestError, isAuthError } from "../api/client.js";
import type { LogsResponse, LogEntry } from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Icon from "../components/ui/Icon.vue";
import Select from "../components/ui/Select.vue";
import type { SelectOption } from "../components/ui/Select.vue";

const POLL_MS = 4000;

const entries = ref<LogEntry[]>([]);
const loading = ref(false);
const loadError = ref("");
const levelFilter = ref<"all" | "debug" | "info" | "warn" | "error">("info");
const autoRefresh = ref(true);
const streamEl = ref<HTMLElement | null>(null);

const levelOptions: SelectOption[] = [
  { value: "all", label: "All" },
  { value: "debug", label: "Debug+" },
  { value: "info", label: "Info+" },
  { value: "warn", label: "Warn+" },
  { value: "error", label: "Error+" },
];
let timer: ReturnType<typeof setInterval> | null = null;

/** Numeric floor for the selected level filter (matches the server's ?level=). */
const LEVEL_FLOOR: Record<typeof levelFilter.value, number> = {
  all: 0,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const filtered = computed(() => {
  const floor = LEVEL_FLOOR[levelFilter.value];
  return floor === 0 ? entries.value : entries.value.filter((e) => e.level >= floor);
});

function scrollToBottom(): void {
  nextTick(() => {
    const el = streamEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const body = await getJson<LogsResponse>(`/api/logs?limit=500`);
    entries.value = body.entries ?? [];
    scrollToBottom();
  } catch (e) {
    if (isAuthError(e)) return;
    loadError.value = e instanceof ApiRequestError ? e.message : "Could not load logs.";
  } finally {
    loading.value = false;
  }
}

function startPolling(): void {
  stopPolling();
  timer = setInterval(load, POLL_MS);
}
function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
function toggleAuto(): void {
  autoRefresh.value = !autoRefresh.value;
  if (autoRefresh.value) startPolling();
  else stopPolling();
}

/** CSS color var for a level, for the level label chip. */
function levelColor(level: number): string {
  if (level >= 50) return "var(--danger)";
  if (level >= 40) return "var(--warning)";
  if (level >= 30) return "var(--success)";
  if (level >= 20) return "var(--accent)";
  return "var(--text-3)";
}

/** Download all persistent log files as a single text file. */
function downloadLogs(): void {
  const a = document.createElement("a");
  a.href = "/api/logs/download";
  a.download = "noodle-logs.txt";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

onMounted(async () => {
  await load();
  if (autoRefresh.value) startPolling();
});
onUnmounted(stopPolling);
</script>

<template>
  <AppShell>
    <template #actions>
      <Select
        v-model="levelFilter"
        :options="levelOptions"
        size="sm"
        class="level-select"
      />
      <Button
        variant="ghost"
        size="sm"
        class="live-toggle"
        :icon="autoRefresh ? 'pause' : 'play'"
        :title="autoRefresh ? 'Pause live stream' : 'Resume live stream'"
        :aria-label="autoRefresh ? 'Pause live stream' : 'Resume live stream'"
        @click="toggleAuto"
      />
      <Button variant="ghost" size="sm" icon="refresh" :loading="loading" title="Refresh" @click="load">
        <span class="btn-label">Refresh</span>
      </Button>
      <Button variant="ghost" size="sm" icon="download" title="Download logs" @click="downloadLogs">
        <span class="btn-label">Download</span>
      </Button>
    </template>

    <div v-if="loadError" class="banner err">{{ loadError }}</div>

    <div v-if="loading && entries.length === 0" class="loading-row">
      Loading logs…
    </div>

    <div v-else-if="filtered.length === 0" class="empty">
      <Icon name="cron" :size="22" />
      <p>{{ entries.length === 0 ? "No logs yet — the server just started." : "No entries at this level." }}</p>
    </div>

    <div v-else class="log-stream" ref="streamEl">
      <div v-for="(e, i) in filtered" :key="i" class="log-line">
        <span class="ts">{{ e.ts }}</span>
        <span class="lvl" :style="{ color: levelColor(e.level) }">{{ e.levelLabel }}</span>
        <span class="msg">{{ e.msg }}</span>
        <span v-if="Object.keys(e.fields).length" class="fields">
          <span v-for="(v, k) in e.fields" :key="k" class="field">
            <span class="fk">{{ k }}</span>=<span class="fv">{{ v }}</span>
          </span>
        </span>
      </div>
    </div>

    <p class="foot-note">
      In-memory buffer (last 1000 lines), cleared on restart. Same output as
      <code>docker logs</code>.
    </p>
  </AppShell>
</template>

<style scoped>
.banner {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  margin-bottom: var(--space-4);
  background: var(--danger-weak);
  color: var(--danger);
}
.loading-row {
  padding: var(--space-12);
  text-align: center;
  color: var(--text-3);
  font-size: var(--text-sm);
}
.empty {
  padding: var(--space-12);
  text-align: center;
  color: var(--text-3);
  font-size: var(--text-sm);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
}
.empty :deep(svg) {
  color: var(--text-3);
  opacity: 0.6;
}

.level-select {
  width: auto;
  min-width: 120px;
}

.log-stream {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: auto;
  font-family: var(--font-mono);
  height: calc(100dvh - 144px);
  flex-shrink: 0;
}
.log-line {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding: 5px var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  white-space: nowrap;
  overflow: hidden;
}
.log-line:last-child {
  border-bottom: none;
}
.log-line:hover {
  background: var(--surface-3);
}
.ts {
  color: var(--text-3);
  flex: 0 0 auto;
  white-space: pre;
}
.lvl {
  font-weight: var(--weight-semibold);
  flex: 0 0 auto;
  width: 48px;
}
.msg {
  color: var(--text);
  flex: 0 1 auto;
  text-overflow: ellipsis;
  overflow: hidden;
}
.fields {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-width: 0;
}
.field {
  color: var(--text-3);
}
.fk {
  color: var(--text-2);
}
.fv {
  color: var(--text-3);
}

.foot-note {
  margin-top: var(--space-3);
  font-size: var(--text-xs);
  color: var(--text-3);
}
.foot-note code {
  font-family: var(--font-mono);
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
}

@media (max-width: 768px) {
  .live-toggle {
    display: none;
  }
  .log-stream {
    height: calc(100dvh - 180px);
  }
  .log-line {
    white-space: nowrap;
    font-size: 11px;
    padding: 5px var(--space-3);
    width: max-content;
    min-width: 100%;
  }
  .msg {
    white-space: nowrap;
    flex: 0 0 auto;
    overflow: visible;
    text-overflow: clip;
  }
  .fields {
    flex: 0 0 auto;
    flex-wrap: nowrap;
  }
  .foot-note {
    font-size: var(--text-xs);
  }
}
</style>

<!--
  Global (unscoped) styles — needed to override the Select component's scoped
  .select { width: 100% } which can't be pierced from a parent scoped block.
-->
<style>
@media (max-width: 768px) {
  .level-select.select {
    width: 10px !important;
  }
  .level-select.select .trigger {
    padding: 0 10px;
  }
}
</style>
