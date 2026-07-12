<script setup lang="ts">
/**
 * Commands list — a table of slash-command runners inside the app shell.
 * Each row opens the editor; the "New command" action opens the create form.
 * Backed by the DB command store via GET /api/commands.
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getJson } from "../api/client.js";
import type { CommandRow, CommandsResponse } from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import StatusPill from "../components/ui/StatusPill.vue";
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
        Refresh
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
            <th class="col-status">State</th>
            <th class="col-trigger">Trigger</th>
            <th>Name</th>
            <th>Description</th>
            <th class="col-profile">Profile</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in commands" :key="c.id" class="row" @click="open(c.id)">
            <td>
              <StatusPill :status="c.enabled ? 'enabled' : 'disabled'" />
            </td>
            <td class="col-trigger">
              <code class="tag">/{{ c.trigger }}</code>
              <span v-if="c.is_builtin" class="builtin-badge" title="Built-in command — cannot be deleted">built-in</span>
            </td>
            <td>
              <span class="cmd-name">{{ c.name }}</span>
            </td>
            <td class="muted ellipsis">{{ c.description }}</td>
            <td class="col-profile muted">{{ c.profile ?? "Default" }}</td>
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
.cmd-name {
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
.builtin-badge {
  margin-left: var(--space-2);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-3);
  border: 1px solid var(--border);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}
.col-status,
.col-trigger,
.col-profile {
  white-space: nowrap;
}
.ellipsis {
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
