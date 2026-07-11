<script setup lang="ts">
/**
 * Command create/edit form. Two columns: the form fields on the left, a context
 * sidebar on the right (trigger preview). Save creates or updates; after a
 * create we navigate to the edit route so a subsequent save updates.
 *
 * MOCK ONLY: backed by src/lib/mock.ts. Swap the mockXxx calls to sendJson /
 * getJson against /api/commands to migrate. No "Run now" — execution isn't
 * wired yet.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getJson } from "../api/client.js";
import {
  mockGetCommand,
  mockCreateCommand,
  mockUpdateCommand,
  mockDeleteCommand,
} from "../lib/mock.js";
import type {
  CommandMutationResponse,
  ProfilesResponse,
  CommandInput,
} from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Field from "../components/ui/Field.vue";
import Icon from "../components/ui/Icon.vue";

const props = defineProps<{ id?: string; isNew?: boolean }>();
const router = useRouter();

const form = ref({
  trigger: "",
  name: "",
  description: "",
  system_prompt: "",
  profile: "",
  enabled: 1,
});
const profiles = ref<string[]>([]);
const defaultProfile = ref("");
const saving = ref(false);
const errorMsg = ref("");
const loading = ref(false);

const editing = computed(() => !props.isNew && props.id != null);
/** Trigger shown as it would appear in a GitHub issue. */
const triggerPreview = computed(() => "/" + (form.value.trigger || "command"));

function emptyForm() {
  return {
    trigger: "",
    name: "",
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
    return;
  }
  loading.value = true;
  try {
    const body = await mockGetCommand(Number(props.id));
    const c = body.command;
    form.value = {
      trigger: c.trigger,
      name: c.name,
      description: c.description,
      system_prompt: c.system_prompt,
      profile: c.profile ?? "",
      enabled: c.enabled,
    };
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : "Could not load command.";
  } finally {
    loading.value = false;
  }
}

function payload(): CommandInput {
  return {
    trigger: form.value.trigger.trim(),
    name: form.value.name.trim(),
    description: form.value.description.trim(),
    system_prompt: form.value.system_prompt,
    profile: form.value.profile || null,
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
      await mockUpdateCommand(Number(props.id), payload());
      await loadCommand();
    } else {
      const body: CommandMutationResponse = await mockCreateCommand(payload());
      await router.replace({ name: "command-detail", params: { id: String(body.command.id) } });
    }
  } catch (e) {
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

async function deleteCommand(): Promise<void> {
  if (!editing.value || props.id == null) return;
  if (!confirm("Delete this command?")) return;
  try {
    await mockDeleteCommand(Number(props.id));
    await router.replace({ name: "commands" });
  } catch {
    /* ignore */
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
        Refresh
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
          <Field label="Name">
            <input v-model="form.name" class="ctrl" type="text" placeholder="e.g. Answer a question" />
          </Field>
          <Field label="Description" hint="Shown in the command list.">
            <input v-model="form.description" class="ctrl" type="text" placeholder="What this command does." />
          </Field>
          <Field label="Profile" hint="Which model the command runs on.">
            <select v-model="form.profile" class="ctrl">
              <option value="">Default</option>
              <option v-for="p in profiles" :key="p" :value="p">
                {{ p }}{{ p === defaultProfile ? " (default)" : "" }}
              </option>
            </select>
          </Field>
          <Field label="System prompt / instructions" hint="The custom instructions the agent wakes up with.">
            <textarea
              v-model="form.system_prompt"
              class="ctrl mono"
              rows="8"
              placeholder="e.g. You answer questions about this repository. Read the relevant code, then post a clear answer as a comment. Do not edit files."
            />
          </Field>

          <div class="actions">
            <Button variant="primary" icon="check" :loading="saving" @click="save">
              {{ editing ? "Save changes" : "Create command" }}
            </Button>
            <template v-if="editing">
              <Button variant="secondary" @click="toggleEnabled">
                {{ form.enabled ? "Disable" : "Enable" }}
              </Button>
              <Button variant="danger" icon="trash" @click="deleteCommand">Delete</Button>
            </template>
          </div>
        </Card>
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
          <p class="hint-text muted-note">
            <Icon name="alert" :size="13" />
            Execution isn't wired up yet — this page is a preview of the shape.
          </p>
        </Card>
      </aside>
    </div>
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
  top: var(--space-6);
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
</style>
