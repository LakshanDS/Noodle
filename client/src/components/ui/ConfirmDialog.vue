<script setup lang="ts">
/**
 * Modal confirmation dialog — replaces the native browser confirm() for
 * destructive or irreversible actions. Two-way bound on `open` so the caller
 * can drive it with a ref, and it can close itself (backdrop click / Esc).
 *
 * Renders through a Teleport to <body> so it escapes any transformed/stacked
 * ancestor (sticky sidebars, scale transitions) that would clip the overlay.
 *
 * Usage:
 *   <ConfirmDialog v-model:open="show" title="Delete command?"
 *     message="…" danger confirm-label="Delete" @confirm="onDelete" />
 */
import { watch, onBeforeUnmount } from "vue";
import Button from "./Button.vue";
import Icon from "./Icon.vue";
import type { IconName } from "./Icon.vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    icon?: IconName;
    /** When true, loading is driven by the parent via the `open` binding lifecycle. */
    loading?: boolean;
  }>(),
  {
    confirmLabel: "Confirm",
    cancelLabel: "Cancel",
    danger: false,
    loading: false,
  },
);

const emit = defineEmits<{
  "update:open": [value: boolean];
  confirm: [];
  cancel: [];
}>();

function close(): void {
  emit("update:open", false);
}

function onConfirm(): void {
  emit("confirm");
}

function onCancel(): void {
  emit("cancel");
  close();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && props.open) {
    e.preventDefault();
    onCancel();
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      window.addEventListener("keydown", onKeydown);
    } else {
      window.removeEventListener("keydown", onKeydown);
    }
  },
);

onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="overlay" @click.self="onCancel">
        <div
          class="dialog"
          role="alertdialog"
          aria-modal="true"
          :aria-label="title"
        >
          <div class="head">
            <div class="glyph" :class="{ danger }">
              <Icon :name="icon ?? (danger ? 'trash' : 'alert')" :size="18" />
            </div>
            <h2 class="title">{{ title }}</h2>
          </div>

          <p v-if="message" class="message">{{ message }}</p>

          <div class="actions">
            <Button
              variant="secondary"
              :disabled="loading"
              @click="onCancel"
            >
              {{ cancelLabel }}
            </Button>
            <Button
              variant="danger"
              :icon="danger ? 'trash' : undefined"
              :loading="loading"
              @click="onConfirm"
            >
              {{ confirmLabel }}
            </Button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
}

.dialog {
  width: 100%;
  max-width: 400px;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--space-6);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: var(--surface-3);
  border: 1px solid var(--border);
  color: var(--text-2);
}
.glyph.danger {
  background: var(--danger-weak);
  border-color: color-mix(in srgb, var(--danger) 35%, transparent);
  color: var(--danger);
}

.title {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  color: var(--text);
  letter-spacing: var(--tracking-tight);
}

.message {
  font-size: var(--text-sm);
  color: var(--text-2);
  line-height: var(--leading-normal);
  margin: 0 0 var(--space-5);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

/* Overlay fades; dialog scales/fades with it for a single coordinated motion. */
.modal-enter-active,
.modal-leave-active {
  transition: opacity var(--dur) var(--ease);
}
.modal-enter-active .dialog,
.modal-leave-active .dialog {
  transition:
    transform var(--dur) var(--ease),
    opacity var(--dur) var(--ease);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .dialog,
.modal-leave-to .dialog {
  opacity: 0;
  transform: scale(0.96) translateY(4px);
}

@media (max-width: 480px) {
  .dialog {
    padding: var(--space-5);
  }
  .actions {
    flex-direction: column-reverse;
  }
  .actions :deep(.btn) {
    width: 100%;
  }
}
</style>
