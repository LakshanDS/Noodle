<script setup lang="ts">
/**
 * Styled dropdown — the form-control replacement for every native <select>.
 * Same opaque-panel aesthetic as the repo/branch autocomplete (surface-2 card,
 * accent highlight, rounded), but picks from a fixed option list (no typing).
 *
 * Two-way bound on `modelValue`; options are { value, label } pairs so a caller
 * can carry any value type (string, number, undefined). Internally owns the
 * open/highlight state, click-outside + keyboard nav, so callers add nothing.
 *
 * The panel is Teleported to <body> and positioned via getBoundingClientRect()
 * so it escapes ancestors with `overflow: hidden` (e.g. Card) — z-index alone
 * can't fix that clipping.
 *
 * Usage:
 *   <Select v-model="form.profile" :options="profileOptions" />
 *   <Select v-model="level" :options="LEVELS" size="sm" />
 */
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import Icon from "./Icon.vue";

export interface SelectOption {
  value: unknown;
  label: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    options: SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    size?: "sm" | "md";
    mono?: boolean;
  }>(),
  { placeholder: "Select…", disabled: false, size: "md", mono: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: unknown];
}>();

const open = ref(false);
const highlight = ref(-1);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);

/** Fixed position of the teleported panel, synced to the trigger rect. */
const panelPos = ref({ top: 0, left: 0, width: 0 });

/** Label for the currently selected value (or placeholder if none/unmatched). */
const selectedLabel = computed(() => {
  const match = props.options.find((o) => o.value === props.modelValue);
  return match ? match.label : props.placeholder;
});

const hasSelection = computed(() =>
  props.options.some((o) => o.value === props.modelValue),
);

/** Measure the trigger and position the panel just below it. */
function syncPosition(): void {
  const el = trigger.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  panelPos.value = {
    top: r.bottom + 4,
    left: r.left,
    width: r.width,
  };
}

function toggleOpen(): void {
  if (props.disabled) return;
  if (!open.value) {
    syncPosition();
    // Start highlight on the current selection (or first option).
    highlight.value = props.options.findIndex((o) => o.value === props.modelValue);
    if (highlight.value < 0 && props.options.length) highlight.value = 0;
  }
  open.value = !open.value;
}

function close(): void {
  open.value = false;
}

function pick(option: SelectOption, e?: MouseEvent): void {
  e?.preventDefault();
  emit("update:modelValue", option.value);
  close();
  void nextTick(() => trigger.value?.focus());
}

function onKeydown(e: KeyboardEvent): void {
  if (props.disabled) return;
  const n = props.options.length;

  if (!open.value) {
    // Open on ArrowDown/ArrowUp/Enter/Space when closed.
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      syncPosition();
      open.value = true;
      highlight.value = Math.max(
        0,
        props.options.findIndex((o) => o.value === props.modelValue),
      );
    }
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    highlight.value = n ? (highlight.value + 1) % n : -1;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    highlight.value = n ? (highlight.value - 1 + n) % n : -1;
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (highlight.value >= 0 && highlight.value < n) pick(props.options[highlight.value]);
  } else if (e.key === "Escape") {
    e.preventDefault();
    close();
    void nextTick(() => trigger.value?.focus());
  }
}

/** Click-outside closes the panel. Checks both the trigger root and the
 *  teleported panel (they're in different parts of the DOM tree). */
function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (root.value?.contains(target)) return;
  if (panelEl.value?.contains(target)) return;
  close();
}

/** Keep the panel glued to the trigger while open during scroll/resize. */
function onScrollOrResize(): void {
  if (open.value) syncPosition();
}

onMounted(() => {
  document.addEventListener("mousedown", onDocClick);
  window.addEventListener("scroll", onScrollOrResize, true);
  window.addEventListener("resize", onScrollOrResize);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocClick);
  window.removeEventListener("scroll", onScrollOrResize, true);
  window.removeEventListener("resize", onScrollOrResize);
});

// Close + reset when disabled (defensive — shouldn't normally toggle).
watch(() => props.disabled, (d) => { if (d) close(); });
</script>

<template>
  <div
    ref="root"
    class="select"
    :class="[size, { open, disabled, mono, 'has-value': hasSelection }]"
    @keydown="onKeydown"
  >
    <button
      ref="trigger"
      type="button"
      class="trigger"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggleOpen"
    >
      <span class="value">{{ selectedLabel }}</span>
      <Icon name="chevronDown" :size="14" class="chev" />
    </button>

    <Teleport to="body">
      <Transition name="dd">
        <ul
          v-if="open && options.length"
          ref="panelEl"
          class="select-panel"
          :class="{ mono }"
          role="listbox"
          :style="{
            top: panelPos.top + 'px',
            left: panelPos.left + 'px',
            width: panelPos.width + 'px',
          }"
        >
          <li
            v-for="(opt, i) in options"
            :key="i"
            class="opt"
            :class="{ active: i === highlight, selected: opt.value === modelValue }"
            role="option"
            :aria-selected="opt.value === modelValue"
            @mousedown.prevent="pick(opt, $event)"
            @mouseenter="highlight = i"
          >
            <span class="opt-label">{{ opt.label }}</span>
            <Icon
              v-if="opt.value === modelValue"
              name="check"
              :size="14"
              class="opt-check"
            />
          </li>
        </ul>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.select {
  position: relative;
  width: 100%;
}

/* Trigger mirrors .ctrl so it drops into <Field> identically to inputs. */
.trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  width: 100%;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text);
  font-size: var(--text-sm);
  padding: 9px 12px;
  text-align: left;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}
.trigger:hover:not(:disabled) {
  border-color: var(--border-strong);
}
.select.open .trigger,
.trigger:focus-visible {
  outline: none;
  border-color: var(--accent);
  background: var(--surface-0);
  box-shadow: 0 0 0 3px var(--accent-weaker);
}
.trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}
.select:not(.has-value) .value {
  color: var(--text-3);
}

.chev {
  flex: 0 0 auto;
  color: var(--text-3);
  transition: transform var(--dur-fast) var(--ease);
}
.select.open .chev {
  transform: rotate(180deg);
  color: var(--text-2);
}

/* Sizes — match Button heights (30px sm / 36px md). */
.sm .trigger {
  height: 30px;
  padding: 0 10px;
  font-size: var(--text-xs);
}
.md .trigger {
  height: 36px;
  padding: 0 var(--space-3);
}

/* Mono: the trigger's selected value renders in the mono face. */
.mono .value {
  font-family: var(--font-mono);
}
</style>

<!--
  The panel is Teleported to <body>, so its styles must be unscoped (global)
  to apply — scoped styles add a data-attribute selector that the teleported
  node won't carry. We use a unique class name to avoid collisions.
-->
<style>
.select-panel {
  position: fixed;
  z-index: 1000;
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 260px;
  overflow-y: auto;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
}
.select-panel.mono .opt-label {
  font-family: var(--font-mono);
}
.select-panel .opt {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 7px var(--space-3);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.select-panel .opt:hover,
.select-panel .opt.active {
  background: var(--accent-weak);
}
.select-panel .opt.selected {
  color: var(--accent);
}
.select-panel .opt-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  color: var(--text-2);
}
.select-panel .opt.selected .opt-label,
.select-panel .opt.active .opt-label {
  color: var(--text);
}
.select-panel .opt-check {
  flex: 0 0 auto;
  color: var(--accent);
}

/* Open/close transition. */
.dd-enter-active,
.dd-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}
.dd-enter-from,
.dd-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
