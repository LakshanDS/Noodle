<script setup lang="ts">
/**
 * Schedule create/edit form. Two columns: the form fields on the left, a context
 * sidebar on the right (live schedule preview + recent-run history when editing).
 * Save creates (POST) or updates (PATCH); after a create we navigate to the
 * edit route so a subsequent save PATCHes.
 */
import { computed, onMounted, ref, watch, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { getJson, sendJson, ApiRequestError, isAuthError } from "../api/client.js";
import type {
  SchedulerDetailResponse,
  SchedulerMutationResponse,
  ProfilesResponse,
  SchedulerInput,
  RunRow as RunRowData,
  ReposResponse,
  RepoData,
} from "../api/types.js";
import { cronScheduleText, fmtTime, repoLeaf } from "../lib/format.js";
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

const form = ref({
  name: "",
  repo: "",
  branch_name: "noodle/schedules",
  cron_expression: "0 0 * * *",
  profile: "",
  prompt: "",
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

const editing = computed(() => !props.isNew && props.id != null);
const schedulePreview = computed(() => cronScheduleText(form.value.cron_expression));

// Custom-labels toggle + 3 label fields. When off, the schedule uses the global
// default labels (Settings → GitHub labels). When on, these 3 override them
// and are applied to the schedule's output issue (cooked on success / failed on error).
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
const profileOptions = computed<SelectOption[]>(() => [
  { value: "", label: "Default" },
  ...profiles.value.map((p) => ({
    value: p,
    label: p + (p === defaultProfile.value ? " (default)" : ""),
  })),
]);

function emptyForm() {
  return { name: "", repo: "", branch_name: "noodle/schedules", cron_expression: "0 0 * * *", profile: "", prompt: "", enabled: 1 };
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

async function loadScheduler(): Promise<void> {
  if (!editing.value || props.id == null) {
    form.value = emptyForm();
    return;
  }
  loading.value = true;
  try {
    const body = await getJson<SchedulerDetailResponse>(`/api/schedulers/${encodeURIComponent(props.id)}`);
    const s = body.scheduler;
    form.value = {
      name: s.name,
      repo: s.repo,
      branch_name: s.branch_name,
      cron_expression: s.cron_expression,
      profile: s.profile ?? "",
      prompt: s.prompt,
      enabled: s.enabled,
    };
    // Parse any custom label override; toggle reflects whether one is set.
    const parsed = s.labels ? parseStoredLabels(s.labels) : null;
    useCustomLabels.value = !!parsed;
    labelFields.value = parsed
      ? [parsed.cooking, parsed.cooked, parsed.failed]
      : [{ ...DEFAULT_LABELS.cooking }, { ...DEFAULT_LABELS.cooked }, { ...DEFAULT_LABELS.failed }];
    runs.value = body.runs ?? [];
  } catch (e) {
    if (isAuthError(e)) return;
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Could not load schedule.";
  } finally {
    loading.value = false;
  }
}

/** Parse a stored label-set JSON string into its 3 fields, or null on failure. */
function parseStoredLabels(raw: string): typeof DEFAULT_LABELS | null {
  try {
    const p = JSON.parse(raw) as typeof DEFAULT_LABELS;
    if (!p?.cooking || !p?.cooked || !p?.failed) return null;
    return {
      cooking: { name: p.cooking.name, color: p.cooking.color },
      cooked: { name: p.cooked.name, color: p.cooked.color },
      failed: { name: p.failed.name, color: p.failed.color },
    };
  } catch {
    return null;
  }
}

function payload(): SchedulerInput {
  const [cooking, cooked, failed] = labelFields.value;
  return {
    name: form.value.name.trim(),
    repo: form.value.repo.trim(),
    branch_name: form.value.branch_name.trim(),
    cron_expression: form.value.cron_expression.trim(),
    profile: form.value.profile || null,
    prompt: form.value.prompt,
    // Serialize the label override only when the toggle is on; null = inherit
    // the global default labels.
    labels: useCustomLabels.value
      ? JSON.stringify({
          cooking: { name: cooking.name, color: cooking.color },
          cooked: { name: cooked.name, color: cooked.color },
          failed: { name: failed.name, color: failed.color },
        })
      : null,
  };
}

async function save(): Promise<void> {
  errorMsg.value = "";
  saving.value = true;
  try {
    if (editing.value && props.id != null) {
      await sendJson<SchedulerMutationResponse>(`/api/schedulers/${encodeURIComponent(props.id)}`, "PATCH", payload());
      await loadScheduler();
    } else {
      const body = await sendJson<SchedulerMutationResponse>("/api/schedulers", "POST", payload());
      await router.replace({ name: "scheduler-detail", params: { id: String(body.scheduler.id) } });
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
    await sendJson(`/api/schedulers/${encodeURIComponent(props.id)}/run`, "POST");
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
    await sendJson<SchedulerMutationResponse>(`/api/schedulers/${encodeURIComponent(props.id)}`, "PATCH", { enabled: enable ? 1 : 0 });
    form.value.enabled = enable ? 1 : 0;
  } catch {
    /* ignore */
  }
}

function deleteScheduler(): void {
  if (!editing.value || props.id == null) return;
  showDeleteConfirm.value = true;
}

async function confirmDeleteScheduler(): Promise<void> {
  if (props.id == null) return;
  deleting.value = true;
  try {
    await sendJson(`/api/schedulers/${encodeURIComponent(props.id)}`, "DELETE");
    showDeleteConfirm.value = false;
    await router.replace({ name: "schedulers" });
  } catch {
    /* ignore — keep the dialog open so the user can retry or cancel */
  } finally {
    deleting.value = false;
  }
}

function openRun(jobId: string): void {
  void router.push({ name: "run-detail", params: { id: jobId } });
}

/** Load repos the authenticated user/app can access — populates the repo
 *  datalist. Wrapped in try/catch: any failure leaves the list empty so the
 *  field degrades to a plain text input. */
async function loadRepos(): Promise<void> {
  try {
    const body = await getJson<ReposResponse>("/api/github/repos");
    repos.value = body.repos ?? [];
  } catch {
    repos.value = [];
  }
}

/* ---------- Custom autocomplete dropdown (replaces native <datalist>) ----------
 * Native datalist popups are unstyled OS widgets — they don't match the app
 * design and don't span the input width. This gives us a styled dropdown that
 * filters as the user types, closes on click-outside/select/Esc, and falls
 * back to plain text when there are no suggestions. */
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
/** Keyboard navigation for the repo dropdown: Up/Down to move highlight,
 *  Enter to select, Esc to close. */
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

/** Click-outside listener: closes the repo dropdown when the click
 *  lands outside its wrapper element. Replaces the fragile blur+setTimeout
 *  approach (which raced against the mousedown on dropdown items). */
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
  () => void loadScheduler(),
);
onMounted(async () => {
  await ensureProfiles();
  await loadScheduler();
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
        @click="loadScheduler"
      >
        <span class="btn-label">Refresh</span>
      </Button>
    </template>

    <div v-if="loading" class="loading-row">Loading…</div>

    <div v-else class="scheduler-layout">
      <!-- Form -->
      <div class="form-col">
        <Card :title="editing ? 'Edit schedule' : 'New schedule'">
          <div v-if="errorMsg" class="banner err">{{ errorMsg }}</div>

          <Field label="Name">
            <input v-model="form.name" class="ctrl" type="text" placeholder="e.g. Bug sweep" />
          </Field>
          <!-- Repository + Agent branch share one row. Repository uses a custom
               autocomplete dropdown; Agent branch is a plain text input. -->
          <div class="repo-branch-row">
            <div class="rb-field">
              <label class="rb-label">Repository</label>
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
            </div>
            <div class="rb-field">
              <label class="rb-label">Agent branch</label>
              <input
                v-model="form.branch_name"
                class="ctrl mono"
                type="text"
                placeholder="noodle/schedules"
                autocomplete="off"
              />
            </div>
          </div>
          <Field label="Schedule (cron expression)">
            <input v-model="form.cron_expression" class="ctrl mono" type="text" placeholder="0 0 * * *" />
          </Field>
          <Field label="Profile" hint="Which model the schedule runs on.">
            <Select v-model="form.profile" :options="profileOptions" />
          </Field>
          <Field label="Prompt / Instructions">
            <textarea v-model="form.prompt" class="ctrl" rows="8" placeholder="e.g. Find bugs in the codebase and open an issue for each one." />
          </Field>

          <!-- Custom labels toggle + editor. Mirrors the trigger/command pattern. -->
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
              When on, this schedule uses its own labels instead of the global
              defaults (Settings → GitHub labels). The cooked (success) or failed
              label is applied to the issue the agent opens with its findings.
            </p>
            <div v-if="useCustomLabels" class="cl-rows">
              <LabelEditor v-model="labelFields" />
            </div>
          </div>

        </Card>

        <div class="actions">
          <Button variant="primary" icon="check" :loading="saving" @click="save">
            {{ editing ? "Save changes" : "Create schedule" }}
          </Button>
          <template v-if="editing">
            <Button variant="secondary" icon="play" :loading="runState === 'queueing'" @click="runNow">
              {{ runState === "queueing" ? "Queuing…" : runState === "queued" ? "Queued ✓" : runState === "error" ? "Failed" : "Run now" }}
            </Button>
            <Button variant="secondary" @click="toggleEnabled">
              {{ form.enabled ? "Disable" : "Enable" }}
            </Button>
            <Button variant="danger" icon="trash" @click="deleteScheduler">Delete</Button>
          </template>
        </div>
      </div>

      <!-- Sidebar: live preview + how it works + history -->
      <aside class="side-col">
        <Card title="Schedule preview">
          <div class="preview">
            <Icon name="clock" :size="16" />
            <span>{{ schedulePreview }}</span>
          </div>
          <p class="hint-text">
            {{ schedulePreview }} — the agent wakes up at this time, clones
            <code class="inline mono">{{ form.repo || "owner/name" }}</code>, checks out the
            <code class="inline mono">{{ form.branch_name || "branch" }}</code> branch, follows your prompt,
            commits to that branch, and opens a pull request.
          </p>
          <p class="hint-text">
            Runs on the <code class="inline mono">{{ form.profile || "default" }}</code> profile. Disable a schedule
            to pause it without deleting.
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

        <Card title="Template tags">
          <p class="tag-intro">Tags in the prompt are replaced with live data at run time.</p>
          <div class="tag-list">
            <div class="tag-row"><code class="inline mono">{system}</code> - Full system info block (CPU, RAM, platform, tier).</div>
            <div class="tag-row"><code class="inline mono">{system.cpu}</code> - CPU core count.</div>
            <div class="tag-row"><code class="inline mono">{system.ram}</code> - Total, free, and limit memory (MB).</div>
            <div class="tag-row"><code class="inline mono">{system.tier}</code> - constrained or capable.</div>
            <div class="tag-row"><code class="inline mono">{pr.[n]}</code> - nth open PR (0-indexed): number, title, branches, URL.</div>
            <div class="tag-row"><code class="inline mono">{issue.[n]}</code> - nth open issue (0-indexed): number, title, labels, URL.</div>
          </div>
        </Card>
      </aside>

      <!-- Mobile-only duplicate action row — hidden on desktop, shown on phones
           so buttons are always the last thing on the page. -->
      <div class="actions actions-mobile">
        <Button variant="primary" icon="check" :loading="saving" @click="save">
          {{ editing ? "Save changes" : "Create schedule" }}
        </Button>
        <template v-if="editing">
          <Button variant="secondary" icon="play" :loading="runState === 'queueing'" @click="runNow">
            {{ runState === "queueing" ? "Queuing…" : runState === "queued" ? "Queued ✓" : runState === "error" ? "Failed" : "Run now" }}
          </Button>
          <Button variant="secondary" @click="toggleEnabled">
            {{ form.enabled ? "Disable" : "Enable" }}
          </Button>
          <Button variant="danger" icon="trash" @click="deleteScheduler">Delete</Button>
        </template>
      </div>
    </div>

    <ConfirmDialog
      v-model:open="showDeleteConfirm"
      title="Delete this schedule?"
      message="The schedule is removed but its run history is kept. This can't be undone."
      confirm-label="Delete"
      danger
      :loading="deleting"
      @confirm="confirmDeleteScheduler"
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
/* Repository + Branch share one row: repo takes ~62%, branch ~38%. Collapses
 * to stacked on phones. Labels match the Field component's uppercase style. */
.repo-branch-row {
  display: grid;
  grid-template-columns: 1.6fr 1fr;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.rb-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rb-label {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-3);
  font-weight: var(--weight-medium);
}
/* Custom autocomplete dropdown — styled like a native <select>: solid opaque
 * card spanning the full input width, flush items edge-to-edge. */
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
.scheduler-layout {
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

/* Custom-labels box — mirrors the command/trigger views' framed container. */
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
  line-height: var(--leading-normal);
  color: var(--text-3);
}
.cl-rows {
  margin-top: var(--space-3);
}
/* Switch toggle — matches the one in other views' customize cards. */
.toggle {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border);
  background: var(--surface-3);
  padding: 0;
  cursor: pointer;
  flex: 0 0 auto;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.toggle .toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
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
.expr {
  display: inline-block;
  font-size: var(--text-xs);
  color: var(--text-3);
  background: var(--surface-1);
  border: 1px solid var(--border);
  padding: 3px 8px;
  border-radius: var(--radius-sm);
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
.tag-intro {
  font-size: var(--text-sm);
  color: var(--text-2);
  margin-bottom: var(--space-3);
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
  .scheduler-layout {
    grid-template-columns: 1fr;
  }
  .side-col {
    position: static;
  }
}
@media (max-width: 640px) {
  .repo-branch-row {
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
