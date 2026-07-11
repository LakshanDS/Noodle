<script setup lang="ts">
/**
 * A tool result rendered as a dim, collapsed block beneath the turn that
 * produced it. Shows "toolName → text" cropped to a few lines with an expand
 * toggle when the output is long.
 */
import { computed, ref } from "vue";
import type { ParsedToolResult } from "../../api/types.js";

const props = defineProps<{ result: ParsedToolResult }>();
const expanded = ref(false);
const canExpand = computed(() => props.result.text.length > 200);
</script>

<template>
  <div class="tool-result">
    <div class="result-head">
      <span class="r-name mono">{{ result.toolName }}</span>
      <span class="r-arrow">→</span>
    </div>
    <pre class="result-body" :class="{ collapsed: !expanded }">{{ result.text }}</pre>
    <button v-if="canExpand" class="expand" @click="expanded = !expanded">
      {{ expanded ? "Show less" : "Show more" }}
    </button>
  </div>
</template>

<style scoped>
.tool-result {
  width: min(680px, 100%);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}
.result-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.r-name {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-2);
}
.r-arrow {
  color: var(--text-3);
  font-size: var(--text-xs);
}
.result-body {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--text-3);
  white-space: pre-wrap;
  word-break: break-word;
}
.result-body.collapsed {
  max-height: 96px;
  overflow: hidden;
  mask-image: linear-gradient(to bottom, #000 70px, transparent);
}
.expand {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--accent);
}
.expand:hover {
  color: var(--accent-hover);
}
</style>
