<script setup lang="ts">
/**
 * Command create/edit form. Two columns: the form fields on the left, a context
 * sidebar on the right (trigger preview). Save creates or updates; after a
 * create we navigate to the edit route so a subsequent save updates.
 *
 * Reads/writes commands via /api/commands (DB-backed).
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getJson, sendJson, isAuthError } from "../api/client.js";
import type {
  CommandDetailResponse,
  CommandMutationResponse,
  ProfilesResponse,
  CommandInput,
} from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import ConfirmDialog from "../components/ui/ConfirmDialog.vue";
import Field from "../components/ui/Field.vue";
import Icon from "../components/ui/Icon.vue";
import LabelEditor from "../components/LabelEditor.vue";
import type { LabelField } from "../components/LabelEditor.vue";
import Select from "../components/ui/Select.vue";
import type { SelectOption } from "../components/ui/Select.vue";

const props = defineProps<{ id?: string; isNew?: boolean }>();
const router = useRouter();

const form = ref({
  trigger: "",
  description: "",
  system_prompt: "",
  profile: "",
  enabled: 1,
});

// Custom-labels toggle + 3 label fields. When off, the command uses the global
// default labels (Settings → GitHub labels). When on, these 3 override them.
// Pre-filled with the global defaults so the operator edits only what they want.
const useCustomLabels = ref(false);
const DEFAULT_LABELS = {
  cooking: { name: "Noodle is cooking", color: "d4a942" },
  cooked: { name: "Noodle cooked here", color: "6fae6f" },
  failed: { name: "Noodle got Cooked", color: "c76b6b" },
};
const labelFields = ref<LabelField[]>([
  { ...DEFAULT_LABELS.cooking },
  { ...DEFAULT_LABELS.cooked },
  { ...DEFAULT_LABELS.failed },
]);

const profiles = ref<string[]>([]);
const defaultProfile = ref("");
const saving = ref(false);
const errorMsg = ref("");
const loading = ref(false);
const showDeleteConfirm = ref(false);
const deleting = ref(false);
/** Built-in commands (the seeded /<agent> default) are not deletable. */
const isBuiltin = ref(false);

const editing = computed(() => !props.isNew && props.id != null);
/** Trigger shown as it would appear in a GitHub issue. */
const triggerPreview = computed(() => "/" + (form.value.trigger || "command"));
const profileOptions = computed<SelectOption[]>(() => [
  { value: "", label: "Default" },
  ...profiles.value.map((p) => ({
    value: p,
    label: p + (p === defaultProfile.value ? " (default)" : ""),
  })),
]);

function emptyForm() {
  return {
    trigger: "",
    description: "",
    system_prompt: "",
    profile: "",
    enabled: 1,
  };
}

async function ensureProfiles(): Promise<void> {
  if (profiles.value.length) return;
  try {
    const body = await getJson<ProfilesResponse>("/api/profiles");
    profiles.value = body.profiles ?? [];
    defaultProfile.value = body.default ?? "";
  } catch {
    /* dropdown shows Default only */
  }
}

async function loadCommand(): Promise<void> {
  if (!editing.value || props.id == null) {
    form.value = emptyForm();
    // New command: custom labels off, fields pre-filled with the global defaults.
    useCustomLabels.value = false;
    labelFields.value = [
      { ...DEFAULT_LABELS.cooking },
      { ...DEFAULT_LABELS.cooked },
      { ...DEFAULT_LABELS.failed },
    ];
    return;
  }
  loading.value = true;
  try {
    const body = await getJson<CommandDetailResponse>(`/api/commands/${props.id}`);
    const c = body.command;
    form.value = {
      trigger: c.trigger,
      description: c.description,
      system_prompt: c.system_prompt,
      profile: c.profile ?? "",
      enabled: c.enabled,
    };
    isBuiltin.value = c.is_builtin === 1;
    // Parse the command's custom labels. If set, populate the 3 fields + turn the
    // toggle on. If null, leave the toggle off and fields at the global defaults.
    let parsed: typeof DEFAULT_LABELS | null = null;
    if (c.labels) {
      try { parsed = JSON.parse(c.labels) as typeof DEFAULT_LABELS; } catch { /* ignore */ }
    }
    if (parsed && parsed.cooking && parsed.cooked && parsed.failed) {
      useCustomLabels.value = true;
      labelFields.value = [
        { name: parsed.cooking.name, color: parsed.cooking.color },
        { name: parsed.cooked.name, color: parsed.cooked.color },
        { name: parsed.failed.name, color: parsed.failed.color },
      ];
    } else {
      useCustomLabels.value = false;
      labelFields.value = [
        { ...DEFAULT_LABELS.cooking },
        { ...DEFAULT_LABELS.cooked },
        { ...DEFAULT_LABELS.failed },
      ];
    }
  } catch (e) {
    if (isAuthError(e)) return;
    errorMsg.value = e instanceof Error ? e.message : "Could not load command.";
  } finally {
    loading.value = false;
  }
}

function payload(): CommandInput {
  const [cooking, cooked, failed] = labelFields.value;
  return {
    trigger: form.value.trigger.trim(),
    description: form.value.description.trim(),
    system_prompt: form.value.system_prompt,
    profile: form.value.profile || null,
    // Serialize the 3 custom labels when the toggle is on; null clears them so
    // the command falls back to the global default labels.
    labels: useCustomLabels.value
      ? JSON.stringify({
          cooking: { name: cooking.name.trim(), color: cooking.color },
          cooked: { name: cooked.name.trim(), color: cooked.color },
          failed: { name: failed.name.trim(), color: failed.color },
        })
      : null,
  };
}

async function save(): Promise<void> {
  errorMsg.value = "";
  if (!form.value.trigger.trim()) {
    errorMsg.value = "Trigger is required.";
    return;
  }
  saving.value = true;
  try {
    if (editing.value && props.id != null) {
      await sendJson<CommandMutationResponse>(`/api/commands/${props.id}`, "PATCH", payload());
      await loadCommand();
    } else {
      const body: CommandMutationResponse = await sendJson<CommandMutationResponse>("/api/commands", "POST", payload());
      await router.replace({ name: "command-detail", params: { id: String(body.command.id) } });
    }
  } catch (e) {
    if (isAuthError(e)) return;
    errorMsg.value = e instanceof Error ? e.message : "Could not reach server";
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(): Promise<void> {
  if (!editing.value || props.id == null) return;
  const enable = form.value.enabled === 0;
  form.value.enabled = enable ? 1 : 0;
}

function deleteCommand(): void {
  if (!editing.value || props.id == null) return;
  showDeleteConfirm.value = true;
}

async function confirmDelete(): Promise<void> {
  if (props.id == null) return;
  deleting.value = true;
  try {
    await sendJson(`/api/commands/${props.id}`, "DELETE");
    showDeleteConfirm.value = false;
    await router.replace({ name: "commands" });
  } catch {
    /* ignore — keep the dialog open so the user can retry or cancel */
  } finally {
    deleting.value = false;
  }
}

watch(
  () => [props.id, props.isNew],
  () => void loadCommand(),
);
onMounted(async () => {
  await ensureProfiles();
  await loadCommand();
});
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="ghost" size="sm" icon="back" @click="router.back()">Back</Button>
      <Button
        v-if="editing"
        variant="ghost"
        size="sm"
        icon="refresh"
        :loading="loading"
        @click="loadCommand"
      >
        <span class="btn-label">Refresh</span>
      </Button>
    </template>

    <div v-if="loading" class="loading-row">Loading…</div>

    <div v-else class="cmd-layout">
      <!-- Form -->
      <div class="form-col">
        <Card :title="editing ? 'Edit command' : 'New command'">
          <div v-if="errorMsg" class="banner err">{{ errorMsg }}</div>

          <Field label="Trigger word" hint="What users type. Stored without the leading slash.">
            <input v-model="form.trigger" class="ctrl mono" type="text" placeholder="question" />
          </Field>
          <Field label="Description" hint="Shown in the command list.">
            <input v-model="form.description" class="ctrl" type="text" placeholder="What this command does." />
          </Field>
          <Field label="Profile" hint="Which model the command runs on.">
            <Select v-model="form.profile" :options="profileOptions" />
          </Field>
          <Field label="System prompt / instructions" hint="The custom instructions the agent wakes up with.">
            <textarea
              v-model="form.system_prompt"
              class="ctrl mono"
              rows="8"
              placeholder="e.g. You answer questions about this repository. Read the relevant code, then post a clear answer as a comment. Do not edit files."
            />
          </Field>

          <!-- Custom labels: toggle + 3 name/color fields (pre-filled with the
               global defaults). When on, this command's runs use these labels
               instead of the global ones. -->
          <div class="custom-labels">
            <div class="cl-head">
              <button
                type="button"
                class="toggle"
                :class="{ on: useCustomLabels }"
                :aria-pressed="useCustomLabels"
                @click="useCustomLabels = !useCustomLabels"
              >
                <span class="toggle-knob"></span>
              </button>
              <span class="cl-title">Custom labels</span>
            </div>
            <p class="cl-hint">
              When on, this command uses its own labels instead of the global
              defaults (Settings → GitHub labels). All three are pre-filled — edit
              only what you want to change.
            </p>
            <div v-if="useCustomLabels" class="cl-rows">
              <LabelEditor v-model="labelFields" />
            </div>
          </div>

        </Card>

        <div class="actions">
          <Button variant="primary" icon="check" :loading="saving" @click="save">
            {{ editing ? "Save changes" : "Create command" }}
          </Button>
          <template v-if="editing">
            <Button variant="secondary" @click="toggleEnabled">
              {{ form.enabled ? "Disable" : "Enable" }}
            </Button>
            <Button v-if="!isBuiltin" variant="danger" icon="trash" @click="deleteCommand">Delete</Button>
          </template>
        </div>
      </div>

      <!-- Sidebar: trigger preview -->
      <aside class="side-col">
        <Card title="Trigger preview">
          <div class="preview">
            <Icon name="message" :size="16" />
            <span class="preview-trigger mono">{{ triggerPreview }}</span>
          </div>
          <p class="hint-text">
            Typing <code class="inline mono">{{ triggerPreview }}</code> in a GitHub issue or comment
            will wake the agent with your instructions above.
          </p>
        </Card>

        <Card title="Template tags">
          <p class="tag-intro">Tags in the system prompt are replaced with live data at run time.</p>
          <div class="tag-list">
            <div class="tag-row"><code class="inline mono">{system}</code> — Full system info block (CPU, RAM, platform, tier).</div>
            <div class="tag-row"><code class="inline mono">{system.cpu}</code> — CPU core count.</div>
            <div class="tag-row"><code class="inline mono">{system.ram}</code> — Total, free, and limit memory (MB).</div>
            <div class="tag-row"><code class="inline mono">{system.tier}</code> — constrained or capable.</div>
            <div class="tag-row"><code class="inline mono">{pr.[n]}</code> — nth open PR (0-indexed): number, title, branches, URL.</div>
            <div class="tag-row"><code class="inline mono">{issue.[n]}</code> — nth open issue (0-indexed): number, title, labels, URL.</div>
          </div>
        </Card>
      </aside>

      <!-- Mobile-only duplicate action row -->
      <div class="actions actions-mobile">
        <Button variant="primary" icon="check" :loading="saving" @click="save">
          {{ editing ? "Save changes" : "Create command" }}
        </Button>
        <template v-if="editing">
          <Button variant="secondary" @click="toggleEnabled">
            {{ form.enabled ? "Disable" : "Enable" }}
          </Button>
          <Button v-if="!isBuiltin" variant="danger" icon="trash" @click="deleteCommand">Delete</Button>
        </template>
      </div>
    </div>

    <ConfirmDialog
      v-model:open="showDeleteConfirm"
      title="Delete this command?"
      message="The command and its trigger will be removed. This can't be undone."
      confirm-label="Delete"
      danger
      :loading="deleting"
      @confirm="confirmDelete"
    />
  </AppShell>
</template>

<style scoped>
.loading-row {
  padding: var(--space-12);
  text-align: center;
  color: var(--text-3);
  font-size: var(--text-sm);
}
.cmd-layout {
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: var(--space-5);
  align-items: start;
}
.side-col {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  position: sticky;
  top: 60px;
}
.banner {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  margin-bottom: var(--space-4);
  background: var(--danger-weak);
  color: var(--danger);
}
.actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-4);
}
/* Mobile-only duplicate action row — hidden on desktop, shown via the 640px
 * media query below. */
.actions-mobile {
  display: none;
}

/* Custom-labels block (toggle + 3 name/color rows). */
.custom-labels {
  margin-top: var(--space-4);
  padding: var(--space-4);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.cl-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.cl-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text);
}
.cl-hint {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  color: var(--text-3);
  line-height: var(--leading-normal);
}
.cl-rows {
  margin-top: var(--space-3);
}
/* The 3-row label editor is rendered by the shared <LabelEditor> component. */

/* Toggle switch (reuses the Settings page styling). */
.toggle {
  position: relative;
  width: 38px;
  height: 22px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border);
  background: var(--surface-3);
  padding: 0;
  cursor: pointer;
  flex: 0 0 auto;
}
.toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--text-2);
  transition: transform var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.toggle.on {
  background: var(--accent);
  border-color: var(--accent);
}
.toggle.on .toggle-knob {
  transform: translateX(16px);
  background: #000;
}

.preview {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  margin-bottom: var(--space-2);
}
.preview :deep(svg) {
  color: var(--accent);
}
.preview-trigger {
  font-family: var(--font-mono);
  background: var(--surface-4);
  color: var(--text-2);
  padding: 2px 7px;
  border-radius: var(--radius-sm);
}
.hint-text {
  font-size: var(--text-xs);
  color: var(--text-3);
  margin: var(--space-2) 0 0;
  line-height: 1.5;
}
.hint-text code.inline {
  font-family: var(--font-mono);
  background: var(--surface-4);
  color: var(--text-2);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
}
.tag-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.tag-row {
  font-size: var(--text-xs);
  color: var(--text-3);
  line-height: 1.5;
}
.tag-row code {
  background: none;
  color: var(--text-1);
  padding: 0;
  border-radius: 0;
}
.tag-intro {
  font-size: var(--text-sm);
  color: var(--text-2);
  margin-bottom: var(--space-3);
}
.muted-note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  color: var(--text-3);
}
.muted-note :deep(svg) {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--text-3);
}

@media (max-width: 900px) {
  .cmd-layout {
    grid-template-columns: 1fr;
  }
  .side-col {
    position: static;
  }
}
@media (max-width: 640px) {
  /* Hide the in-form actions on mobile; a duplicate centered block renders
   * after the sidebar so buttons are always the last thing on the page. */
  .form-col > .actions {
    display: none;
  }
  .actions-mobile {
    display: flex;
    justify-content: center;
    margin-top: var(--space-2);
  }
}
</style>
