<script setup lang="ts">
/**
 * Commands list — a table of user-defined slash commands inside the app shell.
 * Each row opens the editor; the "New command" action opens the create form.
 * Read live from the DB via GET /api/commands.
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getJson } from "../api/client.js";
import { isAuthError } from "../api/client.js";
import type { CommandRow, CommandsResponse } from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import EmptyState from "../components/ui/EmptyState.vue";

const router = useRouter();
const commands = ref<CommandRow[]>([]);
const loading = ref(false);
const loadError = ref("");

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const body = await getJson<CommandsResponse>("/api/commands");
    commands.value = body.commands ?? [];
  } catch (e) {
    if (isAuthError(e)) return;
    loadError.value = e instanceof Error ? e.message : "Could not load commands.";
  } finally {
    loading.value = false;
  }
}

function open(id: number): void {
  void router.push({ name: "command-detail", params: { id: String(id) } });
}
function create(): void {
  void router.push({ name: "command-new" });
}

onMounted(load);
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="ghost" size="sm" icon="refresh" :loading="loading" @click="load">
        <span class="btn-label">Refresh</span>
      </Button>
      <Button variant="primary" size="sm" icon="plus" @click="create">New command</Button>
    </template>

    <div v-if="loadError" class="banner err">{{ loadError }}</div>

    <div v-if="loading && commands.length === 0" class="loading-row">Loading commands…</div>

    <EmptyState
      v-else-if="commands.length === 0"
      icon="bolt"
      title="No slash commands"
      desc="Define a slash command like /question or /search. Typing it in a GitHub issue wakes the agent with your custom instructions."
    >
      <Button variant="primary" icon="plus" @click="create">New command</Button>
    </EmptyState>

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="col-trigger">Trigger</th>
            <th class="col-state">State</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in commands" :key="c.id" class="row" @click="open(c.id)">
            <td class="col-trigger" data-label="Trigger">
              <code class="tag">/{{ c.trigger }}</code>
            </td>
            <td class="col-state" data-label="State">
              <span
                class="state-chip"
                :class="c.enabled ? 'on' : 'off'"
                :title="c.enabled ? 'Enabled' : 'Disabled'"
              >
                <span class="state-dot" />
                <span class="state-label">{{ c.enabled ? 'Enabled' : 'Disabled' }}</span>
              </span>
            </td>
            <td data-label="Description"><span class="desc muted">{{ c.description }}</span></td>
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
.tag {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background: var(--surface-4);
  color: var(--text-2);
  padding: 2px 7px;
  border-radius: var(--radius-sm);
}
.muted {
  color: var(--text-3);
}
.col-trigger,
.col-state {
  white-space: nowrap;
}
/* Clamp the description to a couple of lines on desktop; the full text lives
 * on the command's detail page (tap the row → "view all"). */
.desc {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}
/* Inline state chip — dot + label. Kept (not StatusPill) so the label
 * survives on mobile. Same treatment as the Schedules page. */
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

/* ---------- Mobile (≤768px) — card ----------
 * Top line: Trigger (left, semi-bold) + State chip (right). Below: description,
 * clamped to 3 lines. Mirrors the Skills/Schedules cards. */
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
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
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
  /* Top row: Trigger left, State right. */
  td[data-label="Trigger"] {
    flex: 0 0 auto;
    order: 1;
  }
  td[data-label="Trigger"] .tag {
    font-weight: var(--weight-semibold);
    color: var(--text);
  }
  td[data-label="State"] {
    flex: 0 0 auto;
    order: 2;
    margin-left: auto;
  }
  /* Description: full-width second line, clamped to 3 lines. */
  td[data-label="Description"] {
    flex: 0 0 100%;
    order: 3;
    margin-top: var(--space-2);
  }
  td[data-label="Description"] .desc {
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
}
</style>
