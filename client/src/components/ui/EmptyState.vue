<script setup lang="ts">
/**
 * Centered empty/placeholder state with an icon glyph, title, and optional
 * description + action slot. Used by every list view when there's nothing yet.
 */
import Icon from "./Icon.vue";
import type { IconName } from "./Icon.vue";

defineProps<{ icon?: IconName; title: string; desc?: string }>();
</script>

<template>
  <div class="empty">
    <div class="glyph">
      <Icon v-if="icon" :name="icon" :size="22" />
    </div>
    <h3 class="title">{{ title }}</h3>
    <p v-if="desc" class="desc">{{ desc }}</p>
    <div v-if="$slots.default" class="action">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--space-16) var(--space-6);
}
.glyph {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-lg);
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-3);
  margin-bottom: var(--space-4);
}
.title {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  color: var(--text);
  margin-bottom: var(--space-1);
}
.desc {
  font-size: var(--text-sm);
  color: var(--text-3);
  max-width: 340px;
  line-height: var(--leading-normal);
}
.action {
  margin-top: var(--space-5);
}
</style>
