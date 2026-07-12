<script setup lang="ts">
/**
 * MCP Servers list — the shared library of MCP server definitions.
 * Profiles reference servers by name; the serve-mode worker resolves names to
 * full definitions before passing the profile to the runtime.
 *
 * Mirrors SkillsView.vue / CommandsView.vue: table with name, type, description,
 * updated columns. Clickable rows navigate to the detail editor. The "Add server"
 * button navigates to the create route.
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getJson } from "../api/client.js";
import type { McpServersResponse, McpServerRow } from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";

const router = useRouter();
const servers = ref<McpServerRow[]>([]);
const loading = ref(false);
const loadError = ref("");

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const body = await getJson<McpServersResponse>("/api/mcp-servers");
    servers.value = body.servers ?? [];
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : "Could not load MCP servers.";
  } finally {
    loading.value = false;
  }
}

function open(name: string): void {
  router.push({ name: "mcp-server-detail", params: { name } });
}

function create(): void {
  router.push({ name: "mcp-server-new" });
}

onMounted(load);
</script>

<template>
  <AppShell title="MCP Servers">
    <template #actions>
      <Button variant="secondary" icon="refresh" @click="load" :loading="loading">Refresh</Button>
      <Button variant="primary" icon="plus" @click="create">Add server</Button>
    </template>

    <div v-if="loading && !servers.length" class="loading-row">Loading…</div>
    <div v-else-if="loadError" class="banner err">{{ loadError }}</div>
    <div v-else-if="!servers.length" class="empty-row">
      No MCP servers configured. Add one — profiles reference them by name, and the
      OpenCode runtime loads them as tool servers.
    </div>
    <Card v-else>
      <table class="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Description</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in servers" :key="s.name" @click="open(s.name)" class="clickable">
            <td><code>{{ s.name }}</code></td>
            <td>{{ s.type }}</td>
            <td class="ellipsis">{{ s.description }}</td>
            <td>{{ s.updated_at }}</td>
          </tr>
        </tbody>
      </table>
    </Card>
  </AppShell>
</template>

<style scoped>
.loading-row, .empty-row { text-align: center; padding: var(--space-8); color: var(--text-muted); }
.banner { padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); margin-bottom: var(--space-4); }
.banner.err { background: var(--surface-error, rgba(255,0,0,.1)); color: var(--text-error, #f66); }
.table { width: 100%; border-collapse: collapse; }
.table th, .table td { padding: var(--space-2) var(--space-3); text-align: left; border-bottom: 1px solid var(--border-subtle); }
.table th { color: var(--text-muted); font-size: var(--text-xs); font-weight: var(--weight-normal); text-transform: uppercase; letter-spacing: var(--tracking-wide); }
.table .clickable { cursor: pointer; }
.table .clickable:hover { background: var(--surface-1); }
.ellipsis { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
code { font-family: var(--font-mono); font-size: var(--text-sm); }
</style>
