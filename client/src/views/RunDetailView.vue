<script setup lang="ts">
/**
 * Run detail — a two-column layout: the conversation stream on the left, a meta
 * sidebar on the right (status pill, run facts, PR link, summary, error). Back
 * to the previous view via the top-bar action.
 *
 * This view is mounted inside AppShell, so it inherits the sidebar + top bar.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getJson, sendJson, ApiRequestError } from "../api/client.js";
import type { RunDetailResponse, ParsedMessage, RunRow } from "../api/types.js";
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

const isRunning = computed(() => run.value?.status === "running");

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
    run.value = body.run;
    messages.value = body.messages ?? [];
    await nextTick(scrollToBottom);
  } catch (e) {
    loadError.value = e instanceof ApiRequestError ? e.message : "Could not load run.";
  } finally {
    loading.value = false;
  }
}

function scrollToBottom(): void {
  const el = document.querySelector(".stream") as HTMLElement | null;
  if (el) el.scrollTop = el.scrollHeight;
}

async function cancel(): Promise<void> {
  if (!run.value || cancelling.value) return;
  cancelling.value = true;
  try {
    await sendJson(`/api/runs/${encodeURIComponent(run.value.job_id)}/cancel`, "POST");
    await load();
  } catch {
    /* leave as-is; next refresh reconciles */
  } finally {
    cancelling.value = false;
  }
}

function back(): void {
  if (window.history.length > 1) router.back();
  else void router.replace({ name: "runs" });
}

watch(
  () => props.id,
  () => void load(),
);
onMounted(load);
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="ghost" size="sm" icon="back" @click="back">Back</Button>
      <Button variant="ghost" size="sm" icon="refresh" :loading="loading" @click="load">
        Refresh
      </Button>
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
        <div class="stream-head">
          <StatusPill :status="run.status" size="md" />
          <span v-if="run.model" class="model-tag mono">{{ run.model }}</span>
        </div>

        <div class="stream">
          <div v-if="messages.length === 0" class="empty-chat">
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
        </div>
      </div>

      <!-- Meta sidebar -->
      <aside class="meta-col">
        <Card title="Details">
          <dl class="facts">
            <div class="fact"><dt>Repository</dt><dd class="ellipsis">{{ run.repo }}</dd></div>
            <div class="fact"><dt>Branch</dt><dd class="mono ellipsis">{{ run.branch }}</dd></div>
            <div v-if="run.profile" class="fact"><dt>Profile</dt><dd>{{ run.profile }}</dd></div>
            <div class="fact"><dt>Started</dt><dd>{{ fmtTime(run.started_at) }}</dd></div>
            <div v-if="run.finished_at" class="fact"><dt>Finished</dt><dd>{{ fmtTime(run.finished_at) }}</dd></div>
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

        <Card v-if="run.summary" title="Summary">
          <p class="summary-text">{{ run.summary }}</p>
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
.stream-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
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

/* ---------- Meta sidebar ---------- */
.meta-col {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  position: sticky;
  top: calc(var(--topbar-h) + var(--space-6));
}
.facts {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
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
.summary-text {
  font-size: var(--text-sm);
  color: var(--text);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  margin: 0;
}

@media (max-width: 900px) {
  .run-layout {
    grid-template-columns: 1fr;
  }
  .meta-col {
    position: static;
  }
}
</style>
