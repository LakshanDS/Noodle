<script setup lang="ts">
/**
 * Runs list — a dense data table inside the app shell. Each row is a link to
 * the run detail. Running rows show a Cancel affordance in the row; clicking it
 * cancels (marks the job failed) and refreshes the list.
 *
 * Columns: status dot · repo (#issue / scheduled) · profile · model · duration.
 * Manual refresh via the top-bar action; no auto-polling yet.
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getJson, sendJson, ApiRequestError, isAuthError } from "../api/client.js";
import type { RunsResponse, RunRow } from "../api/types.js";
import { fmtTime, repoLeaf, fmtDuration } from "../lib/format.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import StatusPill from "../components/ui/StatusPill.vue";
import EmptyState from "../components/ui/EmptyState.vue";

const router = useRouter();
const runs = ref<RunRow[]>([]);
const loading = ref(false);
const loadError = ref("");

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const body = await getJson<RunsResponse>("/api/runs");
    runs.value = body.runs ?? [];
  } catch (e) {
    if (isAuthError(e)) return;
    loadError.value = e instanceof ApiRequestError ? e.message : "Could not load runs.";
  } finally {
    loading.value = false;
  }
}

async function cancel(jobId: string): Promise<void> {
  try {
    await sendJson(`/api/runs/${encodeURIComponent(jobId)}/cancel`, "POST");
    await load();
  } catch {
    /* the row stays; the next manual refresh will reconcile */
  }
}

function open(id: string): void {
  void router.push({ name: "run-detail", params: { id } });
}

const liveCount = computed(() => runs.value.filter((r) => r.status === "running").length);

onMounted(load);
</script>

<template>
  <AppShell>
    <template #actions>
      <span v-if="liveCount > 0" class="live-pill">
        <span class="live-dot" /> {{ liveCount }} running
      </span>
      <Button variant="ghost" size="sm" icon="refresh" :loading="loading" @click="load">
        <span class="btn-label">Refresh</span>
      </Button>
    </template>

    <div v-if="loadError" class="banner err">{{ loadError }}</div>

    <div v-if="loading && runs.length === 0" class="loading-row">Loading runs…</div>

    <EmptyState
      v-else-if="runs.length === 0"
      icon="runs"
      title="No runs yet"
      desc="When Noodle picks up an issue, runs will appear here with their full conversation."
    />

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="col-status">Status</th>
            <th>Repository</th>
            <th class="col-profile">Profile</th>
            <th class="col-model">Model</th>
            <th class="col-time">When</th>
            <th class="col-dur">Duration</th>
            <th class="col-act"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in runs" :key="r.job_id" class="row" @click="open(r.job_id)">
            <td data-label="Status"><StatusPill :status="r.status" /></td>
            <td data-label="Repository">
              <div class="repo-cell">
                <span class="repo-name">{{ repoLeaf(r.repo) }}</span>
                <span class="repo-meta">
                  <span class="repo-full">{{ r.repo }}</span><span class="ctx-issue" v-if="r.issue != null"> #{{ r.issue }}</span><span class="ctx-cron" v-else-if="r.cron_job_id"> · scheduled</span>
                </span>
              </div>
            </td>
            <td class="col-profile" data-label="Profile">
              <code v-if="r.profile" class="tag">{{ r.profile }}</code>
              <span v-else class="subtle">—</span>
            </td>
            <td class="col-model" data-label="Model">
              <span v-if="r.model" class="muted ellipsis">{{ r.model }}</span>
              <span v-else class="subtle">—</span>
            </td>
            <td class="col-time muted" data-label="When">{{ fmtTime(r.started_at) }}</td>
            <td class="col-dur muted" data-label="Duration">{{ fmtDuration(r.started_at, r.finished_at) }}</td>
            <td class="col-act" data-label="">
              <Button
                v-if="r.status === 'running'"
                variant="ghost"
                size="sm"
                @click.stop="cancel(r.job_id)"
              >
                Cancel
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </AppShell>
</template>

<style scoped>
.live-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--warning);
  background: var(--warning-weak);
  padding: 4px 10px;
  border-radius: var(--radius-full);
  margin-right: var(--space-1);
}
.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warning);
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

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

.repo-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.repo-name {
  font-weight: var(--weight-medium);
  color: var(--text);
}
.repo-meta {
  font-size: var(--text-xs);
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

.col-status {
  width: 1%;
  white-space: nowrap;
}
.col-profile,
.col-model,
.col-time,
.col-dur {
  white-space: nowrap;
}
.col-model {
  max-width: 200px;
}
.col-act {
  width: 1%;
  text-align: right;
}

/* ---------- Mobile (≤768px) — card, 2 rows ----------
   ┌──────────────────────────────────────────┐
   │ repo leaf + #issue               ● Status │   row 1
   │ Jul 14, 2:30 PM · 1h 12m        profile  │   row 2: time·dur (left) · profile (right)
   └──────────────────────────────────────────┘
   The profile shows its FULL name, right-aligned; it only ellipsizes from the
   left if it's too long to fit. Model is hidden (on the detail page). */
@media (max-width: 768px) {
  .table,
  tbody {
    display: block;
  }
  thead {
    display: none;
  }
  .table-wrap {
    background: transparent;
    border: none;
    border-radius: 0;
  }
  tr.row {
    display: grid;
    /* Col 1 = time·dur (auto), col 2 = duration tail (auto), col 3 = profile
     * (grows). Row 1 spans cols 1-2 for the repo name. */
    grid-template-columns: auto auto 1fr;
    align-items: baseline;
    column-gap: var(--space-2);
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
  td::before {
    content: none;
  }

  /* ---- Row 1: Repository (cols 1-2) · Status (col 3) ---- */
  td[data-label="Repository"] {
    grid-column: 1 / 3;
    grid-row: 1;
    min-width: 0;
  }
  td[data-label="Repository"] .repo-name {
    font-weight: var(--weight-semibold);
  }
  .repo-cell {
    flex-direction: row;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
  }
  .repo-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .repo-full {
    display: none;
  }
  .repo-meta {
    flex: 0 0 auto;
    font-size: var(--text-xs);
    color: var(--text-3);
    white-space: nowrap;
  }
  td[data-label="Status"] {
    grid-column: 3;
    grid-row: 1;
    justify-self: end;
  }
  td[data-label="Status"] :deep(.pill) {
    padding: 3px 8px 3px 7px;
    background: var(--surface-4);
  }
  td[data-label="Status"] :deep(.label) {
    display: inline;
  }
  td[data-label="Status"] :deep(.dot) {
    width: 6px;
    height: 6px;
  }

  /* ---- Row 2: When (col 1) · Duration (col 2) · Profile (col 3) ---- */
  td[data-label="When"] {
    grid-column: 1;
    grid-row: 2;
    font-size: var(--text-xs);
    color: var(--text-3);
  }
  td[data-label="Duration"] {
    grid-column: 2;
    grid-row: 2;
    font-size: var(--text-xs);
    color: var(--text-3);
  }
  /* Dot-separator between When and Duration. */
  td[data-label="Duration"]::before {
    content: "·";
    margin-right: var(--space-2);
    color: var(--text-3);
  }
  td[data-label="Profile"] {
    grid-column: 3;
    grid-row: 2;
    justify-self: end;
    text-align: right;
    font-size: var(--text-xs);
    min-width: 0;
    /* Show the full name; only ellipsize from the left if it overflows. RTL
     * direction keeps the text right-aligned and clips the leading chars. */
    direction: rtl;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Strip the chip styling on mobile so the profile is plain text — matches the
   * height of the time/duration cells, keeping the card's padding even top and
   * bottom instead of the chip's extra padding skewing it. */
  td[data-label="Profile"] .tag {
    background: transparent;
    padding: 0;
    font-family: inherit;
    color: var(--text-3);
  }

  /* Model is hidden on mobile. */
  .col-model {
    display: none;
  }

  /* Cancel spans the full width below the grid if the run is live. The <td>
   * exists in the DOM even when there's no button (non-running runs), so hide
   * it when empty — otherwise it creates a phantom grid row 3 whose row-gap
   * shows up as extra bottom padding on every non-running card. */
  td[data-label=""]:empty {
    display: none;
  }
  td[data-label=""]:not(:empty) {
    grid-column: 1 / -1;
    grid-row: 3;
    margin-top: var(--space-1);
  }
}
</style>
