<script setup lang="ts">
/**
 * One user or assistant message in the conversation stream. Assistant turns get
 * a small Noodle avatar chip and sit left; user turns sit right with the accent
 * fill. Plain text only (pre-wrap) — no markdown, matching the data the API
 * returns.
 */
import { computed } from "vue";
import type { ParsedChatMessage } from "../../api/types.js";

const props = defineProps<{ message: ParsedChatMessage }>();
const showText = computed(() => Boolean(props.message.text && props.message.text.trim()));
</script>

<template>
  <div class="msg" :class="message.role">
    <div v-if="message.role === 'assistant'" class="avatar">N</div>
    <div v-if="showText" class="bubble">{{ message.text }}</div>
  </div>
</template>

<style scoped>
.msg {
  display: flex;
  gap: var(--space-3);
  max-width: 100%;
}
.msg.user {
  flex-direction: row-reverse;
}
.avatar {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  background: var(--accent-weak);
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  display: flex;
  align-items: center;
  justify-content: center;
}
.bubble {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
  max-width: min(680px, 100%);
}
.msg.assistant .bubble {
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text);
  border-top-left-radius: var(--radius-xs);
}
.msg.user .bubble {
  background: var(--accent);
  color: var(--text-inverse);
  border-top-right-radius: var(--radius-xs);
}
</style>
