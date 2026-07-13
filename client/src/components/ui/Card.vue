<script setup lang="ts">
/**
 * Elevated content card — the primary surface for grouped content. Glassy dark
 * surface, hairline border, soft shadow. Slots: title (optional header), default
 * (body). `pad` controls inner padding; `flush` is for tables/lists that carry
 * their own cell padding.
 */
withDefaults(
  defineProps<{
    title?: string;
    /** Optional muted descriptor shown under the title. */
    subtitle?: string;
    pad?: "default" | "flush";
  }>(),
  { pad: "default" },
);
</script>

<template>
  <section class="card" :class="pad">
    <header v-if="title || $slots.header" class="card-head">
      <slot name="header">
        <h3 class="card-title">{{ title }}</h3>
      </slot>
      <div v-if="$slots.actions" class="card-actions"><slot name="actions" /></div>
    </header>
    <p v-if="subtitle" class="card-subtitle">{{ subtitle }}</p>
    <div class="card-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.card {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  /* Horizontal padding matches .card-body so the title and header actions line
   * up exactly with the body content's edges (no 4px right-offset on actions). */
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}
.card-title {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  color: var(--text);
}
.card-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.card-subtitle {
  margin: 0;
  padding: var(--space-1) var(--space-4) 0;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.card-body {
  padding: var(--space-4);
}
.flush .card-body {
  padding: 0;
}
</style>
