<script setup lang="ts">
/**
 * System log — a live SSE view of the server's in-memory log ring buffer
 * (GET /api/logs/stream). This mirrors what `docker logs` shows for Noodle's
 * own output, in real time: the stream backfills the current buffer on connect
 * (so opening the page shows recent history immediately), then pushes each new
 * line as it's logged. Replaces the old 4s polling.
 *
 * The buffer is per-boot and bounded (last 1000 lines), so this shows recent
 * history (not the full container lifetime) — same as `docker logs --since` on
 * a fresh process.
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { getJson, sendJson, streamLogs, type SSECleanup } from "../api/client.js";
import type { LogEntry } from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import ConfirmDialog from "../components/ui/ConfirmDialog.vue";
import Icon from "../components/ui/Icon.vue";
import Select from "../components/ui/Select.vue";
import type { SelectOption } from "../components/ui/Select.vue";

/** Cap on client-held entries — mirrors the server ring buffer bound. */
const MAX_ENTRIES = 1000;

const entries = ref<LogEntry[]>([]);
const levelFilter = ref<"all" | "debug" | "info" | "warn" | "error">("info");
const streamEl = ref<HTMLElement | null>(null);

const levelOptions: SelectOption[] = [
  { value: "all", label: "All" },
  { value: "debug", label: "Debug+" },
  { value: "info", label: "Info+" },
  { value: "warn", label: "Warn+" },
  { value: "error", label: "Error+" },
];

/** Active SSE cleanup fn, or null when the stream is closed. */
let cleanup: SSECleanup | null = null;

/**
 * True when the viewport is pinned to the bottom (user is reading the tail).
 * Used to gate auto-scroll: if the user scrolled up to read history, incoming
 * lines must NOT yank them back down.
 */
function isAtBottom(): boolean {
  const el = streamEl.value;
  if (!el) return true;
  // Within ~40px of the bottom counts as "following the tail".
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function scrollToBottom(): void {
  nextTick(() => {
    const el = streamEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/** Stream event handler: append a log entry, cap the buffer, follow the tail. */
function onEntry(data: Record<string, unknown>): void {
  const entry = data as unknown as LogEntry;
  // Follow-the-tail: only auto-scroll if the user is already at the bottom.
  const wasAtBottom = isAtBottom();
  entries.value.push(entry);
  if (entries.value.length > MAX_ENTRIES) {
    entries.value.splice(0, entries.value.length - MAX_ENTRIES);
  }
  if (wasAtBottom) scrollToBottom();
}

/** Open the SSE stream with the current level filter. Closes any open one first. */
function openStream(): void {
  closeStream();
  // Reset entries — the stream backfills the (filtered) buffer fresh.
  entries.value = [];
  cleanup = streamLogs(`/api/logs/stream?level=${levelFilter.value}`, onEntry);
  // After the backfill frames arrive, pin to the bottom. nextTick isn't enough
  // (frames arrive async); a short delay lets the initial burst render. The
  // follow-the-tail logic handles subsequent live lines.
  setTimeout(scrollToBottom, 50);
}

function closeStream(): void {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}

/** Level filter changed — reopen the stream so the server re-backfills filtered. */
function onLevelChange(): void {
  openStream();
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

// --- Restart server ---
//
// Triggers a graceful shutdown (serve.ts:shutdown). Under docker-compose
// (`restart: unless-stopped`) the container comes back in a few seconds; we
// poll /health and reload when it returns. In bare-process environments the
// endpoint returns 503 and we surface that — the button must never be a silent
// "stop" button.
const showRestartConfirm = ref(false);
const restarting = ref(false);
const restartError = ref<string | null>(null);
/** In-flight agent runs at dialog-open time, surfaced in the confirm message. */
const inFlightJobs = ref(0);

/** Open the confirm dialog, pre-fetching the in-flight run count for the message. */
async function openRestartConfirm(): Promise<void> {
  restartError.value = null;
  inFlightJobs.value = 0;
  try {
    const status = await getJson<{ runningJobs: number; canRestart: boolean }>("/api/server/status");
    inFlightJobs.value = status.runningJobs;
    if (!status.canRestart) {
      restartError.value = "Restart is not available — the server has no restart handler (running outside docker-compose?).";
    }
  } catch {
    // Non-fatal — the dialog still opens; the count just won't be shown.
  }
  showRestartConfirm.value = true;
}

/**
 * Confirm: POST the restart, then poll /health until the server comes back
 * (or 30s elapse). On success, reload the page so the fresh process's stream
 * reconnects. The server's shutdown is graceful — dispatcher.stop() waits for
 * in-flight runs, so the actual bounce may lag by minutes if jobs are running.
 */
async function confirmRestart(): Promise<void> {
  restarting.value = true;
  restartError.value = null;
  try {
    await sendJson("/api/server/restart", "POST");
  } catch (e) {
    restarting.value = false;
    restartError.value = e instanceof Error ? e.message : "Failed to send restart request.";
    return;
  }
  // Give the server a beat to begin shutting down before we start polling.
  await new Promise((r) => setTimeout(r, 800));
  const deadline = Date.now() + 30_000;
  const poll = async (): Promise<void> => {
    if (Date.now() > deadline) {
      restarting.value = false;
      restartError.value = "Server didn't come back within 30s — it may still be finishing in-flight runs. Reload manually.";
      return;
    }
    try {
      const res = await fetch("/health", { credentials: "same-origin" });
      if (res.ok) {
        window.location.reload();
        return;
      }
    } catch {
      // Expected while the server is down — keep polling.
    }
    setTimeout(poll, 500);
  };
  void poll();
}

/**
 * The dialog body. When restarting, switches to a "waiting for it to come back"
 * line since the message prop is also the only place to surface post-confirm
 * state (the dialog stays open with loading=true until reload/timeout).
 */
const restartMessage = computed<string>(() => {
  if (restartError.value) return restartError.value;
  if (restarting.value) {
    return "Waiting for the server to come back up… the page will reload automatically. If runs are in flight, shutdown waits for them, so this can take a while.";
  }
  const inFlight = inFlightJobs.value;
  if (inFlight > 0) {
    return `Gracefully stops the server and lets docker-compose bring it back. ${inFlight} agent ${inFlight === 1 ? "run is" : "runs are"} in flight and will be allowed to finish before shutdown — the bounce can take a while.`;
  }
  return "Gracefully stops the server and lets docker-compose bring it back up. The page will reload automatically.";
});

onMounted(() => {
  openStream();
});
onUnmounted(closeStream);
</script>

<template>
  <AppShell>
    <template #actions>
      <Select
        v-model="levelFilter"
        :options="levelOptions"
        size="sm"
        class="level-select"
        @update:model-value="onLevelChange"
      />
      <Button variant="ghost" size="sm" icon="download" title="Download logs" @click="downloadLogs">
        <span class="btn-label">Download</span>
      </Button>
      <Button
        variant="danger"
        size="sm"
        icon="refresh"
        title="Restart server"
        :disabled="restarting"
        @click="openRestartConfirm"
      >
        <span class="btn-label">Restart</span>
      </Button>
    </template>

    <div v-if="entries.length === 0" class="empty">
      <Icon name="cron" :size="22" />
      <p>No logs yet — the server just started.</p>
    </div>

    <div v-else class="log-stream" ref="streamEl">
      <div v-for="(e, i) in entries" :key="i" class="log-line">
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
      Live stream of the in-memory buffer (last 1000 lines), cleared on restart.
      Same output as <code>docker logs</code>.
    </p>

    <ConfirmDialog
      v-model:open="showRestartConfirm"
      title="Restart the server?"
      :message="restartMessage"
      confirm-label="Restart"
      icon="refresh"
      danger
      :loading="restarting"
      @confirm="confirmRestart"
    />
  </AppShell>
</template>

<style scoped>
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
