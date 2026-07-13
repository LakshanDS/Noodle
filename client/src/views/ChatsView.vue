<script setup lang="ts">
/**
 * Chats list — a mock-backed list of agent conversations. Mirrors the CronsView
 * pattern (AppShell + #actions + three-state body) but pulls from the in-memory
 * mock store instead of the real API. Each row opens the full thread in
 * ChatDetailView. Swap `mock*` for real `getJson` calls once the backend lands.
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { mockListChats, type MockChat } from "../lib/mock.js";
import { fmtTime } from "../lib/format.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import EmptyState from "../components/ui/EmptyState.vue";

const router = useRouter();
const chats = ref<MockChat[]>([]);
const loading = ref(false);
const loadError = ref("");

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const body = await mockListChats();
    chats.value = body.chats ?? [];
  } catch {
    loadError.value = "Could not load chats.";
  } finally {
    loading.value = false;
  }
}

function open(id: string): void {
  void router.push({ name: "chat-detail", params: { id } });
}
function create(): void {
  void router.push({ name: "chat-new" });
}

onMounted(load);
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="ghost" size="sm" icon="refresh" :loading="loading" @click="load">
        Refresh
      </Button>
      <Button variant="primary" size="sm" icon="plus" @click="create">New chat</Button>
    </template>

    <div v-if="loadError" class="banner err">{{ loadError }}</div>

    <div v-if="loading && chats.length === 0" class="loading-row">Loading chats…</div>

    <EmptyState
      v-else-if="chats.length === 0"
      icon="message"
      title="No chats yet"
      desc="Start a conversation with the agent and it will appear here."
    >
      <Button variant="primary" icon="plus" @click="create">New chat</Button>
    </EmptyState>

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="col-status"></th>
            <th>Conversation</th>
            <th class="col-time">Last active</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in chats" :key="c.id" class="row" @click="open(c.id)">
            <td class="col-status" data-label=""><span class="dot" /></td>
            <td data-label="Conversation">
              <div class="chat-cell">
                <span class="chat-title">{{ c.title }}</span>
                <span class="chat-preview">{{ c.preview || "No messages yet" }}</span>
              </div>
            </td>
            <td class="col-time muted" data-label="Last active">{{ fmtTime(c.updated_at) }}</td>
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

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  display: inline-block;
}

.chat-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.chat-title {
  font-weight: var(--weight-medium);
  color: var(--text);
}
.chat-preview {
  font-size: var(--text-xs);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 520px;
}

.col-status {
  width: 1%;
  white-space: nowrap;
}
.col-time {
  white-space: nowrap;
}

/* ---------- Mobile (≤768px) — stacked cards ---------- */
@media (max-width: 768px) {
  .table-wrap {
    background: transparent;
    border: none;
    border-radius: 0;
  }
  .table,
  tbody,
  tr,
  td {
    display: block;
  }
  thead {
    display: none;
  }
  tr.row {
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
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-1) 0;
    border-bottom: none;
  }
  td::before {
    content: attr(data-label);
    flex: 0 0 92px;
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: var(--tracking-caps);
    color: var(--text-3);
    font-weight: var(--weight-medium);
  }
  /* Status dot column — no inline label, shrink to a tight indicator. */
  td[data-label=""]::before {
    content: none;
  }
  .col-status {
    width: auto;
  }
  /* Let the preview wrap instead of truncating off-screen. */
  .chat-preview {
    white-space: normal;
    max-width: none;
  }
}
</style>
