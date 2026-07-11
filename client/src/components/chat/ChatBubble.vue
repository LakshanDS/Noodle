<script setup lang="ts">
/**
 * One user or assistant message in the conversation stream. Assistant turns sit
 * left; user turns sit right with the accent fill. Body is rendered as GFM
 * markdown (tables, code, lists) sanitized via DOMPurify — see lib/markdown.ts.
 */
import { computed } from "vue";
import type { ParsedChatMessage } from "../../api/types.js";
import { renderMarkdown } from "../../lib/markdown.js";

const props = defineProps<{ message: ParsedChatMessage }>();
const showText = computed(() => Boolean(props.message.text && props.message.text.trim()));
const html = computed(() => (showText.value ? renderMarkdown(props.message.text) : ""));
</script>

<template>
  <div class="msg" :class="message.role">
    <div v-if="showText" class="bubble markdown" v-html="html"></div>
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
.bubble {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
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

/* ---- markdown body typography ---- */
.markdown :deep(p) {
  margin: 0 0 var(--space-2);
}
.markdown :deep(p:last-child),
.markdown :deep(*:last-child) {
  margin-bottom: 0;
}
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4),
.markdown :deep(h5),
.markdown :deep(h6) {
  margin: var(--space-4) 0 var(--space-2);
  line-height: var(--leading-tight);
  font-weight: var(--weight-bold);
}
.markdown :deep(h1) { font-size: 1.25rem; }
.markdown :deep(h2) { font-size: 1.15rem; }
.markdown :deep(h3) { font-size: 1.05rem; }
.markdown :deep(h4),
.markdown :deep(h5),
.markdown :deep(h6) { font-size: 1rem; }
.markdown :deep(ul),
.markdown :deep(ol) {
  margin: 0 0 var(--space-2);
  padding-left: 1.4em;
}
.markdown :deep(li) {
  margin: 2px 0;
}
.markdown :deep(li > ul),
.markdown :deep(li > ol) {
  margin: 2px 0;
}
.markdown :deep(a) {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.markdown :deep(blockquote) {
  margin: 0 0 var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-left: 3px solid var(--border);
  opacity: 0.9;
}
.markdown :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: var(--space-3) 0;
}
.markdown :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.85em;
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
.markdown :deep(pre) {
  margin: 0 0 var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--text) 6%, transparent);
  border: 1px solid var(--border);
  overflow-x: auto;
}
.markdown :deep(pre code) {
  padding: 0;
  background: none;
  border: none;
  font-size: 0.85em;
  line-height: var(--leading-relaxed);
}
.markdown :deep(table) {
  border-collapse: collapse;
  margin: 0 0 var(--space-3);
  font-size: 0.9em;
  width: auto;
  max-width: 100%;
  overflow-x: auto;
  display: block;
}
.markdown :deep(th),
.markdown :deep(td) {
  border: 1px solid var(--border);
  padding: var(--space-1) var(--space-2);
  text-align: left;
}
.markdown :deep(th) {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  font-weight: var(--weight-bold);
}
/* On accent-filled user bubbles, lift nested surfaces so they stay readable. */
.msg.user .markdown :deep(code) {
  background: color-mix(in srgb, var(--text-inverse) 22%, transparent);
}
.msg.user .markdown :deep(pre) {
  background: color-mix(in srgb, var(--text-inverse) 16%, transparent);
  border-color: color-mix(in srgb, var(--text-inverse) 30%, transparent);
}
.msg.user .markdown :deep(blockquote) {
  border-left-color: color-mix(in srgb, var(--text-inverse) 50%, transparent);
}
.msg.user .markdown :deep(a) {
  color: var(--text-inverse);
  text-decoration: underline;
}
</style>
