<script setup lang="ts">
/**
 * Skills list — a table of agent skills. The bundled ones mirror the real
 * skills/ directory at the repo root; custom ones come from the Add form.
 *
 * MOCK ONLY: backed by src/lib/mock.ts. Swap mockListSkills →
 * getJson<SkillsResponse>("/api/skills") to migrate.
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { mockListSkills } from "../lib/mock.js";
import type { SkillRow } from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import EmptyState from "../components/ui/EmptyState.vue";

const router = useRouter();
const skills = ref<SkillRow[]>([]);
const loading = ref(false);
const loadError = ref("");

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const body = await mockListSkills();
    skills.value = body.skills ?? [];
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : "Could not load skills.";
  } finally {
    loading.value = false;
  }
}

function open(name: string): void {
  void router.push({ name: "skill-detail", params: { name } });
}
function create(): void {
  void router.push({ name: "skill-new" });
}

onMounted(load);
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="ghost" size="sm" icon="refresh" :loading="loading" @click="load">
        Refresh
      </Button>
      <Button variant="primary" size="sm" icon="plus" @click="create">Add skill</Button>
    </template>

    <div v-if="loadError" class="banner err">{{ loadError }}</div>

    <div v-if="loading && skills.length === 0" class="loading-row">Loading skills…</div>

    <EmptyState
      v-else-if="skills.length === 0"
      icon="book"
      title="No skills"
      desc="Skills are markdown instructions (SKILL.md) that the agent loads to learn a workflow. Add one to teach the agent a new behavior."
    >
      <Button variant="primary" icon="plus" @click="create">Add skill</Button>
    </EmptyState>

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
            <th class="col-source">Source</th>
            <th class="col-updated">Updated</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in skills" :key="s.name" class="row" @click="open(s.name)">
            <td>
              <span class="skill-name mono">{{ s.name }}</span>
            </td>
            <td class="muted ellipsis">{{ s.description }}</td>
            <td class="col-source">
              <span class="badge" :class="s.source">{{ s.source }}</span>
            </td>
            <td class="col-updated muted">{{ s.updated_at ? s.updated_at.replace("T", " ").slice(0, 16) : "—" }}</td>
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
.skill-name {
  font-weight: var(--weight-medium);
  color: var(--text);
}
.badge {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  background: var(--surface-4);
  color: var(--text-3);
}
.badge.bundled {
  background: var(--accent-weak);
  color: var(--accent);
}
.col-source,
.col-updated {
  white-space: nowrap;
}
.ellipsis {
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
