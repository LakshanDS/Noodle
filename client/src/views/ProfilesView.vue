<script setup lang="ts">
/**
 * Profiles list — a table of agent profiles inside the app shell. Each row opens
 * the editor; "New profile" opens the create form. All profiles are DB-managed
 * (created, edited, and deleted from the dashboard).
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getJson, ApiRequestError, isAuthError } from "../api/client.js";
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
    if (isAuthError(e)) return;
    loadError.value = e instanceof ApiRequestError ? e.message : "Could not load profiles.";
  } finally {
    loading.value = false;
  }
}

/** Sorted view of the list: the default profile is always first, then the rest
 *  alphabetically. Used in the template instead of raw `items`. */
const sortedItems = computed<ProfileListItem[]>(() => {
  const d = defaultProfile.value;
  const rest = [...items.value].sort((a, b) => a.name.localeCompare(b.name));
  if (!d) return rest;
  const def = rest.find((it) => it.name === d);
  if (!def) return rest;
  return [def, ...rest.filter((it) => it.name !== d)];
});

function open(name: string): void {
  void router.push({ name: "profile-detail", params: { name } });
}
function create(): void {
  void router.push({ name: "profile-new" });
}

/** Compact context-window label: 1048576 → "1M", 262144 → "256K". Falls back
 * to the raw number, or "—" when unset. */
function ctxLabel(ctx?: number): string {
  if (!ctx || ctx <= 0) return "—";
  if (ctx >= 1_000_000 && ctx % 1_000_000 === 0) return `${ctx / 1_000_000}M`;
  if (ctx >= 1000 && ctx % 1000 === 0) return `${Math.round(ctx / 1000)}K`;
  return String(ctx);
}

/** "$3.00"-style price for a per-1M-token value. Returns "" when unset (0). */
function priceLabel(v: number): string {
  if (!v || v <= 0) return "";
  return `$${v.toFixed(2)}`;
}

/** "in $3.00 / out $15.00" — only the non-zero halves render. "" when both 0. */
function inOutPrice(p: { input_token_price: number; output_token_price: number }): string {
  const inP = priceLabel(p.input_token_price);
  const outP = priceLabel(p.output_token_price);
  if (inP && outP) return `${inP} / ${outP}`;
  return inP || outP;
}

/** Whether any non-cache price is set — used to decide if the price cell shows. */
function hasPrice(p: {
  input_token_price: number;
  output_token_price: number;
}): boolean {
  return p.input_token_price > 0 || p.output_token_price > 0;
}

onMounted(load);
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="ghost" size="sm" icon="refresh" :loading="loading" @click="load">
        <span class="btn-label">Refresh</span>
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
            <th class="col-ctx">Context</th>
            <th class="col-price">Price (in/out · per 1M)</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="it in sortedItems" :key="it.name" class="row" @click="open(it.name)">
            <td class="col-name" data-label="Name">
              <div class="name-stack">
                <span class="prof-name" @click.stop="open(it.name)">{{ it.name }}</span>
                <span v-if="it.name === defaultProfile" class="default-badge">default</span>
              </div>
            </td>
            <td data-label="Model">
              <span class="mono sm">{{ it.profile.model }}</span>
            </td>
            <td class="col-ctx" data-label="Context">
              <span class="ctx-chip">{{ ctxLabel(it.profile.context_window) }}</span>
            </td>
            <td class="col-price" data-label="Price">
              <span v-if="hasPrice(it.profile)" class="mono sm price">{{ inOutPrice(it.profile) }}</span>
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
.col-name {
  white-space: nowrap;
}
.name-stack {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.prof-name {
  font-weight: var(--weight-medium);
  color: var(--text);
  cursor: pointer;
}
.default-badge {
  display: inline-block;
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
.col-ctx {
  white-space: nowrap;
}
.col-price {
  white-space: nowrap;
  text-align: right;
}
/* Compact context-window badge. */
.ctx-chip {
  display: inline-block;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--text-2);
  background: var(--surface-4);
  border-radius: var(--radius-sm);
  padding: 2px 7px;
}
.price {
  color: var(--text-2);
}

/* ---------- Mobile (≤768px) — card (mirrors Skills) ----------
 * Top line: Name (left, semi-bold) + Context chip (right). Below: provider ·
 * model, then the in/out price line (only if a price is set). */
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
    column-gap: var(--space-3);
    row-gap: var(--space-1);
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
  /* Two-column card. Left column: Name (top), Model (below).
   * Right column: Context (top), Price (below) — right-aligned. */
  td[data-label="Name"] {
    grid-column: 1;
    grid-row: 1;
  }
  td[data-label="Name"] .prof-name {
    font-weight: var(--weight-semibold);
  }
  td[data-label="Model"] {
    grid-column: 1;
    grid-row: 2;
  }
  td[data-label="Context"] {
    grid-column: 2;
    grid-row: 1;
    text-align: right;
    justify-self: end;
  }
  td[data-label="Price"] {
    grid-column: 2;
    grid-row: 2;
    text-align: right;
    justify-self: end;
  }
}
</style>
