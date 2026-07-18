<script setup lang="ts">
/**
 * Triggers list — a table of event-driven triggers inside the app shell. Each
 * row opens the editor; the "New trigger" action in the top bar opens the create form.
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getJson, ApiRequestError, isAuthError } from "../api/client.js";
import type { TriggersResponse, TriggerRow } from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import EmptyState from "../components/ui/EmptyState.vue";

const router = useRouter();
const triggers = ref<TriggerRow[]>([]);
const loading = ref(false);
const loadError = ref("");

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const body = await getJson<TriggersResponse>("/api/triggers");
    triggers.value = body.triggers ?? [];
  } catch (e) {
    if (isAuthError(e)) return;
    loadError.value = e instanceof ApiRequestError ? e.message : "Could not load triggers.";
  } finally {
    loading.value = false;
  }
}

function open(id: number): void {
  void router.push({ name: "trigger-detail", params: { id: String(id) } });
}
function create(): void {
  void router.push({ name: "trigger-new" });
}

function eventLabel(t: TriggerRow): string {
  return t.event_action ? `${t.event_type}.${t.event_action}` : t.event_type;
}

onMounted(load);
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="ghost" size="sm" icon="refresh" :loading="loading" @click="load">
        <span class="btn-label">Refresh</span>
      </Button>
      <Button variant="primary" size="sm" icon="plus" @click="create">New trigger</Button>
    </template>

    <div v-if="loadError" class="banner err">{{ loadError }}</div>

    <div v-if="loading && triggers.length === 0" class="loading-row">Loading triggers…</div>

    <EmptyState
      v-else-if="triggers.length === 0"
      icon="zap"
      title="No triggers"
      desc="Create an event-driven trigger to run the agent when a GitHub event occurs — PR opened, issue created, push to branch, etc."
    >
      <Button variant="primary" icon="plus" @click="create">New trigger</Button>
    </EmptyState>

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="col-state">State</th>
            <th>Name</th>
            <th class="col-event">Event</th>
            <th class="col-repo">Repository</th>
            <th class="col-status">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in triggers" :key="t.id" class="row" @click="open(t.id)">
            <td class="col-state" data-label="State">
              <span
                class="state-chip"
                :class="t.enabled ? 'on' : 'off'"
                :title="t.enabled ? 'Enabled' : 'Disabled'"
              >
                <span class="state-dot" />
                <span class="state-label">{{ t.enabled ? "Enabled" : "Disabled" }}</span>
              </span>
            </td>
            <td data-label="Name">
              <span class="trigger-name">{{ t.name }}</span>
            </td>
            <td class="col-event" data-label="Event">
              <code class="tag">{{ eventLabel(t) }}</code>
            </td>
            <td class="col-repo muted" data-label="Repository">{{ t.repo }}</td>
            <td class="col-status" data-label="Status">
              <span v-if="t.last_run_status" class="status-text" :class="t.last_run_status">
                {{ t.last_run_status }}
              </span>
              <span v-else class="muted">—</span>
            </td>
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
.trigger-name {
  font-weight: var(--weight-medium);
  color: var(--text);
}
.muted {
  color: var(--text-3);
}
.tag {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background: var(--surface-4);
  color: var(--text-2);
  padding: 2px 7px;
  border-radius: var(--radius-sm);
}
.state-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  white-space: nowrap;
  letter-spacing: var(--tracking-tight);
}
.state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.state-chip.on {
  color: var(--success);
  background: var(--success-weak);
  border-radius: var(--radius-full);
  padding: 3px 8px 3px 7px;
}
.state-chip.on .state-dot {
  background: var(--success);
}
.state-chip.off {
  color: var(--neutral);
  background: var(--neutral-weak);
  border-radius: var(--radius-full);
  padding: 3px 8px 3px 7px;
}
.state-chip.off .state-dot {
  background: var(--neutral);
}
.col-state,
.col-event,
.col-repo,
.col-status {
  white-space: nowrap;
}
.status-text {
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  text-transform: capitalize;
}
.status-text.succeeded {
  color: var(--success);
}
.status-text.failed {
  color: var(--danger);
}
.status-text.running {
  color: var(--warning);
}

@media (max-width: 768px) {
  .table-wrap {
    background: transparent;
    border: none;
    border-radius: 0;
  }
  .table,
  tbody {
    display: block;
  }
  thead {
    display: none;
  }
  tr.row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    column-gap: var(--space-3);
    row-gap: var(--space-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-3);
  }
  tr.row:hover {
    background: var(--surface-3);
  }
  tbody td {
    display: block;
    padding: 0;
    border: none;
  }
  td[data-label="Name"] {
    grid-column: 1;
    grid-row: 1;
    min-width: 0;
  }
  td[data-label="Name"] .trigger-name {
    font-weight: var(--weight-semibold);
  }
  td[data-label="State"] {
    grid-column: 2;
    grid-row: 1;
    justify-self: end;
  }
  td[data-label="Event"] {
    grid-column: 1;
    grid-row: 2;
    min-width: 0;
  }
  td[data-label="Repository"] {
    grid-column: 2;
    grid-row: 2;
    justify-self: end;
    text-align: right;
    font-size: var(--text-xs);
    color: var(--text-3);
    min-width: 0;
    direction: rtl;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  td[data-label="Status"] {
    display: none;
  }
}
</style>
