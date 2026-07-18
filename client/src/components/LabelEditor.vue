<script setup lang="ts">
/**
 * Three-row editor for a label set (Start / Finished / Failed), each row being a
 * name input + a custom color picker + a hex field. Extracted from the
 * triplicated implementations that previously lived inline in SettingsView,
 * CommandDetailView, and TriggerDetailView so all three stay in sync.
 *
 * Two-way bound on `modelValue` (a length-3 array of { name, color }, indexed
 * by stage: [Start, Finished, Failed]). Emits immutable updates so v-model
 * reactivity flows back to the parent, which owns the JSON serialization to and
 * from the stored `{cooking,cooked,failed}` shape.
 *
 * The color picker is a teleported panel of curated preset swatches — it
 * replaces the native <input type="color">, whose OS-styled box clashed with
 * the dark UI. Position is taken from the clicked button's rect; the panel is
 * captured via a function-ref (a template ref inside the v-for row would
 * collect an array, which has no .contains). Closes on outside-click / scroll.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./ui/Icon.vue";

/** One stage row's editable fields. */
export interface LabelField {
  name: string;
  color: string;
}

/** Fixed stage metadata — order is the contract for `modelValue` indexing. */
const STAGES = [
  { key: "cooking", label: "Start" },
  { key: "cooked", label: "Finished" },
  { key: "failed", label: "Failed" },
] as const;

/**
 * Curated color presets — drawn from the app's warm-monochrome + status palette
 * so labels feel native rather than rainbow GitHub defaults. 12 swatches fill
 * the 4-column grid as exactly 3 rows.
 */
const PRESETS = [
  "d4a942", "6fae6f", "c76b6b", "f0ead6",
  "8b8b8b", "c97a4a", "9b7fb5", "5a9bb5",
  "b58a3c", "4a9b6f", "a04a4a", "5c5c5c",
] as const;

const props = defineProps<{ modelValue: LabelField[] }>();
const emit = defineEmits<{ "update:modelValue": [value: LabelField[]] }>();

/** Replace a row immutably and emit, so v-model reactivity flows to parent. */
function patch(i: number, field: "name" | "color", value: string): void {
  const next = props.modelValue.map((row, idx) =>
    idx === i ? { ...row, [field]: value } : row,
  );
  emit("update:modelValue", next);
}
function setName(i: number, name: string): void {
  patch(i, "name", name);
}
function setColor(i: number, color: string): void {
  patch(i, "color", color.replace(/^#/, "").toLowerCase());
}

/* ----- Color picker (teleported swatch panel) ----- */
const pickerOpenIndex = ref<number | null>(null);
const pickerPanelEl = ref<HTMLElement | null>(null);
const pickerPos = ref({ top: 0, left: 0 });

function openPicker(i: number, e: MouseEvent): void {
  if (pickerOpenIndex.value === i) {
    pickerOpenIndex.value = null;
    return;
  }
  const trigger = e.currentTarget as HTMLElement;
  const r = trigger.getBoundingClientRect();
  pickerPos.value = { top: r.bottom + 4, left: r.left };
  pickerOpenIndex.value = i;
}
function closePicker(): void {
  pickerOpenIndex.value = null;
}
function onPickerDocClick(e: MouseEvent): void {
  if (pickerOpenIndex.value == null) return;
  const t = e.target as Node;
  if (pickerPanelEl.value?.contains(t)) return;
  closePicker();
}
function onPickerScrollOrResize(): void {
  if (pickerOpenIndex.value != null) closePicker();
}
onMounted(() => {
  document.addEventListener("mousedown", onPickerDocClick);
  window.addEventListener("scroll", onPickerScrollOrResize, true);
  window.addEventListener("resize", onPickerScrollOrResize);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onPickerDocClick);
  window.removeEventListener("scroll", onPickerScrollOrResize, true);
  window.removeEventListener("resize", onPickerScrollOrResize);
});
</script>

<template>
  <div class="le-rows">
    <div v-for="(stage, i) in STAGES" :key="stage.key" class="le-row">
      <span class="le-stage">{{ stage.label }}</span>
      <input
        :value="modelValue[i]?.name"
        type="text"
        class="ctrl"
        placeholder="Label name"
        autocomplete="off"
        @input="setName(i, ($event.target as HTMLInputElement).value)"
      />
      <button
        type="button"
        class="swatch-btn"
        :title="'Pick color for ' + stage.label"
        @click="openPicker(i, $event)"
      >
        <span class="label-swatch" :style="{ background: '#' + (modelValue[i]?.color ?? '000000') }"></span>
      </button>
      <Teleport to="body">
        <Transition name="dd">
          <div
            v-if="pickerOpenIndex === i"
            :ref="(el) => { pickerPanelEl = el as HTMLElement | null }"
            class="color-panel"
            role="dialog"
            :style="{ top: pickerPos.top + 'px', left: pickerPos.left + 'px' }"
          >
            <button
              v-for="c in PRESETS"
              :key="c"
              type="button"
              class="color-opt"
              :class="{ selected: c === modelValue[i]?.color }"
              :style="{ background: '#' + c }"
              :title="'#' + c"
              @click="setColor(i, c); closePicker()"
            >
              <Icon v-if="c === modelValue[i]?.color" name="check" :size="12" class="color-opt-check" />
            </button>
          </div>
        </Transition>
      </Teleport>
    </div>
  </div>
</template>

<style scoped>
.le-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.le-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.le-stage {
  flex: 0 0 70px;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-2);
}
/* The editable label-name input grows to fill the row. */
.le-row > .ctrl {
  flex: 1 1 auto;
}
.label-swatch {
  display: block;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  transition: transform var(--dur-fast) var(--ease);
}
/* The swatch button opens the custom color picker panel. Styled to match the
 * input controls — same height, hairline border, subtle hover lift. */
.swatch-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.swatch-btn:hover {
  border-color: var(--border-strong);
  background: var(--surface-3);
}
.swatch-btn:hover .label-swatch {
  transform: scale(1.1);
}
</style>

<!--
  The color-picker panel is Teleported to <body>, so its styles must be unscoped
  (global) to apply — scoped styles add a data-attribute selector the teleported
  node won't carry.
-->
<style>
.color-panel {
  position: fixed;
  z-index: 1000;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  padding: 8px;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
}
.color-opt {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    transform var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
.color-opt:hover {
  transform: scale(1.12);
  border-color: var(--accent);
}
.color-opt.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-ring);
}
.color-opt-check {
  color: rgba(0, 0, 0, 0.8);
}
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
