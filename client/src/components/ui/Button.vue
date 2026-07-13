<script setup lang="ts">
/**
 * The one button component. Variants drive the visual treatment; sizes drive
 * padding + height. An optional leading icon keeps spacing consistent without
 * each caller reaching for a flex wrapper.
 *
 * Variants:
 *   primary   — accent fill, the main action on a screen (one per view ideally)
 *   secondary — elevated surface, the default for most actions
 *   ghost     — transparent, for low-emphasis / toolbar actions
 *   danger    — outlined danger, for destructive actions
 */
import Icon from "./Icon.vue";
import type { IconName } from "./Icon.vue";

withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "ghost" | "danger";
    size?: "sm" | "md";
    icon?: IconName;
    loading?: boolean;
    disabled?: boolean;
    type?: "button" | "submit";
  }>(),
  { variant: "secondary", size: "md", loading: false, disabled: false, type: "button" },
);
</script>

<template>
  <button
    class="btn"
    :class="[variant, size, { loading }]"
    :disabled="disabled || loading"
    :type="type"
  >
    <span v-if="loading" class="spinner" aria-hidden="true" />
    <Icon v-else-if="icon" :name="icon" :size="size === 'sm' ? 13 : 15" />
    <slot />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  font-weight: var(--weight-medium);
  font-size: var(--text-sm);
  letter-spacing: var(--tracking-tight);
  border-radius: var(--radius-md);
  white-space: nowrap;
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    opacity var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
  user-select: none;
}
.btn:active {
  transform: translateY(0.5px);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* Sizes */
.sm {
  height: 30px;
  padding: 0 10px;
  font-size: var(--text-xs);
}
.md {
  height: 36px;
  padding: 0 var(--space-3);
}

/* On touch screens the 30/36px heights are below the comfortable tap target.
 * Grow to a 40px minimum below the mobile breakpoint without changing the
 * visual proportions on desktop. */
@media (max-width: 768px) {
  .sm {
    min-height: 40px;
  }
  .md {
    min-height: 40px;
  }
}

/* Variants */
.primary {
  background: var(--accent);
  color: var(--text-inverse);
  border: 1px solid var(--accent);
}
.primary:not(:disabled):hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.secondary {
  background: var(--surface-3);
  color: var(--text);
  border: 1px solid var(--border);
}
.secondary:not(:disabled):hover {
  background: var(--surface-4);
  border-color: var(--border-strong);
}

.ghost {
  background: transparent;
  color: var(--text-2);
  border: 1px solid transparent;
}
.ghost:not(:disabled):hover {
  background: var(--surface-3);
  color: var(--text);
}

.danger {
  background: transparent;
  color: var(--danger);
  border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
}
.danger:not(:disabled):hover {
  background: var(--danger-weak);
}

/* Spinner replaces the icon slot while loading */
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-bottom-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
