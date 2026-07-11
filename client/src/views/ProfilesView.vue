<script setup lang="ts">
/**
 * Profiles list — a table of agent profiles inside the app shell. Each row opens
 * the editor; "New profile" opens the create form. DB-managed profiles (source
 * "db") are editable/deletable; YAML-only profiles (source "yaml") are shown
 * read-only (the edit form will promote them to a DB override on save).
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getJson, ApiRequestError } from "../api/client.js";
import type { ProfilesResponse, ProfileListItem } from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import EmptyState from "../components/ui/EmptyState.vue";

const router = useRouter();
const items = ref<ProfileListItem[]>([]);
const defaultProfile = ref("");
const loading = ref(false);
const loadError = ref("");

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const body = await getJson<ProfilesResponse>("/api/profiles");
    items.value = body.items ?? [];
    defaultProfile.value = body.default ?? "";
  } catch (e) {
    loadError.value = e instanceof ApiRequestError ? e.message : "Could not load profiles.";
  } finally {
    loading.value = false;
  }
}

function open(name: string): void {
  void router.push({ name: "profile-detail", params: { name } });
}
function create(): void {
  void router.push({ name: "profile-new" });
}

onMounted(load);
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="ghost" size="sm" icon="refresh" :loading="loading" @click="load">
        Refresh
      </Button>
      <Button variant="primary" size="sm" icon="plus" @click="create">New profile</Button>
    </template>

    <div v-if="loadError" class="banner err">{{ loadError }}</div>

    <div v-if="loading && items.length === 0" class="loading-row">Loading profiles…</div>

    <EmptyState
      v-else-if="items.length === 0"
      icon="key"
      title="No profiles yet"
      desc="Create a profile to pin a provider + model + tool set the agent can run as, then route issues to it with #&lt;name&gt; tags."
    >
      <Button variant="primary" icon="plus" @click="create">New profile</Button>
    </EmptyState>

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="col-name">Name</th>
            <th>Provider / Model</th>
            <th class="col-tools">Tools</th>
            <th class="col-source">Source</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="it in items" :key="it.name" class="row" @click="open(it.name)">
            <td class="col-name">
              <span class="prof-name">{{ it.name }}</span>
              <span v-if="it.name === defaultProfile" class="default-badge">default</span>
            </td>
            <td>
              <span class="mono sm">{{ it.profile.provider }} / {{ it.profile.model }}</span>
            </td>
            <td class="col-tools muted">{{ it.profile.tools.length }}</td>
            <td class="col-source">
              <span class="tag" :class="{ yaml: it.source === 'yaml' }">
                {{ it.source === "db" ? "Database" : "YAML" }}
              </span>
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
.col-name {
  white-space: nowrap;
}
.prof-name {
  font-weight: var(--weight-medium);
  color: var(--text);
}
.default-badge {
  display: inline-block;
  margin-left: var(--space-2);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--accent);
  background: var(--accent-weak);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
}
.mono {
  font-family: var(--font-mono);
}
.sm {
  font-size: var(--text-xs);
}
.muted {
  color: var(--text-3);
}
.col-tools {
  text-align: center;
  white-space: nowrap;
}
.col-source {
  white-space: nowrap;
}
.tag {
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  background: var(--surface-4);
  color: var(--text-2);
  padding: 2px 7px;
  border-radius: var(--radius-sm);
}
.tag.yaml {
  background: var(--surface-1);
  color: var(--text-3);
}
</style>
