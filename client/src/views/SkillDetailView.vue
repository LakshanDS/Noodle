<script setup lang="ts">
/**
 * Skill create/edit form. Two columns: the form on the left, a SKILL.md preview
 * on the right (so the user sees exactly the file format that gets written
 * later). Skills are keyed by name (the folder identifier), like profiles.
 *
 * Reads/writes skills/<name>/SKILL.md on disk via /api/skills.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getJson, sendJson } from "../api/client.js";
import { isAuthError } from "../api/client.js";
import type {
  SkillDetailResponse,
  SkillMutationResponse,
  SkillInput,
} from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import ConfirmDialog from "../components/ui/ConfirmDialog.vue";
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
const showDeleteConfirm = ref(false);
const deleting = ref(false);

const editing = computed(() => !props.isNew && props.name != null);
const isBundled = computed(() => source.value === "bundled");

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
    const body = await getJson<SkillDetailResponse>(`/api/skills/${encodeURIComponent(props.name)}`);
    const s = body.skill;
    form.value = {
      name: s.name,
      description: s.description,
      body: s.body,
    };
    source.value = s.source;
  } catch (e) {
    if (isAuthError(e)) return;
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
      await sendJson<SkillMutationResponse>(`/api/skills/${encodeURIComponent(props.name)}`, "PATCH", patch);
      await loadSkill();
    } else {
      const body: SkillMutationResponse = await sendJson<SkillMutationResponse>("/api/skills", "POST", payload());
      await router.replace({ name: "skill-detail", params: { name: body.skill.name } });
    }
  } catch (e) {
    if (isAuthError(e)) return;
    errorMsg.value = e instanceof Error ? e.message : "Could not reach server";
  } finally {
    saving.value = false;
  }
}

function deleteSkill(): void {
  if (!editing.value || props.name == null) return;
  showDeleteConfirm.value = true;
}

async function confirmDeleteSkill(): Promise<void> {
  if (props.name == null) return;
  deleting.value = true;
  try {
    await sendJson(`/api/skills/${encodeURIComponent(props.name)}`, "DELETE");
    showDeleteConfirm.value = false;
    await router.replace({ name: "skills" });
  } catch {
    /* ignore — keep the dialog open so the user can retry or cancel */
  } finally {
    deleting.value = false;
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
        <span class="btn-label">Refresh</span>
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

        </Card>

        <div class="actions">
          <Button variant="primary" icon="check" :loading="saving" @click="save">
            {{ editing ? "Save changes" : "Create skill" }}
          </Button>
          <template v-if="editing">
            <Button variant="danger" icon="trash" @click="deleteSkill">Delete</Button>
          </template>
        </div>
      </div>

      <!-- Sidebar: guidance on the fields + how the skill system works -->
      <aside class="side-col">
        <Card title="Instructions">
          <p class="hint-text">
            <strong>Name</strong> is the skill folder identifier (e.g. <code class="inline mono">noodle-fix</code>).
            Lowercase letters, digits, and hyphens only — it becomes a folder under <code class="inline mono">skills/</code>.
          </p>
          <p class="hint-text">
            <strong>Description</strong> tells the agent <em>when</em> to load this skill. Keep it short and
            about the trigger condition ("Use when asked to review code"), not the contents.
          </p>
          <p class="hint-text">
            <strong>Instructions</strong> is the markdown the agent reads once the skill is loaded — the
            steps, rules, or mindset it should apply. This is the body of the <code class="inline mono">SKILL.md</code>.
          </p>
        </Card>

        <Card title="How it works">
          <p class="hint-text">
            Every skill lives at <code class="inline mono">skills/&lt;name&gt;/SKILL.md</code> as a single file with
            YAML frontmatter (name + description) and a markdown body.
          </p>
          <p class="hint-text">
            The agent picks up skills automatically: before each run, Noodle copies the
            <code class="inline mono">skills/</code> folder into the workspace, and the agent discovers them by
            scanning the directory. Edits you make here take effect on the next run — no restart needed.
          </p>
          <p class="hint-text">
            The agent decides which skill to load from the <strong>description</strong> field against the current
            task. Multiple skills can be active at once (e.g. <code class="inline mono">noodle-default</code> pairs
            with every task skill).
          </p>
        </Card>
      </aside>

      <!-- Mobile-only duplicate action row -->
      <div class="actions actions-mobile">
        <Button variant="primary" icon="check" :loading="saving" @click="save">
          {{ editing ? "Save changes" : "Create skill" }}
        </Button>
        <template v-if="editing">
          <Button variant="danger" icon="trash" @click="deleteSkill">Delete</Button>
        </template>
      </div>
    </div>

    <ConfirmDialog
      v-model:open="showDeleteConfirm"
      title="Delete this skill?"
      message="The skill folder and its SKILL.md will be removed. This can't be undone."
      confirm-label="Delete"
      danger
      :loading="deleting"
      @confirm="confirmDeleteSkill"
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

@media (max-width: 900px) {
  .skill-layout {
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
