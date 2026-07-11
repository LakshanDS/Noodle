<script setup lang="ts">
/**
 * Skill create/edit form. Two columns: the form on the left, a SKILL.md preview
 * on the right (so the user sees exactly the file format that gets written
 * later). Skills are keyed by name (the folder identifier), like profiles.
 *
 * MOCK ONLY: backed by src/lib/mock.ts. Swap the mockXxx calls to getJson /
 * sendJson against /api/skills to migrate.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import {
  mockGetSkill,
  mockCreateSkill,
  mockUpdateSkill,
  mockDeleteSkill,
} from "../lib/mock.js";
import type {
  SkillMutationResponse,
  SkillInput,
} from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Field from "../components/ui/Field.vue";

const props = defineProps<{ name?: string; isNew?: boolean }>();
const router = useRouter();

const form = ref({
  name: "",
  description: "",
  body: "",
});
const source = ref<"bundled" | "custom">("custom");
const saving = ref(false);
const errorMsg = ref("");
const loading = ref(false);

const editing = computed(() => !props.isNew && props.name != null);
const isBundled = computed(() => source.value === "bundled");
/** Rendered SKILL.md: YAML frontmatter + the body the user typed. */
const skillMd = computed(
  () =>
    "---\n" +
    `name: ${form.value.name || "skill-name"}\n` +
    `description: ${form.value.description || "…"}\n` +
    "---\n\n" +
    (form.value.body || "# Your instructions"),
);

function emptyForm() {
  return { name: "", description: "", body: "" };
}

async function loadSkill(): Promise<void> {
  if (!editing.value || props.name == null) {
    form.value = emptyForm();
    source.value = "custom";
    return;
  }
  loading.value = true;
  try {
    const body = await mockGetSkill(props.name);
    const s = body.skill;
    form.value = {
      name: s.name,
      description: s.description,
      body: s.body,
    };
    source.value = s.source;
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : "Could not load skill.";
  } finally {
    loading.value = false;
  }
}

function payload(): SkillInput {
  return {
    name: form.value.name.trim(),
    description: form.value.description.trim(),
    body: form.value.body,
  };
}

async function save(): Promise<void> {
  errorMsg.value = "";
  if (!form.value.name.trim()) {
    errorMsg.value = "Name is required.";
    return;
  }
  saving.value = true;
  try {
    if (editing.value && props.name != null) {
      // Bundled skills keep their name; only description/body are editable.
      const patch = isBundled.value
        ? { description: form.value.description.trim(), body: form.value.body }
        : payload();
      await mockUpdateSkill(props.name, patch);
      await loadSkill();
    } else {
      const body: SkillMutationResponse = await mockCreateSkill(payload());
      await router.replace({ name: "skill-detail", params: { name: body.skill.name } });
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : "Could not reach server";
  } finally {
    saving.value = false;
  }
}

async function deleteSkill(): Promise<void> {
  if (!editing.value || props.name == null) return;
  if (!confirm("Delete this skill?")) return;
  try {
    await mockDeleteSkill(props.name);
    await router.replace({ name: "skills" });
  } catch {
    /* ignore */
  }
}

watch(
  () => [props.name, props.isNew],
  () => void loadSkill(),
);
onMounted(loadSkill);
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
        @click="loadSkill"
      >
        Refresh
      </Button>
    </template>

    <div v-if="loading" class="loading-row">Loading…</div>

    <div v-else class="skill-layout">
      <!-- Form -->
      <div class="form-col">
        <Card :title="editing ? 'Edit skill' : 'New skill'">
          <div v-if="errorMsg" class="banner err">{{ errorMsg }}</div>

          <Field label="Name" hint="The folder identifier, e.g. noodle-question. Cannot change for bundled skills.">
            <input
              v-model="form.name"
              class="ctrl mono"
              type="text"
              placeholder="noodle-question"
              :disabled="isBundled"
            />
          </Field>
          <Field label="Description" hint="Shown in the list and used by the agent to decide when to load the skill.">
            <input v-model="form.description" class="ctrl" type="text" placeholder="What this skill teaches." />
          </Field>
          <Field label="Instructions" hint="The SKILL.md markdown body the agent reads when it loads this skill.">
            <textarea
              v-model="form.body"
              class="ctrl mono"
              rows="12"
              placeholder="# Your skill&#10;&#10;Step-by-step instructions the agent follows…"
            />
          </Field>

          <div class="actions">
            <Button variant="primary" icon="check" :loading="saving" @click="save">
              {{ editing ? "Save changes" : "Create skill" }}
            </Button>
            <template v-if="editing">
              <Button variant="danger" icon="trash" @click="deleteSkill">Delete</Button>
            </template>
          </div>
        </Card>
      </div>

      <!-- Sidebar: SKILL.md preview -->
      <aside class="side-col">
        <Card title="SKILL.md preview">
          <p class="hint-text">
            This is the file that gets written to <code class="inline mono">skills/&lt;name&gt;/SKILL.md</code>
            and loaded by the agent.
          </p>
          <pre class="md-preview mono">{{ skillMd }}</pre>
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
.skill-layout {
  display: grid;
  grid-template-columns: 1fr 340px;
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

.hint-text {
  font-size: var(--text-xs);
  color: var(--text-3);
  margin: 0 0 var(--space-3);
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
.md-preview {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-2);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  overflow-x: auto;
  white-space: pre-wrap;
  line-height: 1.55;
  margin: 0;
}

@media (max-width: 900px) {
  .skill-layout {
    grid-template-columns: 1fr;
  }
  .side-col {
    position: static;
  }
}
</style>
