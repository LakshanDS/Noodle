<script setup lang="ts">
/**
 * Schedulers list — a table of scheduled jobs inside the app shell. Each row
 * opens the editor; the "New schedule" action in the top bar opens the create
 * form.
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getJson, ApiRequestError, isAuthError } from "../api/client.js";
import type { SchedulersResponse, SchedulerRow } from "../api/types.js";
import { cronScheduleText } from "../lib/format.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import EmptyState from "../components/ui/EmptyState.vue";

const router = useRouter();
const schedulers = ref<SchedulerRow[]>([]);
const loading = ref(false);
const loadError = ref("");

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const body = await getJson<SchedulersResponse>("/api/schedulers");
    schedulers.value = body.schedulers ?? [];
  } catch (e) {
    if (isAuthError(e)) return;
    loadError.value = e instanceof ApiRequestError ? e.message : "Could not load schedules.";
  } finally {
    loading.value = false;
  }
}

function open(id: number): void {
  void router.push({ name: "scheduler-detail", params: { id: String(id) } });
}
function create(): void {
  void router.push({ name: "scheduler-new" });
}

onMounted(load);
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="ghost" size="sm" icon="refresh" :loading="loading" @click="load">
        <span class="btn-label">Refresh</span>
      </Button>
      <Button variant="primary" size="sm" icon="plus" @click="create">New schedule</Button>
    </template>

    <div v-if="loadError" class="banner err">{{ loadError }}</div>

    <div v-if="loading && schedulers.length === 0" class="loading-row">Loading schedules…</div>

    <EmptyState
      v-else-if="schedulers.length === 0"
      icon="cron"
      title="No schedules"
      desc="Create a schedule to run the agent on a recurring basis — it commits to a branch and opens issues with its findings."
    >
      <Button variant="primary" icon="plus" @click="create">New schedule</Button>
    </EmptyState>

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="col-state">State</th>
            <th>Name</th>
            <th class="col-sched">Schedule</th>
            <th class="col-repo">Repository</th>
            <th class="col-next">Next run</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in schedulers" :key="c.id" class="row" @click="open(c.id)">
            <td class="col-state" data-label="State">
              <span
                class="state-chip"
                :class="c.enabled ? 'on' : 'off'"
                :title="c.enabled ? 'Enabled' : 'Disabled'"
              >
                <span class="state-dot" />
                <span class="state-label">{{ c.enabled ? "Enabled" : "Disabled" }}</span>
              </span>
            </td>
            <td data-label="Name">
              <span class="cron-name">{{ c.name }}</span>
            </td>
            <td class="col-sched" data-label="Schedule">
              <code class="tag">{{ cronScheduleText(c.cron_expression) }}</code>
            </td>
            <td class="col-repo muted" data-label="Repository">{{ c.repo }}</td>
            <td class="col-next muted" data-label="Next run">{{ c.next_run_at ? c.next_run_at.replace("T", " ").slice(0, 16) : "—" }}</td>
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
.mono {
  font-family: var(--font-mono);
}
.muted {
  color: var(--text-3);
}
.ellipsis {
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background: var(--surface-4);
  color: var(--text-2);
  padding: 2px 7px;
  border-radius: var(--radius-sm);
}
/* Inline state chip — a colored dot + label. We use this instead of StatusPill
 * so the "Enabled"/"Disabled" label survives on mobile (StatusPill drops its
 * label below 768px, leaving only a dot). */
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
.col-sched,
.col-repo,
.col-next {
  white-space: nowrap;
}

/* ---------- Mobile (≤768px) — card, 2×2 grid (mirrors Runs) ----------
   ┌────────────────────────────────────┐
   │ nightly-triage              Enabled │   row 1
   │ Every day 0:30       LakshanDS/…   │   row 2
   └────────────────────────────────────┘
   Next run is hidden (on the detail page). */
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

  /* ---- Row 1: Name (left) · State (right) ---- */
  td[data-label="Name"] {
    grid-column: 1;
    grid-row: 1;
    min-width: 0;
  }
  td[data-label="Name"] .cron-name {
    font-weight: var(--weight-semibold);
  }
  td[data-label="State"] {
    grid-column: 2;
    grid-row: 1;
    justify-self: end;
  }

  /* ---- Row 2: Schedule (left) · Repository (right) ---- */
  td[data-label="Schedule"] {
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
    /* Render the full repo string right-to-left so the end (the repo name) is
     * flush with the right edge and the leading characters get clipped. When
     * the path is longer than the available width, text-overflow + direction
     * rtl shows "…last ~15 chars" — e.g. "…shanDS/WA-Agent" — so the repo name
     * is always readable. */
    direction: rtl;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Next run is hidden on mobile (on the detail page). */
  td[data-label="Next run"] {
    display: none;
  }
}
</style>
