<script setup lang="ts">
/**
 * Skills list — a table of agent skills read live from the skills/ directory
 * via GET /api/skills. Bundled skills (noodle-default/fix/review) ship with the
 * package; custom ones are created through the Add form (which writes a new
 * skills/<name>/SKILL.md on disk).
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getJson } from "../api/client.js";
import { isAuthError } from "../api/client.js";
import type { SkillRow, SkillsResponse } from "../api/types.js";
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
    const body = await getJson<SkillsResponse>("/api/skills");
    skills.value = body.skills ?? [];
  } catch (e) {
    if (isAuthError(e)) return;
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
        <span class="btn-label">Refresh</span>
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
            <th class="col-updated">Updated</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in skills" :key="s.name" class="row" @click="open(s.name)">
            <td data-label="Name">
              <span class="skill-name mono">{{ s.name }}</span>
            </td>
            <td data-label="Description"><span class="desc muted">{{ s.description }}</span></td>
            <td class="col-updated muted" data-label="Updated">{{ s.updated_at ? s.updated_at.replace("T", " ").slice(0, 16) : "—" }}</td>
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
.col-updated {
  white-space: nowrap;
}
/* Clamp the description to a couple of lines everywhere — desktop table cell
 * and mobile card alike. Overflow trails off with an ellipsis; the full text
 * lives on the skill's detail/edit page (tap the row → "view all"). */
.desc {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

/* ---------- Mobile (≤768px) — card ----------
 * Each row is a wrapping flex row: Name (top-left) + Updated (top-right) share
 * the first line; the Description's 100% basis wraps it onto a full-width
 * second line. No label gutters — just the values. */
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
  /* Top row: Name left (semi-bold), Updated pushed to the right edge. */
  td[data-label="Name"] {
    flex: 0 0 auto;
    order: 1;
  }
  td[data-label="Name"] .skill-name {
    font-weight: var(--weight-semibold);
  }
  td[data-label="Updated"] {
    flex: 0 0 auto;
    order: 2;
    margin-left: auto;
    font-size: var(--text-xs);
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
