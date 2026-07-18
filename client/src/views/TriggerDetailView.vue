<script setup lang="ts">
/**
 * Trigger create/edit form. Two columns: the form fields on the left, a context
 * sidebar on the right (event preview + recent-run history when editing).
 * Save creates (POST) or updates (PATCH); after a create we navigate to the
 * edit route so a subsequent save PATCHes.
 */
import { computed, onMounted, ref, watch, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { getJson, sendJson, ApiRequestError, isAuthError } from "../api/client.js";
import type {
  TriggerDetailResponse,
  TriggerMutationResponse,
  ProfilesResponse,
  TriggerInput,
  RunRow as RunRowData,
  ReposResponse,
  RepoData,
} from "../api/types.js";
import { fmtTime, repoLeaf } from "../lib/format.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import ConfirmDialog from "../components/ui/ConfirmDialog.vue";
import Field from "../components/ui/Field.vue";
import StatusPill from "../components/ui/StatusPill.vue";
import Icon from "../components/ui/Icon.vue";
import LabelEditor from "../components/LabelEditor.vue";
import type { LabelField } from "../components/LabelEditor.vue";
import Select from "../components/ui/Select.vue";
import type { SelectOption } from "../components/ui/Select.vue";

const props = defineProps<{ id?: string; isNew?: boolean }>();
const router = useRouter();

const EVENT_TYPES: SelectOption[] = [
  { value: "issues", label: "Issues" },
  { value: "pull_request", label: "Pull Requests" },
  { value: "push", label: "Push" },
  { value: "issue_comment", label: "Issue Comments" },
];

const EVENT_ACTIONS: Record<string, SelectOption[]> = {
  issues: [
    { value: "", label: "Any action" },
    { value: "opened", label: "opened" },
    { value: "closed", label: "closed" },
    { value: "reopened", label: "reopened" },
    { value: "labeled", label: "labeled" },
    { value: "assigned", label: "assigned" },
    { value: "edited", label: "edited" },
  ],
  pull_request: [
    { value: "", label: "Any action" },
    { value: "opened", label: "opened" },
    { value: "closed", label: "closed" },
    { value: "reopened", label: "reopened" },
    { value: "synchronize", label: "synchronize" },
    { value: "labeled", label: "labeled" },
    { value: "assigned", label: "assigned" },
    { value: "review_requested", label: "review_requested" },
  ],
  push: [],
  issue_comment: [
    { value: "", label: "Any action" },
    { value: "created", label: "created" },
    { value: "edited", label: "edited" },
    { value: "deleted", label: "deleted" },
  ],
};

const form = ref({
  name: "",
  repo: "",
  event_type: "issues",
  event_action: "",
  branch_pattern: "",
  profile: "",
  prompt: "",
  branch_name: "noodle/trigger",
  enabled: 1,
});
const profiles = ref<string[]>([]);
const defaultProfile = ref("");
const runs = ref<RunRowData[]>([]);
const saving = ref(false);
const runState = ref<"idle" | "queueing" | "queued" | "error">("idle");
const errorMsg = ref("");
const loading = ref(false);
const showDeleteConfirm = ref(false);
const deleting = ref(false);
const repos = ref<RepoData[]>([]);

// Custom-labels toggle + 3 label fields. When off, the trigger uses the global
// default labels (Settings → GitHub labels). When on, these 3 override them.
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

const editing = computed(() => !props.isNew && props.id != null);
const profileOptions = computed<SelectOption[]>(() => [
  { value: "", label: "Default" },
  ...profiles.value.map((p) => ({
    value: p,
    label: p + (p === defaultProfile.value ? " (default)" : ""),
  })),
]);
const eventTypeOptions = computed(() => EVENT_TYPES);
const eventActionOptions = computed(() => EVENT_ACTIONS[form.value.event_type] ?? []);
const showBranchPattern = computed(() => form.value.event_type === "push");
const showEventAction = computed(() => (EVENT_ACTIONS[form.value.event_type] ?? []).length > 0);

const eventPreview = computed(() => {
  const type = form.value.event_type;
  const action = form.value.event_action;
  if (action) return `${type}.${action}`;
  return type;
});

function emptyForm() {
  useCustomLabels.value = false;
  labelFields.value = [
    { ...DEFAULT_LABELS.cooking },
    { ...DEFAULT_LABELS.cooked },
    { ...DEFAULT_LABELS.failed },
  ];
  return {
    name: "",
    repo: "",
    event_type: "issues",
    event_action: "",
    branch_pattern: "",
    profile: "",
    prompt: "",
    branch_name: "noodle/trigger",
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

async function loadTrigger(): Promise<void> {
  if (!editing.value || props.id == null) {
    form.value = emptyForm();
    return;
  }
  loading.value = true;
  try {
    const body = await getJson<TriggerDetailResponse>(`/api/triggers/${encodeURIComponent(props.id)}`);
    const t = body.trigger;
    form.value = {
      name: t.name,
      repo: t.repo,
      event_type: t.event_type,
      event_action: t.event_action ?? "",
      branch_pattern: t.branch_pattern ?? "",
      profile: t.profile ?? "",
      prompt: t.prompt,
      branch_name: t.branch_name,
      enabled: t.enabled,
    };
    // Parse the trigger's custom labels. If set, populate the 3 fields + turn the
    // toggle on. If null, leave the toggle off and fields at the global defaults.
    let parsed: typeof DEFAULT_LABELS | null = null;
    if (t.label) {
      try { parsed = JSON.parse(t.label) as typeof DEFAULT_LABELS; } catch { /* ignore */ }
    }
    if (parsed) {
      useCustomLabels.value = true;
      labelFields.value = [
        { name: parsed.cooking?.name ?? DEFAULT_LABELS.cooking.name, color: parsed.cooking?.color ?? DEFAULT_LABELS.cooking.color },
        { name: parsed.cooked?.name ?? DEFAULT_LABELS.cooked.name, color: parsed.cooked?.color ?? DEFAULT_LABELS.cooked.color },
        { name: parsed.failed?.name ?? DEFAULT_LABELS.failed.name, color: parsed.failed?.color ?? DEFAULT_LABELS.failed.color },
      ];
    } else {
      useCustomLabels.value = false;
      labelFields.value = [
        { ...DEFAULT_LABELS.cooking },
        { ...DEFAULT_LABELS.cooked },
        { ...DEFAULT_LABELS.failed },
      ];
    }
    runs.value = body.runs ?? [];
  } catch (e) {
    if (isAuthError(e)) return;
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Could not load trigger.";
  } finally {
    loading.value = false;
  }
}

function payload(): TriggerInput {
  const [cooking, cooked, failed] = labelFields.value;
  return {
    name: form.value.name.trim(),
    repo: form.value.repo.trim(),
    event_type: form.value.event_type,
    event_action: form.value.event_action || null,
    branch_pattern: form.value.branch_pattern || null,
    profile: form.value.profile || null,
    prompt: form.value.prompt,
    branch_name: form.value.branch_name.trim(),
    label: useCustomLabels.value
      ? JSON.stringify({ cooking: { name: cooking.name, color: cooking.color }, cooked: { name: cooked.name, color: cooked.color }, failed: { name: failed.name, color: failed.color } })
      : null,
  };
}

async function save(): Promise<void> {
  errorMsg.value = "";
  saving.value = true;
  try {
    if (editing.value && props.id != null) {
      await sendJson<TriggerMutationResponse>(`/api/triggers/${encodeURIComponent(props.id)}`, "PATCH", payload());
      await loadTrigger();
    } else {
      const body = await sendJson<TriggerMutationResponse>("/api/triggers", "POST", payload());
      await router.replace({ name: "trigger-detail", params: { id: String(body.trigger.id) } });
    }
  } catch (e) {
    if (isAuthError(e)) return;
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Could not reach server";
  } finally {
    saving.value = false;
  }
}

async function runNow(): Promise<void> {
  if (!editing.value || props.id == null) return;
  runState.value = "queueing";
  try {
    await sendJson(`/api/triggers/${encodeURIComponent(props.id)}/run`, "POST");
    runState.value = "queued";
    setTimeout(() => (runState.value = "idle"), 2000);
  } catch (e) {
    if (isAuthError(e)) return;
    runState.value = "error";
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Failed";
  }
}

async function toggleEnabled(): Promise<void> {
  if (!editing.value || props.id == null) return;
  const enable = form.value.enabled === 0;
  try {
    await sendJson<TriggerMutationResponse>(`/api/triggers/${encodeURIComponent(props.id)}`, "PATCH", { enabled: enable ? 1 : 0 });
    form.value.enabled = enable ? 1 : 0;
  } catch {
    /* ignore */
  }
}

function deleteTrigger(): void {
  if (!editing.value || props.id == null) return;
  showDeleteConfirm.value = true;
}

async function confirmDeleteTrigger(): Promise<void> {
  if (props.id == null) return;
  deleting.value = true;
  try {
    await sendJson(`/api/triggers/${encodeURIComponent(props.id)}`, "DELETE");
    showDeleteConfirm.value = false;
    await router.replace({ name: "triggers" });
  } catch {
    /* ignore */
  } finally {
    deleting.value = false;
  }
}

function openRun(jobId: string): void {
  void router.push({ name: "run-detail", params: { id: jobId } });
}

/** Load repos for autocomplete. */
async function loadRepos(): Promise<void> {
  try {
    const body = await getJson<ReposResponse>("/api/github/repos");
    repos.value = body.repos ?? [];
  } catch {
    repos.value = [];
  }
}

const repoDropdown = ref(false);
const repoHighlight = ref(-1);
const repoWrapper = ref<HTMLElement | null>(null);

const filteredRepos = computed(() => {
  const q = form.value.repo.trim().toLowerCase();
  if (!q) return repos.value.slice(0, 50);
  return repos.value.filter((r) => r.full_name.toLowerCase().includes(q)).slice(0, 50);
});

function pickRepo(fullName: string): void {
  form.value.repo = fullName;
  repoDropdown.value = false;
}

function onRepoKeydown(e: KeyboardEvent): void {
  const items = filteredRepos.value;
  if (!items.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    repoHighlight.value = (repoHighlight.value + 1) % items.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    repoHighlight.value = (repoHighlight.value - 1 + items.length) % items.length;
  } else if (e.key === "Enter" && repoHighlight.value >= 0) {
    e.preventDefault();
    pickRepo(items[repoHighlight.value].full_name);
  } else if (e.key === "Escape") {
    repoDropdown.value = false;
  }
}

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (repoWrapper.value && !repoWrapper.value.contains(target)) repoDropdown.value = false;
}

onMounted(() => document.addEventListener("mousedown", onDocClick));
onUnmounted(() => {
  document.removeEventListener("mousedown", onDocClick);
  repoDropdown.value = false;
});

watch(
  () => [props.id, props.isNew],
  () => void loadTrigger(),
);
onMounted(async () => {
  await ensureProfiles();
  await loadTrigger();
  void loadRepos();
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
        @click="loadTrigger"
      >
        <span class="btn-label">Refresh</span>
      </Button>
    </template>

    <div v-if="loading" class="loading-row">Loading…</div>

    <div v-else class="trigger-layout">
      <!-- Form -->
      <div class="form-col">
        <Card :title="editing ? 'Edit trigger' : 'New trigger'">
          <div v-if="errorMsg" class="banner err">{{ errorMsg }}</div>

          <Field label="Name">
            <input v-model="form.name" class="ctrl" type="text" placeholder="e.g. PR review bot" />
          </Field>

          <!-- Repository + Agent branch in one row -->
          <div class="repo-row">
            <Field label="Repository" class="repo-field">
              <div ref="repoWrapper" class="autocomplete">
                <input
                  v-model="form.repo"
                  class="ctrl mono"
                  type="text"
                  placeholder="owner/name"
                  autocomplete="off"
                  @focus="repoDropdown = true; repoHighlight = -1"
                  @keydown="onRepoKeydown"
                />
                <ul v-if="repoDropdown && filteredRepos.length" class="ac-list">
                  <li
                    v-for="(r, i) in filteredRepos"
                    :key="r.full_name"
                    class="ac-item"
                    :class="{ active: i === repoHighlight }"
                    @mousedown.prevent="pickRepo(r.full_name)"
                  >
                    <span class="ac-repo mono">{{ r.full_name }}</span>
                  </li>
                </ul>
              </div>
            </Field>
            <Field label="Agent branch">
              <input v-model="form.branch_name" class="ctrl mono" type="text" placeholder="noodle/trigger" />
            </Field>
          </div>

          <!-- Event type + action row -->
          <div class="event-row">
            <div class="ev-field">
              <Field label="Event type">
                <Select v-model="form.event_type" :options="eventTypeOptions" />
              </Field>
            </div>
            <div v-if="showEventAction" class="ev-field">
              <Field label="Action">
                <Select v-model="form.event_action" :options="eventActionOptions" />
              </Field>
            </div>
          </div>

          <Field v-if="showBranchPattern" label="Branch pattern" hint="Optional. e.g. main, feature/*. Leave empty to match all branches.">
            <input v-model="form.branch_pattern" class="ctrl mono" type="text" placeholder="e.g. main" />
          </Field>

          <Field label="Profile" hint="Which model the trigger runs on.">
            <Select v-model="form.profile" :options="profileOptions" />
          </Field>

          <Field label="Prompt / Instructions" hint="The custom instructions the agent wakes up with.">
            <textarea v-model="form.prompt" class="ctrl" rows="8" placeholder="e.g. Review the PR and provide feedback on code quality." />
          </Field>

          <!-- Custom labels: toggle + 3 name/color fields (pre-filled with the
               global defaults). When on, this trigger's runs use these labels
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
              When on, this trigger uses its own labels instead of the global
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
            {{ editing ? "Save changes" : "Create trigger" }}
          </Button>
          <template v-if="editing">
            <Button variant="secondary" icon="play" :loading="runState === 'queueing'" @click="runNow">
              {{ runState === "queueing" ? "Queuing…" : runState === "queued" ? "Queued ✓" : runState === "error" ? "Failed" : "Run now" }}
            </Button>
            <Button variant="secondary" @click="toggleEnabled">
              {{ form.enabled ? "Disable" : "Enable" }}
            </Button>
            <Button variant="danger" icon="trash" @click="deleteTrigger">Delete</Button>
          </template>
        </div>
      </div>

      <!-- Sidebar -->
      <aside class="side-col">
        <Card title="Event preview">
          <div class="preview">
            <Icon name="zap" :size="16" />
            <span><code class="inline mono">{{ eventPreview }}</code></span>
          </div>
          <p class="hint-text">
            When a <code class="inline mono">{{ eventPreview }}</code> event fires on
            <code class="inline mono">{{ form.repo || "owner/name" }}</code>,
            Noodle clones the repo, checks out the
            <code class="inline mono">{{ form.branch_name || "branch" }}</code> branch,
            runs the agent with your prompt, and commits + pushes.
          </p>
          <p class="hint-text">
            Runs on the <code class="inline mono">{{ form.profile || "default" }}</code> profile.
          </p>
        </Card>

        <Card v-if="editing && runs.length > 0" title="Recent runs" pad="flush">
          <div class="history">
            <button v-for="r in runs" :key="r.job_id" class="history-row" @click="openRun(r.job_id)">
              <StatusPill :status="r.status" />
              <span class="h-repo">{{ repoLeaf(r.repo) }}</span>
              <span class="h-time">{{ fmtTime(r.started_at) }}</span>
            </button>
          </div>
        </Card>

        <Card title="Supported events">
          <div class="tag-list">
            <div class="tag-row"><code class="inline mono">issues</code> — opened, closed, reopened, labeled, assigned, edited</div>
            <div class="tag-row"><code class="inline mono">pull_request</code> — opened, closed, reopened, synchronize, labeled, assigned, review_requested</div>
            <div class="tag-row"><code class="inline mono">push</code> — any push (filter by branch pattern)</div>
            <div class="tag-row"><code class="inline mono">issue_comment</code> — created, edited, deleted</div>
          </div>
        </Card>
      </aside>

      <!-- Mobile-only duplicate action row -->
      <div class="actions actions-mobile">
        <Button variant="primary" icon="check" :loading="saving" @click="save">
          {{ editing ? "Save changes" : "Create trigger" }}
        </Button>
        <template v-if="editing">
          <Button variant="secondary" icon="play" :loading="runState === 'queueing'" @click="runNow">
            {{ runState === "queueing" ? "Queuing…" : runState === "queued" ? "Queued ✓" : runState === "error" ? "Failed" : "Run now" }}
          </Button>
          <Button variant="secondary" @click="toggleEnabled">
            {{ form.enabled ? "Disable" : "Enable" }}
          </Button>
          <Button variant="danger" icon="trash" @click="deleteTrigger">Delete</Button>
        </template>
      </div>
    </div>

    <ConfirmDialog
      v-model:open="showDeleteConfirm"
      title="Delete this trigger?"
      message="The trigger is removed but its run history is kept. This can't be undone."
      confirm-label="Delete"
      danger
      :loading="deleting"
      @confirm="confirmDeleteTrigger"
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
.event-row,
.repo-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.ev-field,
.repo-field {
  display: flex;
  flex-direction: column;
}
.repo-field {
  position: relative;
}
.autocomplete {
  position: relative;
  width: 100%;
}
.ac-list {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  z-index: 30;
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
}
.ac-item {
  display: flex;
  align-items: center;
  padding: 8px var(--space-3);
  cursor: pointer;
  border-radius: 0;
  transition: background var(--dur-fast) var(--ease);
}
.ac-item:hover,
.ac-item.active {
  background: var(--accent-weak);
  color: var(--accent);
}
.ac-item:first-child {
  border-top-left-radius: var(--radius-md);
  border-top-right-radius: var(--radius-md);
}
.ac-item:last-child {
  border-bottom-left-radius: var(--radius-md);
  border-bottom-right-radius: var(--radius-md);
}
.ac-repo {
  font-size: var(--text-xs);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trigger-layout {
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

/* Toggle switch */
.toggle {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
  flex: 0 0 auto;
}
.toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-3);
  transition: transform var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.toggle.on {
  background: #fff;
  border-color: var(--border-strong);
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
.hint-text {
  font-size: var(--text-xs);
  color: var(--text-3);
  margin: var(--space-3) 0 0;
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
.history {
  display: flex;
  flex-direction: column;
}
.history-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  width: 100%;
  text-align: left;
  transition: background var(--dur-fast) var(--ease);
}
.history-row:last-child {
  border-bottom: none;
}
.history-row:hover {
  background: var(--surface-3);
}
.h-repo {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text);
  flex: 1 1 auto;
  min-width: 0;
}
.h-time {
  font-size: var(--text-xs);
  color: var(--text-3);
  white-space: nowrap;
}

@media (max-width: 900px) {
  .trigger-layout {
    grid-template-columns: 1fr;
  }
  .side-col {
    position: static;
  }
}
@media (max-width: 640px) {
  .event-row,
  .repo-row {
    grid-template-columns: 1fr;
  }
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
