<script setup lang="ts">
/**
 * Chat detail — a single conversation thread with a composer at the bottom.
 *
 * Chat creation moved to ChatsView's composer landing; this view is only
 * mounted for an existing chat (:id). On mount it loads the chat + persisted
 * messages, opens an SSE stream if the chat is mid-run, and — if arrived from
 * the composer landing with a stashed first prompt — auto-sends that prompt to
 * kick off the first turn.
 *
 * The composer keeps Profile + Thinking selectors so a user can change them
 * mid-conversation; changes PATCH the chat row (applied at the next session
 * boot). Repo + branch are read-only here — they're fixed once a chat exists
 * and are surfaced as a compact header echo above the thread.
 *
 * Tool messages from the store are rendered as small chips; assistant messages
 * (both persisted and live-streamed) use ChatBubble.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getJson, sendJson, streamSSE, isAuthError } from "../api/client.js";
import type {
  ChatDetailResponse,
  ChatRow,
  ChatMessageRow,
  ChatStreamEvent,
  ProfilesResponse,
  ProfileListItem,
  ThinkingLevel,
} from "../api/types.js";
import { takePendingFirstMessage } from "../lib/pending-chat.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Select from "../components/ui/Select.vue";
import type { SelectOption } from "../components/ui/Select.vue";
import ChatBubble from "../components/chat/ChatBubble.vue";
import Icon from "../components/ui/Icon.vue";

const props = defineProps<{ id?: string }>();
const router = useRouter();

/* ---- Chat state ---- */
const chat = ref<ChatRow | null>(null);
const messages = ref<ChatMessageRow[]>([]);
const loading = ref(false);
const loadError = ref("");
const draft = ref("");
const sending = ref(false);

/* ---- Profile + thinking selectors (mid-chat overrides) ---- */
const profiles = ref<ProfileListItem[]>([]);
const defaultProfile = ref("");
const selectedProfile = ref<string>("");
const selectedThinking = ref<ThinkingLevel>("medium");
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

const profileOptions = computed<SelectOption[]>(() => {
  const opts: SelectOption[] = [
    { value: "", label: defaultProfile.value ? `Default (${defaultProfile.value})` : "Instance default" },
  ];
  for (const p of profiles.value) opts.push({ value: p.name, label: p.name });
  return opts;
});
const thinkingOptions = computed<SelectOption[]>(() =>
  THINKING_LEVELS.map((l) => ({ value: l, label: l })),
);

/* ---- Streaming state ---- */
const isStreaming = ref(false);
const streamingText = ref("");
const streamingTools = ref<{ name: string; args: string; ok?: boolean; result?: string }[]>([]);
let cleanupSSE: (() => void) | null = null;

/* ---- Computed ---- */
const canSend = computed(() => {
  if (!chat.value) return false;
  if (isStreaming.value || sending.value) return false;
  return draft.value.trim().length > 0;
});

/* ---- Load existing chat ---- */
async function load(): Promise<void> {
  if (!props.id) return;
  loading.value = true;
  loadError.value = "";
  try {
    const [data, profilesRes] = await Promise.all([
      getJson<ChatDetailResponse>(`/api/chats/${props.id}`),
      getJson<ProfilesResponse>("/api/profiles"),
    ]);
    chat.value = data.chat;
    messages.value = data.messages ?? [];
    profiles.value = profilesRes.items ?? [];
    defaultProfile.value = profilesRes.default ?? "";
    selectedProfile.value = data.chat.profile ?? "";
    selectedThinking.value = data.chat.thinking_level ?? "medium";
    await nextTick(scrollToBottom);
    // If the chat is already running (page reload mid-stream), open the SSE
    // stream immediately.
    if (chat.value.status === "running") {
      openStream();
    }

    // Handoff from ChatsView: if a first prompt was stashed, send it now.
    const pending = takePendingFirstMessage();
    if (pending && chat.value.status !== "running") {
      draft.value = pending;
      await nextTick();
      void send();
    }
  } catch (e) {
    if (!isAuthError(e)) loadError.value = "Could not load chat.";
  } finally {
    loading.value = false;
  }
}

/* ---- SSE streaming ---- */
function openStream(): void {
  if (!chat.value || cleanupSSE) return;
  isStreaming.value = true;
  streamingText.value = "";
  streamingTools.value = [];
  cleanupSSE = streamSSE(
    `/api/chats/${chat.value.id}/stream`,
    (data) => handleStreamEvent(data as unknown as ChatStreamEvent),
    () => {
      cleanupSSE = null;
      isStreaming.value = false;
      // Re-load persisted messages (the server persists the assistant turn
      // after run() returns, including tool messages we didn't capture).
      void loadMessages();
    },
  );
}

function handleStreamEvent(e: ChatStreamEvent): void {
  switch (e.type) {
    case "turn_start":
      streamingText.value = "";
      streamingTools.value = [];
      break;
    case "delta":
      streamingText.value = e.text;
      break;
    case "tool_start":
      streamingTools.value.push({ name: e.name, args: JSON.stringify(e.args) });
      break;
    case "tool_end": {
      const last = streamingTools.value.find((t) => t.name === e.name && t.ok === undefined);
      if (last) {
        last.ok = e.ok;
        last.result = e.text;
      }
      break;
    }
    case "turn_end":
      // Final text carried by the server — don't overwrite the streaming
      // text (it's the same), but clear streaming tools so they're replaced
      // by the persisted tool rows from loadMessages().
      streamingText.value = e.text;
      break;
    case "error":
      // The server also persists the error as a tool/assistant message, so
      // the thread will show it. Just clear the streaming state.
      break;
    // "done" — handled by onDone (cleanup callback)
  }
  void nextTick(scrollToBottom);
}

async function loadMessages(): Promise<void> {
  if (!chat.value) return;
  try {
    const data = await getJson<ChatDetailResponse>(`/api/chats/${chat.value.id}`);
    messages.value = data.messages ?? [];
    chat.value = data.chat;
    await nextTick(scrollToBottom);
  } catch {
    /* non-fatal — stale messages shown */
  }
}

/* ---- Send a prompt ---- */
async function send(): Promise<void> {
  const text = draft.value.trim();
  if (!text || !chat.value || sending.value || isStreaming.value) return;
  sending.value = true;
  draft.value = "";

  // Optimistic append of the user turn so the thread feels instant.
  const userMsg: ChatMessageRow = {
    id: Date.now(), // temp id — replaced on next loadMessages
    chat_id: chat.value.id,
    role: "user",
    text,
    tool_name: null,
    tool_call_id: null,
    created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
  };
  messages.value.push(userMsg);
  await nextTick(scrollToBottom);

  try {
    await sendJson<{ ok: boolean }>(`/api/chats/${chat.value.id}/messages`, "POST", { text });
    // Server accepted the prompt. Open the SSE stream to receive the agent's
    // answer in real time.
    openStream();
  } catch (e) {
    if (!isAuthError(e)) {
      loadError.value = e instanceof Error ? e.message : "Could not send message.";
    }
    // Remove the optimistic user message on failure.
    messages.value = messages.value.filter((m) => m.id !== userMsg.id);
  } finally {
    sending.value = false;
  }
}

/* ---- Cancel an in-flight prompt ---- */
async function cancel(): Promise<void> {
  if (!chat.value || !isStreaming.value) return;
  try {
    await sendJson<{ ok: boolean }>(`/api/chats/${chat.value.id}/cancel`, "POST");
  } catch {
    /* best-effort — the server will clean up the stream */
  }
}

/* ---- PATCH profile / thinking changes (applied at next boot) ---- */
async function onProfileChange(value: unknown): Promise<void> {
  if (!chat.value) return;
  const v = typeof value === "string" ? value : null;
  selectedProfile.value = v ?? "";
  try {
    const { chat: updated } = await sendJson<{ chat: ChatRow }>(
      `/api/chats/${chat.value.id}`,
      "PATCH",
      { profile: v },
    );
    chat.value = updated;
  } catch {
    /* revert local state on failure */
    selectedProfile.value = chat.value.profile ?? "";
  }
}

async function onThinkingChange(value: unknown): Promise<void> {
  if (!chat.value) return;
  const v = value as ThinkingLevel;
  selectedThinking.value = v;
  try {
    const { chat: updated } = await sendJson<{ chat: ChatRow }>(
      `/api/chats/${chat.value.id}`,
      "PATCH",
      { thinking_level: v },
    );
    chat.value = updated;
  } catch {
    /* revert local state on failure */
    selectedThinking.value = chat.value.thinking_level ?? "medium";
  }
}

/* ---- Keyboard: Enter sends, Shift+Enter newline ---- */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

function scrollToBottom(): void {
  const el = document.querySelector(".thread") as HTMLElement | null;
  if (el) el.scrollTop = el.scrollHeight;
}

function back(): void {
  if (window.history.length > 1) router.back();
  else void router.replace({ name: "chats" });
}

function startNew(): void {
  // Back to the composer landing — the prefill rule will seed it from the
  // most recent chat (this one) so the user can just start typing.
  void router.push({ name: "chats" });
}

/* ---- Lifecycle ---- */
watch(
  () => props.id,
  () => void load(),
);
onMounted(() => void load());
onUnmounted(() => {
  cleanupSSE?.();
});
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="ghost" size="sm" icon="back" @click="back">Back</Button>
      <Button
        v-if="chat"
        variant="ghost"
        size="sm"
        icon="refresh"
        :loading="loading"
        @click="load"
      >
        <span class="btn-label">Refresh</span>
      </Button>
      <Button variant="primary" size="sm" icon="plus" @click="startNew">New chat</Button>
    </template>

    <div v-if="loadError" class="banner err">{{ loadError }}</div>

    <div v-if="chat" class="chat-layout">
      <!-- Repo + branch echo — read-only context header -->
      <div class="chat-header">
        <div class="header-chip">
          <Icon name="book" :size="13" />
          <span>{{ chat.repo }}</span>
        </div>
        <div class="header-chip">
          <Icon name="branch" :size="13" />
          <span>{{ chat.branch }}</span>
        </div>
      </div>

      <div class="thread">
        <div v-if="messages.length === 0 && !isStreaming" class="empty-thread">
          Send a message to start the conversation.
        </div>

        <!-- Persisted messages -->
        <template v-for="msg in messages" :key="msg.id">
          <ChatBubble
            v-if="msg.role === 'user' || msg.role === 'assistant'"
            :message="{ role: msg.role, text: msg.text }"
          />
          <div v-else-if="msg.role === 'tool'" class="tool-chip">
            <span class="tool-chip-name">{{ msg.tool_name ?? "tool" }}</span>
            <span class="tool-chip-result">{{ msg.text }}</span>
          </div>
        </template>

        <!-- Live-streaming assistant bubble (only while the agent is answering) -->
        <template v-if="isStreaming">
          <ChatBubble
            v-if="streamingText"
            :message="{ role: 'assistant', text: streamingText }"
          />
          <div v-for="(tool, i) in streamingTools" :key="'st' + i" class="tool-chip">
            <span class="tool-chip-name">{{ tool.name }}</span>
            <span v-if="tool.ok !== undefined" class="tool-chip-status" :class="tool.ok ? 'ok' : 'err'">
              {{ tool.ok ? "✓" : "✗" }}
            </span>
          </div>
        </template>
      </div>

      <div class="composer">
        <div class="composer-controls">
          <div class="control-field">
            <label class="control-label">Profile</label>
            <Select
              :model-value="selectedProfile"
              :options="profileOptions"
              size="sm"
              @update:model-value="onProfileChange"
            />
          </div>
          <div class="control-field">
            <label class="control-label">Thinking</label>
            <Select
              :model-value="selectedThinking"
              :options="thinkingOptions"
              size="sm"
              @update:model-value="onThinkingChange"
            />
          </div>
        </div>
        <div class="composer-bar">
          <textarea
            v-model="draft"
            class="composer-input"
            rows="1"
            placeholder="Type a message…  (Enter to send, Shift+Enter for a newline)"
            :disabled="sending || isStreaming"
            @keydown="onKeydown"
          />
          <Button
            v-if="!isStreaming"
            variant="primary"
            size="md"
            icon="message"
            :loading="sending"
            :disabled="!canSend"
            @click="send"
          >
            Send
          </Button>
          <Button
            v-else
            variant="danger"
            size="md"
            :loading="false"
            @click="cancel"
          >
            Stop
          </Button>
        </div>
      </div>
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

/* ---- Chat layout ---- */
.chat-layout {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
  height: calc(100dvh - 100px);
}

/* Repo + branch read-only header */
.chat-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.header-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-size: var(--text-xs);
  color: var(--text-2);
  font-family: var(--font-mono);
}
.header-chip :deep(svg) {
  color: var(--text-3);
}

/* Conversation thread */
.thread {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-2) 0 var(--space-4);
  min-height: 0;
  overflow-y: auto;
}

.empty-thread {
  color: var(--text-3);
  font-size: var(--text-sm);
  text-align: center;
  padding: var(--space-8) 0;
}

/* Tool-result chip (smaller, under the assistant bubble) */
.tool-chip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-3);
  padding: 3px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  max-width: 320px;
  font-family: var(--font-mono);
}
.tool-chip-name {
  font-weight: var(--weight-semibold);
  color: var(--text-2);
}
.tool-chip-status.ok { color: var(--success); }
.tool-chip-status.err { color: var(--danger); }
.tool-chip-result {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
}

/* Composer — pinned to the bottom */
.composer {
  flex: 0 0 auto;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.composer-controls {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.control-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 140px;
  flex: 0 0 auto;
}
.control-label {
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-3);
}
.composer-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.composer-input {
  flex: 1 1 auto;
  min-height: 36px;
  max-height: 160px;
  resize: none;
  background: transparent;
  border: none;
  color: var(--text);
  font-size: var(--text-sm);
  font-family: var(--font-sans);
  line-height: var(--leading-relaxed);
  padding: var(--space-2) 0;
  outline: none;
}
.composer-input::placeholder {
  color: var(--text-3);
}
.composer-bar :deep(.btn) {
  flex: 0 0 auto;
}

/* ---------- Mobile (≤768px) ---------- */
@media (max-width: 768px) {
  .chat-layout {
    height: calc(100dvh - 148px);
  }
  .composer-bar {
    padding-bottom: max(var(--space-2), env(safe-area-inset-bottom));
  }
  .composer-input {
    font-size: var(--text-md);
  }
  .control-field {
    flex: 1 1 120px;
    min-width: 0;
  }
}
</style>
