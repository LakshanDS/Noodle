<script setup lang="ts">
/**
 * Form field wrapper: label + control + hint/error. The control itself is
 * rendered via the default slot so any input/textarea/select works. Keeps form
 * rhythm consistent across Settings, Cron form, and Setup.
 */
withDefaults(defineProps<{ label: string; hint?: string; error?: string; for?: string }>(), {});
</script>

<template>
  <div class="field">
    <label class="label" :for="$props.for">{{ label }}</label>
    <slot />
    <p v-if="error" class="msg err">{{ error }}</p>
    <p v-else-if="hint" class="msg hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.field {
  margin-bottom: var(--space-4);
}
.field:last-child {
  margin-bottom: 0;
}
.label {
  display: block;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--text-2);
  margin-bottom: 6px;
  letter-spacing: var(--tracking-wide);
  text-transform: uppercase;
}
.msg {
  margin: 6px 0 0;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.hint {
  color: var(--text-3);
}
.err {
  color: var(--danger);
}
</style>
