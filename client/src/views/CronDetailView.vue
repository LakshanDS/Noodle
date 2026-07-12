<script setup lang="ts">
/**
 * Cron create/edit form. Two columns: the form fields on the left, a context
 * sidebar on the right (live schedule preview + recent-run history when editing).
 * Save creates (POST) or updates (PATCH); after a create we navigate to the
 * edit route so a subsequent save PATCHes.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getJson, sendJson, ApiRequestError } from "../api/client.js";
import type {
  CronDetailResponse,
  CronMutationResponse,
  ProfilesResponse,
  CronInput,
  RunRow as RunRowData,
} from "../api/types.js";
import { cronScheduleText, fmtTime, repoLeaf } from "../lib/format.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Field from "../components/ui/Field.vue";
import StatusPill from "../components/ui/StatusPill.vue";
import Icon from "../components/ui/Icon.vue";

const props = defineProps<{ id?: string; isNew?: boolean }>();
const router = useRouter();

const form = ref({
  name: "",
  repo: "",
  branch_name: "",
  cron_expression: "0 0 * * *",
  profile: "",
  runtime: "" as string,
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

const editing = computed(() => !props.isNew && props.id != null);
const schedulePreview = computed(() => cronScheduleText(form.value.cron_expression));

function emptyForm() {
  return { name: "", repo: "", branch_name: "", cron_expression: "0 0 * * *", profile: "", runtime: "", prompt: "", enabled: 1 };
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

async function loadCron(): Promise<void> {
  if (!editing.value || props.id == null) {
    form.value = emptyForm();
    return;
  }
  loading.value = true;
  try {
    const body = await getJson<CronDetailResponse>(`/api/crons/${encodeURIComponent(props.id)}`);
    const c = body.cron;
    form.value = {
      name: c.name,
      repo: c.repo,
      branch_name: c.branch_name,
      cron_expression: c.cron_expression,
      profile: c.profile ?? "",
      runtime: c.runtime ?? "",
      prompt: c.prompt,
      enabled: c.enabled,
    };
    runs.value = body.runs ?? [];
  } catch (e) {
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Could not load cron.";
  } finally {
    loading.value = false;
  }
}

function payload(): CronInput {
  return {
    name: form.value.name.trim(),
    repo: form.value.repo.trim(),
    branch_name: form.value.branch_name.trim(),
    cron_expression: form.value.cron_expression.trim(),
    profile: form.value.profile || null,
    runtime: form.value.runtime || null,
    prompt: form.value.prompt,
  };
}

async function save(): Promise<void> {
  errorMsg.value = "";
  saving.value = true;
  try {
    if (editing.value && props.id != null) {
      await sendJson<CronMutationResponse>(`/api/crons/${encodeURIComponent(props.id)}`, "PATCH", payload());
      await loadCron();
    } else {
      const body = await sendJson<CronMutationResponse>("/api/crons", "POST", payload());
      await router.replace({ name: "cron-detail", params: { id: String(body.cron.id) } });
    }
  } catch (e) {
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Could not reach server";
  } finally {
    saving.value = false;
  }
}

async function runNow(): Promise<void> {
  if (!editing.value || props.id == null) return;
  runState.value = "queueing";
  try {
    await sendJson(`/api/crons/${encodeURIComponent(props.id)}/run`, "POST");
    runState.value = "queued";
    setTimeout(() => (runState.value = "idle"), 2000);
  } catch (e) {
    runState.value = "error";
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Failed";
  }
}

async function toggleEnabled(): Promise<void> {
  if (!editing.value || props.id == null) return;
  const enable = form.value.enabled === 0;
  try {
    await sendJson<CronMutationResponse>(`/api/crons/${encodeURIComponent(props.id)}`, "PATCH", { enabled: enable ? 1 : 0 });
    form.value.enabled = enable ? 1 : 0;
  } catch {
    /* ignore */
  }
}

async function deleteCron(): Promise<void> {
  if (!editing.value || props.id == null) return;
  if (!confirm("Delete this cron? Run history is kept.")) return;
  try {
    await sendJson(`/api/crons/${encodeURIComponent(props.id)}`, "DELETE");
    await router.replace({ name: "crons" });
  } catch {
    /* ignore */
  }
}

function openRun(jobId: string): void {
  void router.push({ name: "run-detail", params: { id: jobId } });
}

watch(
  () => [props.id, props.isNew],
  () => void loadCron(),
);
onMounted(async () => {
  await ensureProfiles();
  await loadCron();
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
        @click="loadCron"
      >
        Refresh
      </Button>
    </template>

    <div v-if="loading" class="loading-row">Loading…</div>

    <div v-else class="cron-layout">
      <!-- Form -->
      <div class="form-col">
        <Card :title="editing ? 'Edit schedule' : 'New schedule'">
          <div v-if="errorMsg" class="banner err">{{ errorMsg }}</div>

          <Field label="Name">
            <input v-model="form.name" class="ctrl" type="text" placeholder="e.g. Bug sweep" />
          </Field>
          <Field label="Repository">
            <input v-model="form.repo" class="ctrl" type="text" placeholder="owner/name" />
          </Field>
          <Field label="Branch" hint="The agent commits here each run. Reused across runs.">
            <input v-model="form.branch_name" class="ctrl" type="text" placeholder="e.g. wa-agent" />
          </Field>
          <Field label="Schedule (cron expression)">
            <input v-model="form.cron_expression" class="ctrl mono" type="text" placeholder="0 0 * * *" />
          </Field>
          <Field label="Profile" hint="Which model the cron runs on.">
            <select v-model="form.profile" class="ctrl">
              <option value="">Default</option>
              <option v-for="p in profiles" :key="p" :value="p">
                {{ p }}{{ p === defaultProfile ? " (default)" : "" }}
              </option>
            </select>
          </Field>
          <Field label="Runtime" hint="Override the agent engine for this cron. Leave as Default to use the profile/config runtime.">
            <select v-model="form.runtime" class="ctrl">
              <option value="">Default (from profile)</option>
              <option value="pi">pi</option>
              <option value="opencode">opencode</option>
            </select>
          </Field>
          <Field label="Prompt / Instructions">
            <textarea v-model="form.prompt" class="ctrl" placeholder="e.g. Find bugs in the codebase and open an issue for each one." />
          </Field>

          <div class="actions">
            <Button variant="primary" icon="check" :loading="saving" @click="save">
              {{ editing ? "Save changes" : "Create cron" }}
            </Button>
            <template v-if="editing">
              <Button variant="secondary" icon="play" :loading="runState === 'queueing'" @click="runNow">
                {{ runState === "queueing" ? "Queuing…" : runState === "queued" ? "Queued ✓" : runState === "error" ? "Failed" : "Run now" }}
              </Button>
              <Button variant="secondary" @click="toggleEnabled">
                {{ form.enabled ? "Disable" : "Enable" }}
              </Button>
              <Button variant="danger" icon="trash" @click="deleteCron">Delete</Button>
            </template>
          </div>
        </Card>
      </div>

      <!-- Sidebar: live preview + history -->
      <aside class="side-col">
        <Card title="Schedule preview">
          <div class="preview">
            <Icon name="clock" :size="16" />
            <span>{{ schedulePreview }}</span>
          </div>
          <code class="expr mono">{{ form.cron_expression }}</code>
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
.cron-layout {
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
.expr {
  display: inline-block;
  font-size: var(--text-xs);
  color: var(--text-3);
  background: var(--surface-1);
  border: 1px solid var(--border);
  padding: 3px 8px;
  border-radius: var(--radius-sm);
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
  .cron-layout {
    grid-template-columns: 1fr;
  }
  .side-col {
    position: static;
  }
}
</style>
