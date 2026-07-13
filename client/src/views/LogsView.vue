<script setup lang="ts">
/**
 * System log — a live, auto-refreshing view of the server's in-memory log ring
 * buffer (GET /api/logs). This mirrors what `docker logs` shows for Noodle's own
 * output: every pino line tee'd into the buffer. Entries arrive newest-first;
 * polling appends fresh lines on an interval and can be paused.
 *
 * The buffer is per-boot and bounded, so this shows recent history (not the
 * full container lifetime) — same as `docker logs --since` on a fresh process.
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { getJson, ApiRequestError } from "../api/client.js";
import type { LogsResponse, LogEntry } from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Icon from "../components/ui/Icon.vue";

const POLL_MS = 4000;

const entries = ref<LogEntry[]>([]);
const loading = ref(false);
const loadError = ref("");
const levelFilter = ref<"all" | "debug" | "info" | "warn" | "error">("info");
const autoRefresh = ref(true);
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

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const body = await getJson<LogsResponse>(`/api/logs?limit=500`);
    entries.value = body.entries ?? [];
  } catch (e) {
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

onMounted(async () => {
  await load();
  if (autoRefresh.value) startPolling();
});
onUnmounted(stopPolling);
</script>

<template>
  <AppShell>
    <template #actions>
      <select v-model="levelFilter" class="level-select ctrl" title="Minimum level">
        <option value="all">All levels</option>
        <option value="debug">Debug+</option>
        <option value="info">Info+</option>
        <option value="warn">Warn+</option>
        <option value="error">Error+</option>
      </select>
      <Button
        variant="ghost"
        size="sm"
        :icon="autoRefresh ? 'refresh' : 'play'"
        @click="toggleAuto"
      >
        {{ autoRefresh ? "Live" : "Paused" }}
      </Button>
      <Button variant="ghost" size="sm" icon="refresh" :loading="loading" @click="load">
        Refresh
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

    <div v-else class="log-stream">
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
  height: 30px;
  font-size: var(--text-xs);
}

.log-stream {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  font-family: var(--font-mono);
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
.ctrl {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text);
  padding: 0 var(--space-2);
}

/* ---------- Mobile (≤768px) — wrap log lines ---------- */
@media (max-width: 768px) {
  /* Let long messages wrap instead of being clipped off-screen. The timestamp
   * + level stay on the first line; the message flows onto the lines below. */
  .log-line {
    white-space: normal;
    align-items: flex-start;
    padding: var(--space-2) var(--space-3);
  }
  .msg {
    white-space: pre-wrap;
    overflow: visible;
    flex: 1 1 100%;
  }
  .fields {
    flex: 1 1 100%;
  }
  .foot-note {
    font-size: var(--text-xs);
  }
}
</style>
