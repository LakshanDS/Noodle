<script setup lang="ts">
/**
 * A compact status indicator: a colored dot + label, used for run/cron status
 * everywhere. The color is derived from the status value via the semantic
 * status tokens, so there's one source of truth for "what does running look
 * like."
 *
 * For larger contexts (a run detail header) use `size="md"`.
 */
import { computed } from "vue";
import type { RunStatus } from "../../api/types.js";

const props = withDefaults(
  defineProps<{ status: RunStatus | string; size?: "sm" | "md" }>(),
  { size: "sm" },
);

// Map any status string to (label, color, weak-bg). Handles the four run
// statuses plus "enabled"/"disabled" for crons.
const MAP: Record<string, { label: string; color: string; bg: string; pulse?: boolean }> = {
  succeeded: { label: "Succeeded", color: "var(--success)", bg: "var(--success-weak)" },
  failed: { label: "Failed", color: "var(--danger)", bg: "var(--danger-weak)" },
  running: { label: "Running", color: "var(--warning)", bg: "var(--warning-weak)", pulse: true },
  no_changes: { label: "No changes", color: "var(--neutral)", bg: "var(--neutral-weak)" },
  enabled: { label: "Enabled", color: "var(--success)", bg: "var(--success-weak)" },
  disabled: { label: "Disabled", color: "var(--neutral)", bg: "var(--neutral-weak)" },
};

const info = computed(() => MAP[props.status] ?? { label: props.status, color: "var(--neutral)", bg: "var(--neutral-weak)" });
</script>

<template>
  <span class="pill" :class="size" :style="{ color: info.color, background: info.bg }">
    <span class="dot" :class="{ pulse: info.pulse }" :style="{ background: info.color }" />
    {{ info.label }}
  </span>
</template>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: var(--weight-medium);
  letter-spacing: var(--tracking-tight);
  border-radius: var(--radius-full);
  white-space: nowrap;
  line-height: 1;
}
.sm {
  font-size: var(--text-xs);
  padding: 3px 8px 3px 7px;
}
.md {
  font-size: var(--text-sm);
  padding: 5px 11px 5px 10px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.pulse {
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.5;
    transform: scale(0.85);
  }
}
</style>
