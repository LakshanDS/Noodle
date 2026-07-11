<script setup lang="ts">
/**
 * An expandable tool-call chip beneath an assistant message. Collapsed it shows
 * a monospace label (summarizeArgs) + a chevron; expanded, the pretty-printed
 * args JSON in a mono code block.
 */
import { ref } from "vue";
import type { ParsedToolCall } from "../../api/types.js";
import { summarizeArgs } from "../../lib/format.js";
import Icon from "../ui/Icon.vue";

const props = defineProps<{ call: ParsedToolCall }>();
const open = ref(false);
const label = summarizeArgs(props.call.name, props.call.args);
const argsJson = JSON.stringify(props.call.args, null, 2);
</script>

<template>
  <div class="tool-call">
    <button class="tool-head" :class="{ open }" @click="open = !open">
      <span class="tool-glyph"><Icon name="bolt" :size="11" /></span>
      <span class="tool-name mono">{{ call.name }}</span>
      <span class="tool-summary ellipsis">{{ label }}</span>
      <Icon name="chevronDown" :size="14" class="chev" />
    </button>
    <div v-if="open" class="tool-body">
      <pre>{{ argsJson }}</pre>
    </div>
  </div>
</template>

<style scoped>
.tool-call {
  width: min(680px, 100%);
}
.tool-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 7px 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text-2);
  font-size: var(--text-xs);
  text-align: left;
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
.tool-head:hover {
  background: var(--surface-3);
  border-color: var(--border-strong);
}
.tool-glyph {
  display: flex;
  color: var(--accent);
}
.tool-name {
  color: var(--text);
  font-weight: var(--weight-semibold);
  font-size: var(--text-xs);
  flex: 0 0 auto;
}
.tool-summary {
  color: var(--text-3);
  flex: 1 1 auto;
  min-width: 0;
}
.chev {
  flex: 0 0 auto;
  color: var(--text-3);
  transition: transform var(--dur-fast) var(--ease);
}
.open .chev {
  transform: rotate(180deg);
}
.tool-body {
  margin-top: var(--space-1);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  overflow-x: auto;
}
.tool-body pre {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
