<script setup lang="ts">
/**
 * Chat detail — a single conversation thread with a composer at the bottom.
 * Mock-backed: sending a message appends it plus a canned assistant reply via
 * `mockAppendMessage`. There's no real model behind this; it exists to flesh out
 * the UI. Mounted for both /chats/:id (existing) and /chats/new (isNew prop).
 *
 * Unlike RunDetailView, there's no meta sidebar — the column is the conversation.
 */
import { nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { mockAppendMessage, mockCreateChat, mockGetChat, type MockChat } from "../lib/mock.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Icon from "../components/ui/Icon.vue";
import ChatBubble from "../components/chat/ChatBubble.vue";

const props = defineProps<{ id?: string; isNew?: boolean }>();
const router = useRouter();

const chat = ref<MockChat | null>(null);
const loading = ref(false);
const loadError = ref("");
const draft = ref("");
const sending = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    if (props.isNew) {
      // Create an empty chat immediately so the composer has a target.
      const { chat: created } = await mockCreateChat();
      chat.value = created;
    } else if (props.id) {
      const { chat: found } = await mockGetChat(props.id);
      chat.value = found;
    }
    await nextTick(scrollToBottom);
  } catch {
    loadError.value = "Could not load chat.";
  } finally {
    loading.value = false;
  }
}

function scrollToBottom(): void {
  const el = document.querySelector(".thread") as HTMLElement | null;
  if (el) el.scrollTop = el.scrollHeight;
}

async function send(): Promise<void> {
  const text = draft.value.trim();
  if (!text || !chat.value || sending.value) return;
  sending.value = true;
  draft.value = "";
  try {
    const { chat: updated } = await mockAppendMessage(chat.value.id, text);
    chat.value = updated;
    await nextTick(scrollToBottom);
  } finally {
    sending.value = false;
  }
}

/** Enter sends; Shift+Enter inserts a newline. */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

function back(): void {
  if (window.history.length > 1) router.back();
  else void router.replace({ name: "chats" });
}

/** Stub for the "add media" affordance — no upload wired yet. */
function onAddMedia(): void {
  // TODO: wire a file picker / paste-image handler once uploads are supported.
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
        <span class="btn-label">Refresh</span>
      </Button>
    </template>

    <div v-if="loadError" class="banner err">{{ loadError }}</div>

    <div v-if="!chat && loading" class="loading-row">Loading chat…</div>

    <div v-else-if="chat" class="chat-layout">
      <div class="thread">
        <div v-if="chat.messages.length === 0" class="empty-thread">
          Send a message to start the conversation.
        </div>
        <ChatBubble v-for="(msg, i) in chat.messages" :key="i" :message="msg" />
      </div>

      <div class="composer">
        <div class="composer-bar">
          <button class="composer-add" type="button" title="Add media" @click="onAddMedia">
            <Icon name="attach" :size="18" />
          </button>
          <textarea
            v-model="draft"
            class="composer-input"
            rows="1"
            placeholder="Type a message…  (Enter to send, Shift+Enter for a newline)"
            :disabled="sending"
            @keydown="onKeydown"
          />
          <Button variant="primary" size="md" icon="message" :loading="sending" :disabled="!draft.trim()" @click="send">
            Send
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

.loading-row {
  padding: var(--space-12);
  text-align: center;
  color: var(--text-3);
  font-size: var(--text-sm);
}

/* Fill the available viewport height so the composer pins to the bottom and
 * the thread grows to fill the space above it. The subtracted chrome is the
 * .main top padding (space-4) + action-panel row (44px + its space-4 margin)
 * + .main bottom padding (space-6). On mobile the action-panel wraps and the
 * mobile top bar adds height, so the offset is larger (see the media query). */
.chat-layout {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-height: 0;
  height: calc(100dvh - 100px);
}

/* The conversation thread: grows to fill, scrolls when it overflows. */
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

/* Composer — pinned to the bottom of the filled layout, full width. */
.composer {
  flex: 0 0 auto;
  width: 100%;
}
/* A single connected bar: media "+" on the left, textarea filling the middle,
 * Send button fixed on the right. Items align so the bar stays one row and the
 * button centers vertically against a single-line textarea. */
.composer-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.composer-add {
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  color: var(--text-2);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.composer-add:hover {
  background: var(--surface-4);
  color: var(--text);
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

/* ---------- Mobile (≤768px) ----------
 * On mobile the action panel wraps above the mobile top bar, so the height
 * offset grows. The safe-area inset keeps the composer clear of the iPhone
 * home indicator. */
@media (max-width: 768px) {
  .chat-layout {
    /* mobile top bar (52px) + .main top/bottom padding + action panel. */
    height: calc(100dvh - 148px);
  }
  .composer-bar {
    padding-bottom: var(--space-2);
    padding-bottom: max(var(--space-2), env(safe-area-inset-bottom));
  }
  .composer-input {
    font-size: var(--text-md);
  }
}
</style>
