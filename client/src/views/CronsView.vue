<script setup lang="ts">
/**
 * Crons list — a table of scheduled jobs inside the app shell. Each row opens
 * the editor; the "New cron" action in the top bar opens the create form.
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getJson, ApiRequestError } from "../api/client.js";
import type { CronsResponse, CronRow } from "../api/types.js";
import { cronScheduleText } from "../lib/format.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import StatusPill from "../components/ui/StatusPill.vue";
import EmptyState from "../components/ui/EmptyState.vue";

const router = useRouter();
const crons = ref<CronRow[]>([]);
const loading = ref(false);
const loadError = ref("");

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const body = await getJson<CronsResponse>("/api/crons");
    crons.value = body.crons ?? [];
  } catch (e) {
    loadError.value = e instanceof ApiRequestError ? e.message : "Could not load crons.";
  } finally {
    loading.value = false;
  }
}

function open(id: number): void {
  void router.push({ name: "cron-detail", params: { id: String(id) } });
}
function create(): void {
  void router.push({ name: "cron-new" });
}

onMounted(load);
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="ghost" size="sm" icon="refresh" :loading="loading" @click="load">
        Refresh
      </Button>
      <Button variant="primary" size="sm" icon="plus" @click="create">New cron</Button>
    </template>

    <div v-if="loadError" class="banner err">{{ loadError }}</div>

    <div v-if="loading && crons.length === 0" class="loading-row">Loading crons…</div>

    <EmptyState
      v-else-if="crons.length === 0"
      icon="cron"
      title="No scheduled crons"
      desc="Create a cron to run the agent on a recurring schedule — it commits to a branch and opens issues with its findings."
    >
      <Button variant="primary" icon="plus" @click="create">New cron</Button>
    </EmptyState>

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="col-status">State</th>
            <th>Name</th>
            <th class="col-sched">Schedule</th>
            <th class="col-repo">Repository</th>
            <th class="col-next">Next run</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in crons" :key="c.id" class="row" @click="open(c.id)">
            <td>
              <StatusPill :status="c.enabled ? 'enabled' : 'disabled'" />
            </td>
            <td>
              <span class="cron-name">{{ c.name }}</span>
            </td>
            <td class="col-sched">
              <code class="tag">{{ cronScheduleText(c.cron_expression) }}</code>
            </td>
            <td class="col-repo muted ellipsis">{{ c.repo }}</td>
            <td class="col-next muted">{{ c.next_run_at ? c.next_run_at.replace("T", " ").slice(0, 16) : "—" }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </AppShell>
</template>

<style scoped>
.banner {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  margin-bottom: var(--space-4);
}
.banner.err {
  background: var(--danger-weak);
  color: var(--danger);
}
.loading-row {
  padding: var(--space-12);
  text-align: center;
  color: var(--text-3);
  font-size: var(--text-sm);
}
.table-wrap {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}
thead th {
  text-align: left;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
}
tbody td {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: middle;
}
tbody tr:last-child td {
  border-bottom: none;
}
.row {
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.row:hover {
  background: var(--surface-3);
}
.cron-name {
  font-weight: var(--weight-medium);
  color: var(--text);
}
.tag {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background: var(--surface-4);
  color: var(--text-2);
  padding: 2px 7px;
  border-radius: var(--radius-sm);
}
.col-status,
.col-sched,
.col-repo,
.col-next {
  white-space: nowrap;
}
</style>
