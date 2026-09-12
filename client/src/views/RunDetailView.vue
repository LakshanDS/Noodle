<script setup lang="ts">
/**
 * Run detail — a two-column layout: the conversation stream on the left, a meta
 * sidebar on the right (status pill, run facts, PR link, summary, error). Back
 * to the previous view via the top-bar action.
 *
 * This view is mounted inside AppShell, so it inherits the sidebar + top bar.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getJson, sendJson, streamSSE, ApiRequestError, isAuthError } from "../api/client.js";
import type { RunDetailResponse, ParsedMessage, ParsedToolCall, RunRow, RunStreamEvent } from "../api/types.js";
import { fmtTime } from "../lib/format.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import StatusPill from "../components/ui/StatusPill.vue";
import Icon from "../components/ui/Icon.vue";
import ChatBubble from "../components/chat/ChatBubble.vue";
import ToolCall from "../components/chat/ToolCall.vue";
import ToolResult from "../components/chat/ToolResult.vue";

const props = defineProps<{ id: string }>();
const router = useRouter();

const run = ref<RunRow | null>(null);
const messages = ref<ParsedMessage[]>([]);
const loading = ref(false);
const loadError = ref("");
const cancelling = ref(false);

/* ---- Live streaming state (mirrors ChatDetailView) ---- */
/** True while we're attached to a live run (stream open OR in reconnect backoff). */
const isStreaming = ref(false);
/** Partial assistant text as it streams in (replaced wholesale on each delta). */
const streamingText = ref("");
/** Tool calls observed in-flight on the current turn, rendered as live ToolCall cards. */
const streamingTools = ref<{ name: string; args: Record<string, unknown>; ok?: boolean }[]>([]);
let cleanupSSE: (() => void) | null = null;
/**
 * While streaming, the transcript is refreshed on a short interval (not only
 * on turn boundaries): the page can attach mid-run, the first load can fail
 * (backend briefly down — the vite proxy ECONNREFUSED case), and a single
 * assistant message can run for minutes without emitting a turn_start. A 3s
 * poll picks up the prompt + newly completed turns no matter what, and the
 * turn_end fold still gives instant feedback between polls.
 */
let refreshTimer: ReturnType<typeof setInterval> | null = null;
/** Retry timer for the initial load failing (backend still booting). */
let retryLoadTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Reconnect bookkeeping. Without these, a stream that closes immediately
 * (server not booted yet, proxy drop, etc.) tight-loops: onDone → load →
 * openStream → close → onDone, with `isStreaming` flickering each cycle and
 * nothing ever rendering. The guard below keeps `isStreaming` steady across
 * reconnects and caps retries so a genuinely broken connection degrades to a
 * "couldn't connect" state instead of spinning forever.
 */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Consecutive close-and-reopen cycles that produced NO real events. Reset on
 *  any delta/tool/turn event. Past the cap we stop reconnecting. */
let consecutiveEmptyReconnects = 0;
const MAX_EMPTY_RECONNECTS = 5;

const isRunning = computed(() => run.value?.status === "running");

/** Human-readable run duration, e.g. "42s" or "3m 12s". Empty while running. */
const duration = computed(() => {
  const r = run.value;
  if (!r || !r.finished_at) return "";
  const start = new Date(r.started_at.endsWith("Z") ? r.started_at : r.started_at + "Z").getTime();
  const end = new Date(r.finished_at.endsWith("Z") ? r.finished_at : r.finished_at + "Z").getTime();
  const secs = Math.max(0, Math.round((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
});

/** What kicked off this run — an issue number (plus the command, if any). */
const trigger = computed(() => {
  const r = run.value;
  if (!r) return "";
  const cmd = r.command ? ` · /${r.command}` : "";
  if (r.issue != null) return `Issue #${r.issue}${cmd}`;
  if (r.cron_job_id != null) return "Schedule";
  return "Manual";
});

function isChat(m: ParsedMessage): m is Extract<ParsedMessage, { role: "user" | "assistant" }> {
  return m.role === "user" || m.role === "assistant";
}
function hasContent(m: Extract<ParsedMessage, { role: "user" | "assistant" }>): boolean {
  return Boolean(m.text?.trim()) || (Array.isArray(m.toolCalls) && m.toolCalls.length > 0);
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const body = await getJson<RunDetailResponse>(`/api/runs/${encodeURIComponent(props.id)}`);
    const wasAtBottom = isAtBottom();
    run.value = body.run;
    messages.value = body.messages ?? [];
    await nextTick();
    if (wasAtBottom) scrollToBottom();
    // If the run is still in flight (navigated to a running run, or reloaded
    // mid-run), open the SSE stream to receive events live. The server
    // synthesizes a `done` if the run already finished, so this is safe even
    // if the run completes between the fetch and the stream open.
    if (run.value.status === "running") {
      openStream();
    }
  } catch (e) {
    if (isAuthError(e)) return;
    loadError.value = e instanceof ApiRequestError ? e.message : "Could not load run.";
    // The backend may still be booting (e.g. vite proxy ECONNREFUSED during a
    // restart) — retry until it answers; the page is useless otherwise.
    if (!run.value && retryLoadTimer === null) {
      retryLoadTimer = setTimeout(() => {
        retryLoadTimer = null;
        void load();
      }, 3000);
    }
  } finally {
    loading.value = false;
  }
}

/* ---- Follow-the-tail scrolling. The scroll container is AppShell's .main
 * (overflow-y: auto) — .stream itself never scrolls. Auto-scroll only when
 * the user is pinned to the bottom; scrolling up to read history must not
 * get yanked back by incoming events. ---- */

function scrollContainer(): HTMLElement | null {
  return document.querySelector(".main");
}

/** Within ~60px of the bottom counts as "following the tail". */
function isAtBottom(): boolean {
  const el = scrollContainer();
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function scrollToBottom(): void {
  const el = scrollContainer();
  if (el) el.scrollTop = el.scrollHeight;
}

/** Scroll on the next frame iff the user was at the bottom before the update. */
function followTail(): void {
  const wasAtBottom = isAtBottom();
  void nextTick(() => {
    if (wasAtBottom) scrollToBottom();
  });
}

/**
 * Best-effort mid-stream refresh of the run row + transcript. Unlike load(),
 * never surfaces errors (the stream stays live; the next turn boundary
 * retries) and never touches the stream itself.
 */
function refreshTranscript(): void {
  void getJson<RunDetailResponse>(`/api/runs/${encodeURIComponent(props.id)}`)
    .then((body) => {
      run.value = body.run;
      messages.value = body.messages ?? [];
      // followTail MUST come after the mutations: with no flush pending yet,
      // a pre-mutation nextTick resolves before Vue renders this change, and
      // the scroll lands on the old layout and is lost.
      followTail();
    })
    .catch(() => { /* transient — retried on the next turn boundary */ });
}

/* ---- SSE streaming (mirrors ChatDetailView's pattern, plus reconnect guard) ---- */

/**
 * Tear down the current stream + any pending reconnect. Leaves `isStreaming`
 * alone — callers decide whether to flip it (steady across reconnects, false
 * only when the run is truly done or we give up reconnecting).
 */
function teardownStream(): void {
  cleanupSSE?.();
  cleanupSSE = null;
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function openStream(): void {
  // Don't open if a stream is already live OR a reconnect is pending.
  if (cleanupSSE || reconnectTimer !== null) return;
  // Steady across reconnects: once we're "streaming" we stay streaming until
  // the run finishes or we exhaust retries. This is what stops the flicker.
  isStreaming.value = true;

  // Poll the transcript while attached (see refreshTimer's doc above).
  if (refreshTimer === null) {
    refreshTimer = setInterval(refreshTranscript, 3000);
  }

  let sawRealEventThisCycle = false;

  cleanupSSE = streamSSE(
    `/api/runs/${encodeURIComponent(props.id)}/stream`,
    (data) => {
      const e = data as unknown as RunStreamEvent;
      // Any of these means the stream is genuinely alive (not just a server
      // immediately sending done because it has no session yet).
      if (e.type === "delta" || e.type === "tool_start" || e.type === "tool_end" || e.type === "turn_start" || e.type === "turn_end") {
        sawRealEventThisCycle = true;
        consecutiveEmptyReconnects = 0;
      }
      handleStreamEvent(e);
    },
    () => {
      // Stream closed. Three cases:
      // 1. We saw real events this cycle → the run produced something, so a
      //    close most likely means it finished. Reconcile + stop streaming.
      // 2. No real events but a `done`/`error` was the cause → run finished
      //    cleanly without streaming (e.g. errored during boot). Reconcile.
      // 3. No real events, immediate close, run still running → the stream
      //    dropped before the session booted (cloning window) or a transient
      //    disconnect. Back off and retry; cap consecutive empties.
      cleanupSSE = null;
      const wasProductive = sawRealEventThisCycle;

      // If the run already finished (the close came with a terminal event, or
      // we genuinely saw content and now it's done), reconcile + stop.
      if (wasProductive) {
        isStreaming.value = false;
        consecutiveEmptyReconnects = 0;
        void load();
        return;
      }

      // Empty close. Check the run status before deciding to retry — the run
      // may have finished in the background (status flipped), in which case
      // reconnecting would loop forever getting immediate dones.
      void getJson<RunDetailResponse>(`/api/runs/${encodeURIComponent(props.id)}`)
        .then((body) => {
          run.value = body.run;
          messages.value = body.messages ?? [];
          if (body.run.status !== "running") {
            // Genuinely finished — stop streaming, keep reconciled data.
            isStreaming.value = false;
            consecutiveEmptyReconnects = 0;
            return;
          }
          // Still running — schedule a reconnect with capped backoff. Keeps
          // isStreaming true (no flicker) and avoids the tight loop.
          scheduleReconnect();
        })
        .catch(() => {
          // Fetch failed — treat as transient, try again with backoff.
          scheduleReconnect();
        });
    },
  );
}

/**
 * Reconnect after a short delay (doubles each empty cycle, capped). Resets the
 * SSE bookkeeping but leaves `isStreaming` true so the hint stays steady.
 */
function scheduleReconnect(): void {
  consecutiveEmptyReconnects += 1;
  if (consecutiveEmptyReconnects > MAX_EMPTY_RECONNECTS) {
    // Give up — stop the flicker and surface the empty state. The persisted
    // messages (if any) remain visible from the last reconcile.
    isStreaming.value = false;
    return;
  }
  const delay = Math.min(1000 * 2 ** (consecutiveEmptyReconnects - 1), 15_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openStream();
  }, delay);
}

function handleStreamEvent(e: RunStreamEvent): void {
  switch (e.type) {
    case "turn_start":
      streamingText.value = "";
      streamingTools.value = [];
      // The prompt + every completed turn live in the session file (session_path
      // is persisted at boot, and pi appends each message as it completes).
      // Refresh on turn boundaries so the transcript builds up from server
      // truth — including the user's prompt — instead of only from stream
      // events that arrive after this page opened.
      refreshTranscript();
      break;
    case "delta":
      streamingText.value = e.text;
      break;
    case "tool_start":
      streamingTools.value.push({ name: e.name, args: e.args });
      break;
    case "tool_end": {
      // Patch the most recent matching tool that hasn't resolved yet (tools
      // can run in parallel — match the latest unresolved start).
      const idx = streamingTools.value.map((t) => t.name === e.name && t.ok === undefined).lastIndexOf(true);
      if (idx >= 0) streamingTools.value[idx].ok = e.ok;
      break;
    }
    case "turn_end": {
      // Fold the completed turn into the transcript instantly; the next
      // turn_start refresh (and the final reconcile on stream close) replaces
      // it with the authoritative persisted rows, including tool results.
      // toolCalls keep name+args to match the persisted message shape.
      let toolCalls: ParsedToolCall[] | undefined;
      if (streamingTools.value.length > 0) {
        toolCalls = streamingTools.value.map((t) => ({ name: t.name, args: t.args }));
      }
      if (e.text || toolCalls) {
        messages.value.push({ role: "assistant", text: e.text, ...(toolCalls ? { toolCalls } : {}) });
      }
      streamingText.value = "";
      streamingTools.value = [];
      break;
    }
    case "error":
      // The reconcile fetch on close will surface the error in the sidebar.
      break;
    // "done" — handled by the onDone callback (cleanup), not here.
  }
  followTail();
}

async function cancel(): Promise<void> {
  if (!run.value || cancelling.value) return;
  cancelling.value = true;
  try {
    await sendJson(`/api/runs/${encodeURIComponent(run.value.job_id)}/cancel`, "POST");
    // Stop streaming immediately — the run is being killed, no point retrying.
    teardownStream();
    consecutiveEmptyReconnects = 0;
    isStreaming.value = false;
    await load();
  } catch {
    /* leave as-is; the run row will reconcile on next load */
  } finally {
    cancelling.value = false;
  }
}

function back(): void {
  if (window.history.length > 1) router.back();
  else void router.replace({ name: "runs" });
}

function cancelRetryLoad(): void {
  if (retryLoadTimer !== null) {
    clearTimeout(retryLoadTimer);
    retryLoadTimer = null;
  }
}

watch(
  () => props.id,
  () => {
    // Clean up any open stream + pending reconnect from the previous run.
    teardownStream();
    cancelRetryLoad();
    consecutiveEmptyReconnects = 0;
    isStreaming.value = false;
    void load();
  },
);
onMounted(load);
onUnmounted(() => {
  teardownStream();
  cancelRetryLoad();
  consecutiveEmptyReconnects = 0;
});
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="ghost" size="sm" icon="back" @click="back">Back</Button>
      <Button
        v-if="isRunning"
        variant="danger"
        size="sm"
        :loading="cancelling"
        @click="cancel"
      >
        Cancel run
      </Button>
    </template>

    <div v-if="loadError" class="banner err">{{ loadError }}</div>

    <div v-if="!run && loading" class="loading-row">Loading run…</div>

    <div v-else-if="run" class="run-layout">
      <!-- Conversation stream -->
      <div class="stream-col">
        <div class="stream">
          <div v-if="messages.length === 0 && !isStreaming" class="empty-chat">
            <Icon name="message" :size="20" />
            <p>No conversation recorded for this run.</p>
          </div>
          <template v-else>
            <template v-for="(m, i) in messages" :key="i">
              <ToolResult v-if="m.role === 'toolResult'" :result="m" />
              <template v-else-if="isChat(m) && hasContent(m)">
                <ChatBubble :message="m" />
                <ToolCall
                  v-for="(tc, j) in m.toolCalls ?? []"
                  :key="`${i}-${j}`"
                  :call="tc"
                />
              </template>
            </template>
          </template>

          <!-- Live-streaming assistant bubble + in-flight tool cards (while the
               run is in flight). Cards mirror the persisted ToolCall look so
               live activity and history read as one continuous flow. -->
          <template v-if="isStreaming">
            <ChatBubble
              v-if="streamingText"
              :message="{ role: 'assistant', text: streamingText }"
            />
            <ToolCall
              v-for="(tool, i) in streamingTools"
              :key="'st' + i"
              :call="{ name: tool.name, args: tool.args }"
              :state="tool.ok === undefined ? 'pending' : tool.ok ? 'ok' : 'error'"
            />
            <!-- Subtle "working" hint when no text/tools have arrived yet -->
            <div v-if="!streamingText && streamingTools.length === 0" class="streaming-hint">
              <span class="dot-flash" />
              <span>Agent is working…</span>
            </div>
          </template>
        </div>
      </div>

      <!-- Meta sidebar -->
      <aside class="meta-col">
        <Card title="Details" class="details-card">
          <template #actions>
            <StatusPill :status="run.status" size="md" />
          </template>

          <!-- Run facts -->
          <dl class="facts">
            <div class="fact"><dt>Repository</dt><dd class="ellipsis">{{ run.repo }}</dd></div>
            <div class="fact"><dt>Branch</dt><dd class="mono ellipsis">{{ run.branch }}</dd></div>
            <div class="fact"><dt>Trigger</dt><dd>{{ trigger }}</dd></div>
            <div v-if="run.profile" class="fact"><dt>Profile</dt><dd>{{ run.profile }}</dd></div>
            <div v-if="run.model" class="fact"><dt>Model</dt><dd class="ellipsis">{{ run.model }}</dd></div>
            <div class="fact"><dt>Runtime</dt><dd>{{ run.runtime || "pi" }}</dd></div>
            <div class="fact"><dt>Started</dt><dd>{{ fmtTime(run.started_at) }}</dd></div>
            <div v-if="duration" class="fact"><dt>Duration</dt><dd>{{ duration }}</dd></div>
          </dl>
        </Card>

        <Card v-if="run.pr_url || run.output_issue_url" title="Links">
          <a v-if="run.pr_url" :href="run.pr_url" target="_blank" rel="noopener" class="link-row">
            <Icon name="pr" :size="16" />
            <span class="ellipsis">View pull request</span>
            <Icon name="external" :size="13" class="ext" />
          </a>
          <a v-if="run.output_issue_url" :href="run.output_issue_url" target="_blank" rel="noopener" class="link-row">
            <Icon name="message" :size="16" />
            <span class="ellipsis">Opened issue</span>
            <Icon name="external" :size="13" class="ext" />
          </a>
        </Card>

        <Card v-if="run.error" title="Error">
          <p class="error-text">{{ run.error }}</p>
        </Card>
      </aside>
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
.loading-row {
  padding: var(--space-12);
  text-align: center;
  color: var(--text-3);
  font-size: var(--text-sm);
}

.run-layout {
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: var(--space-5);
  align-items: start;
}

/* ---------- Stream ---------- */
.stream-col {
  min-width: 0;
}
.model-tag {
  font-size: var(--text-xs);
  color: var(--text-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 3px 8px;
  border-radius: var(--radius-sm);
}
.stream {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-bottom: var(--space-8);
}
.empty-chat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-12);
  color: var(--text-3);
  font-size: var(--text-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}

/* ---------- Live streaming ---------- */
.streaming-hint {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-3);
  font-size: var(--text-sm);
  padding: var(--space-2) 0;
}
/* Pulsing dot — a single CSS animation, no JS. */
.dot-flash {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: dot-flash 1.2s ease-in-out infinite;
}
@keyframes dot-flash {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 1; }
}

/* ---------- Meta sidebar ---------- */
/* Sticky so the Details card stays put at its page-load position (level with
 * the first chat bubble) and remains visible while the conversation scrolls.
 * `top` matches the card's natural load offset from the scrollport top: action
 * panel height (44) + its bottom margin (16) = 60px. */
.meta-col {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  position: sticky;
  top: 60px;
}
.facts {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.fact {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--text-sm);
}
.fact dt {
  color: var(--text-3);
  font-weight: var(--weight-normal);
  flex: 0 0 auto;
}
.fact dd {
  margin: 0;
  color: var(--text);
  text-align: right;
  min-width: 0;
}
.link-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  font-size: var(--text-sm);
  color: var(--text);
  border-bottom: 1px solid var(--border-subtle);
}
.link-row:last-child {
  border-bottom: none;
}
.link-row:hover {
  color: var(--accent);
}
.link-row .ext {
  color: var(--text-3);
  margin-left: auto;
}
.error-text {
  font-size: var(--text-sm);
  color: var(--danger);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

@media (max-width: 900px) {
  .run-layout {
    grid-template-columns: 1fr;
  }
}
</style>
