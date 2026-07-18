<script setup lang="ts">
/**
 * Settings — sectioned cards for editing ALL DB-backed instance configuration.
 * Catalog-driven from the server; secret fields mask on GET and send only when
 * edited. A top banner surfaces after a write, flagging whether a restart is
 * needed. JSON fields (routing, trigger_keywords, scheduler_repos) render as
 * textareas for multi-line editing.
 */
import { computed, onMounted, reactive, ref } from "vue";
import { getJson, sendJson, ApiRequestError, isAuthError } from "../api/client.js";
import type { SettingsResponse, SettingsPutResponse, SettingMeta, CreateAppResponse } from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Field from "../components/ui/Field.vue";
import Icon from "../components/ui/Icon.vue";
import LabelEditor from "../components/LabelEditor.vue";
import type { LabelField } from "../components/LabelEditor.vue";
import type { IconName } from "../components/ui/Icon.vue";

interface FieldState {
  meta: SettingMeta;
  value: string;
  dirty: boolean;
  revealed: boolean;
}

const catalog = ref<SettingMeta[]>([]);
const fields = reactive<Record<string, FieldState>>({});
const restartKeys = ref<string[]>([]);
const loading = ref(false);
const saving = ref(false);
const banner = ref<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);

// GitHub App creation flow.
const showAppForm = ref(false);
const botName = ref("");
const creating = ref(false);
const appError = ref<string | null>(null);

/** Keys that store multi-line text (JSON arrays, long prompts, PEM keys) — render as textareas. */
const JSON_FIELDS = new Set(["routing", "trigger_keywords", "system_prompt", "GITHUB_PRIVATE_KEY"]);
function isJsonField(key: string): boolean {
  return JSON_FIELDS.has(key);
}

/** Placeholder text shown inside an empty field. Only these two JSON fields get
 * a concrete example; everything else falls back to "Not set" (secrets) or blank. */
const PLACEHOLDERS: Record<string, string> = {
  routing: '[{"kind":"slash","match":"/claude","profile":"claude"}]',
  trigger_keywords: '["agent-fix"]',
};
function placeholderFor(key: string, secret: boolean): string {
  if (PLACEHOLDERS[key]) return PLACEHOLDERS[key];
  return secret ? "Not set" : "";
}

/** Keys stored as "true"/"false" strings — render as a toggle switch instead of a text input.
 * Maps to the schema default used when the DB has no stored value yet. */
const BOOLEAN_DEFAULTS: Record<string, boolean> = {
  trigger_on_mention: true,
  trigger_on_open: false,
};
const BOOLEAN_SETTINGS = new Set(Object.keys(BOOLEAN_DEFAULTS));
function isBooleanSetting(key: string): boolean {
  return BOOLEAN_SETTINGS.has(key);
}
/** Read a boolean field as a real boolean. An unset (empty) value falls back to
 * the schema default, so a fresh install shows mention=on / open=off correctly. */
function boolVal(key: string): boolean {
  const v = fields[key]?.value;
  if (v === "true") return true;
  if (v === "false") return false;
  return BOOLEAN_DEFAULTS[key] ?? false;
}
/** Toggle a boolean field between "true"/"false" and mark it dirty. */
function toggleBool(key: string): void {
  if (!fields[key]) return;
  fields[key].value = boolVal(key) ? "false" : "true";
  fields[key].dirty = true;
}

// --- GitHub labels editor (3 status labels: cooking/cooked/failed). ----------
// The `labels` settings key stores a JSON string. We parse it into a 3-entry
// array for <LabelEditor>; any edit re-serializes + marks the field dirty. The
// editor component owns the rows + color picker; this is just the storage
// adapter. Index order is the contract: [Start (cooking), Finished (cooked), Failed (failed)].
const DEFAULT_LABELS = {
  cooking: { name: "Noodle is cooking", color: "d4a942" },
  cooked: { name: "Noodle cooked here", color: "6fae6f" },
  failed: { name: "Noodle got Cooked", color: "c76b6b" },
};
const labelFields = computed<LabelField[]>({
  get() {
    const raw = fields["labels"]?.value;
    let parsed: typeof DEFAULT_LABELS = DEFAULT_LABELS;
    if (raw) {
      try { parsed = { ...DEFAULT_LABELS, ...(JSON.parse(raw) as typeof DEFAULT_LABELS) }; } catch { /* defaults */ }
    }
    return [parsed.cooking, parsed.cooked, parsed.failed];
  },
  set(rows: LabelField[]) {
    if (!fields["labels"] || rows.length < 3) return;
    fields["labels"].value = JSON.stringify({
      cooking: { name: rows[0].name, color: rows[0].color },
      cooked: { name: rows[1].name, color: rows[1].color },
      failed: { name: rows[2].name, color: rows[2].color },
    });
    fields["labels"].dirty = true;
  },
});

// Group icon + copy for each section.
const SECTIONS = [
  { key: "access", title: "Dashboard access", icon: "lock" as IconName, desc: "The password for this dashboard and the public URL GitHub reaches Noodle at." },
  { key: "github", title: "GitHub connection", icon: "github" as IconName, desc: "Connect Noodle to GitHub to open PRs and receive issue events. Create a GitHub App or use a Personal Access Token." },
  { key: "labels", title: "GitHub labels", icon: "tag" as IconName, desc: "The 3 status labels applied to issues during a run — when the agent starts, finishes, or fails. Each command can override these with its own labels." },
  { key: "agent", title: "Agent & triggers", icon: "bolt" as IconName, desc: "The system prompt and wake filters for incoming issues (keywords, mention, open). Changes apply immediately." },
  { key: "routing", title: "Routing & queue", icon: "branch" as IconName, desc: "Routing rules, queue retry settings, and run timeouts. All knobs apply live on save. Per-profile concurrency is set on each profile." },
];

function sectionOf(meta: SettingMeta): string {
  if (meta.key === "labels") return "labels";
  if (meta.key.startsWith("GITHUB_") || meta.key === "NOODLE_LOGIN") return "github";
  if (meta.key.startsWith("trigger_") || meta.key === "system_prompt") return "agent";
  if (meta.key === "routing" || meta.key.startsWith("queue_") || meta.key.startsWith("run_")) return "routing";
  if (meta.key === "default_profile") return "routing";
  if (meta.key.startsWith("NOODLE_")) return "access";
  return "access";
}

/**
 * Keys that render as compact numeric fields in the routing section's 2-column
 * grid (queue retry knobs + run timeouts). Full-width fields like the routing
 * textarea stay in the normal `items` flow above the grid.
 */
const GRID_KEYS = new Set([
  "queue_max_attempts",
  "queue_retry_backoff_seconds",
  "run_stall_timeout_minutes",
  "run_tool_stall_minutes",
]);
function isGridField(key: string): boolean {
  return GRID_KEYS.has(key);
}

const grouped = computed(() =>
  SECTIONS.map((s) => {
    const all = catalog.value.filter((m) => {
      if (sectionOf(m) !== s.key) return false;
      // GitHub App fields are rendered by the special App section template.
      if (s.key === "github" && GITHUB_APP_KEYS.has(m.key)) return false;
      // The `labels` key is rendered by the custom labels-section block (3
      // name+color rows), not the generic field loop.
      if (m.key === "labels") return false;
      return true;
    });
    return {
      ...s,
      // Boolean settings (the two trigger toggles) render together on one row,
      // after the other fields. Split them out so the template can group them.
      items: all.filter((m) => !isBooleanSetting(m.key) && !isGridField(m.key)),
      gridItems: all.filter((m) => isGridField(m.key)),
      boolItems: all.filter((m) => isBooleanSetting(m.key)),
    };
  }).filter((s) => s.key === "github" || s.key === "labels" || s.items.length > 0 || s.gridItems.length > 0 || s.boolItems.length > 0),
);

async function load(): Promise<void> {
  loading.value = true;
  banner.value = null;
  try {
    const body = await getJson<SettingsResponse>("/api/settings");
    catalog.value = body.catalog;
    restartKeys.value = body.restartKeys;
    // Reset fields map.
    for (const k of Object.keys(fields)) delete fields[k];
    for (const meta of body.catalog) {
      fields[meta.key] = {
        meta,
        value: body.values[meta.key] ?? "",
        dirty: false,
        revealed: !meta.secret,
      };
    }
  } catch (e) {
    if (isAuthError(e)) return;
    banner.value = { kind: "err", text: e instanceof ApiRequestError ? e.message : "Could not load settings." };
  } finally {
    loading.value = false;
  }
}

function onInput(key: string): void {
  if (fields[key]) fields[key].dirty = true;
}

async function save(): Promise<void> {
  saving.value = true;
  banner.value = null;
  const values: Record<string, string> = {};
  for (const [key, f] of Object.entries(fields)) {
    if (f.dirty) values[key] = f.value;
  }
  if (Object.keys(values).length === 0) {
    banner.value = { kind: "ok", text: "Nothing to save." };
    saving.value = false;
    return;
  }
  try {
    const body = await sendJson<SettingsPutResponse>("/api/settings", "PUT", { values });
    banner.value = body.needsRestart
      ? { kind: "warn", text: `Saved. Restart Noodle to apply: ${body.restartKeys.join(", ")}.` }
      : { kind: "ok", text: "Saved." };
    await load();
  } catch (e) {
    if (isAuthError(e)) return;
    banner.value = { kind: "err", text: e instanceof ApiRequestError ? e.message : "Could not reach server" };
  } finally {
    saving.value = false;
  }
}

function toggleReveal(key: string): void {
  if (fields[key]) fields[key].revealed = !fields[key].revealed;
}

const anyDirty = computed(() => Object.values(fields).some((f) => f.dirty));

/** Whether a GitHub App is already configured (has an App ID set). */
const hasGitHubApp = computed(() => {
  const f = fields["GITHUB_APP_ID"];
  return f && f.value && f.value !== "" && !f.value.startsWith("••••");
});

/** Fields to hide from the normal catalog rendering (handled by the GitHub App section). */
const GITHUB_APP_KEYS = new Set(["GITHUB_APP_ID", "GITHUB_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_SETUP_STATE", "NOODLE_LOGIN"]);

async function createApp(): Promise<void> {
  if (!botName.value.trim()) {
    appError.value = "Bot name is required.";
    return;
  }
  creating.value = true;
  appError.value = null;
  try {
    // Use the browser's current origin — works behind reverse proxies too.
    const origin = window.location.origin;
    // `origin` is the string "null" in sandboxed iframes / file: / data:
    // contexts; bail early with an actionable message rather than letting the
    // server build a manifest GitHub will reject.
    if (!origin || origin === "null" || !/^https?:\/\//.test(origin)) {
      appError.value = "Cannot determine the dashboard URL from this page. Open Noodle directly via its http(s) address (e.g. https://noodle.example.com) and try again.";
      return;
    }
    const body = await sendJson<CreateAppResponse>("/api/github/create-app", "POST", { name: botName.value.trim(), url: origin });
    // GitHub requires the manifest to be POSTed via a hidden form.
    // Open in a new tab so the user doesn't lose the Settings page.
    const win = window.open("", "_blank");
    if (!win) {
      appError.value = "Pop-up blocked. Allow pop-ups for this site and try again.";
      return;
    }
    const form = win.document.createElement("form");
    form.method = "POST";
    form.action = "https://github.com/settings/apps/new";
    const stateInput = win.document.createElement("input");
    stateInput.type = "hidden";
    stateInput.name = "state";
    stateInput.value = body.state;
    form.appendChild(stateInput);
    const manifestInput = win.document.createElement("input");
    manifestInput.type = "hidden";
    manifestInput.name = "manifest";
    manifestInput.value = JSON.stringify(body.manifest);
    form.appendChild(manifestInput);
    win.document.body.appendChild(form);
    form.submit();
    // Reload settings when the user comes back to this tab.
    const onFocus = () => {
      window.removeEventListener("focus", onFocus);
      setTimeout(load, 1000);
    };
    window.addEventListener("focus", onFocus);
  } catch (e) {
    if (isAuthError(e)) return;
    appError.value = e instanceof ApiRequestError ? e.message : "Could not start GitHub App creation.";
  } finally {
    creating.value = false;
  }
}

onMounted(load);
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="primary" size="sm" icon="check" :loading="saving" :disabled="!anyDirty" @click="save">
        Save changes
      </Button>
    </template>

    <div v-if="banner" class="banner" :class="banner.kind">
      <Icon :name="banner.kind === 'err' ? 'alert' : 'check'" :size="15" />
      <span>{{ banner.text }}</span>
    </div>

    <div v-if="loading" class="loading-row">Loading settings…</div>

    <div v-else class="sections">
      <Card v-for="section in grouped" :key="section.key">
        <template #header>
          <div class="sec-head">
            <span class="sec-icon"><Icon :name="section.icon" :size="15" /></span>
            <h3 class="sec-title">{{ section.title }}</h3>
          </div>
        </template>

        <p class="sec-desc">{{ section.desc }}</p>

        <!-- GitHub section: special rendering for App setup + regular fields -->
        <template v-if="section.key === 'github'">
          <!-- GitHub App status / creation -->
          <div class="app-section">
            <div v-if="hasGitHubApp" class="app-status">
              <div class="app-connected">
                <Icon name="check" :size="14" />
                <span>GitHub App connected (ID: {{ fields['GITHUB_APP_ID']?.value }})</span>
              </div>
              <Button variant="ghost" size="sm" @click="showAppForm = !showAppForm">
                {{ showAppForm ? 'Cancel' : 'Reconfigure' }}
              </Button>
            </div>

            <div v-if="!hasGitHubApp || showAppForm" class="app-form">
              <p class="app-form-desc">
                Create a GitHub App to let Noodle open PRs and receive issue events.
                You'll be redirected to GitHub to confirm.
              </p>
              <div class="app-form-row">
                <input
                  v-model="botName"
                  type="text"
                  class="ctrl"
                  placeholder="e.g. my-repo-bot"
                  autocomplete="off"
                  @keydown.enter="createApp"
                />
                <Button
                  variant="primary"
                  icon="github"
                  :loading="creating"
                  :disabled="!botName.trim()"
                  @click="createApp"
                >
                  Create GitHub App
                </Button>
              </div>
              <p v-if="appError" class="app-hint err">
                <Icon name="alert" :size="12" /> {{ appError }}
              </p>
            </div>
          </div>

          <!-- PAT fallback -->
          <div class="pat-divider">
            <span>or use a Personal Access Token</span>
          </div>
          <Field v-if="fields['GITHUB_TOKEN']" label="GitHub token (PAT)" hint="A PAT with repo (or fine-grained contents/pull-requests/issues) scope.">
            <div class="input-row">
              <input
                v-model="fields['GITHUB_TOKEN']!.value"
                :type="fields['GITHUB_TOKEN']?.revealed ? 'text' : 'password'"
                class="ctrl mono"
                placeholder="Not set"
                autocomplete="off"
                @input="onInput('GITHUB_TOKEN')"
              />
              <button
                v-if="fields['GITHUB_TOKEN']?.value"
                class="reveal"
                type="button"
                @click="toggleReveal('GITHUB_TOKEN')"
              >
                {{ fields['GITHUB_TOKEN']?.revealed ? "Hide" : "Reveal" }}
              </button>
            </div>
          </Field>
        </template>

        <!-- GitHub labels section: 3 status labels (name + color picker). -->
        <template v-else-if="section.key === 'labels'">
          <LabelEditor v-model="labelFields" />
        </template>

        <!-- Non-GitHub sections: normal field rendering -->
        <template v-else>
          <Field
            v-for="meta in section.items"
            :key="meta.key"
            :label="meta.label"
            :hint="meta.hint"
          >
            <div class="input-row">
              <textarea
                v-if="isJsonField(meta.key)"
                v-model="fields[meta.key]!.value"
                :type="fields[meta.key]?.revealed ? 'text' : 'password'"
                class="ctrl mono key-area"
                :placeholder="placeholderFor(meta.key, meta.secret)"
                autocomplete="off"
                :rows="meta.key === 'GITHUB_PRIVATE_KEY' ? 4 : 3"
                @input="onInput(meta.key)"
              />
              <input
                v-else
                v-model="fields[meta.key]!.value"
                :type="!meta.secret || fields[meta.key]?.revealed ? 'text' : 'password'"
                class="ctrl"
                :class="{ mono: meta.secret }"
                :placeholder="placeholderFor(meta.key, meta.secret)"
                autocomplete="off"
                @input="onInput(meta.key)"
              />
              <button
                v-if="meta.secret && fields[meta.key]?.value && meta.key !== 'GITHUB_PRIVATE_KEY'"
                class="reveal"
                type="button"
                @click="toggleReveal(meta.key)"
              >
                {{ fields[meta.key]?.revealed ? "Hide" : "Reveal" }}
              </button>
            </div>
            <div v-if="meta.restartRequired" class="restart-tag">
              <Icon name="refresh" :size="11" /> Restart required
            </div>
          </Field>

          <!-- Compact numeric knobs (queue retry + run timeouts) in a 2-column grid:
               row 1: queue_max_attempts | queue_retry_backoff_seconds
               row 2: run_stall_timeout_minutes | run_tool_stall_minutes -->
          <div v-if="section.gridItems.length > 0" class="knob-grid">
            <Field
              v-for="meta in section.gridItems"
              :key="meta.key"
              :label="meta.label"
              :hint="meta.hint"
            >
              <input
                v-model="fields[meta.key]!.value"
                type="number"
                class="ctrl mono"
                :placeholder="meta.secret ? 'Not set' : ''"
                autocomplete="off"
                @input="onInput(meta.key)"
              />
              <div v-if="meta.restartRequired" class="restart-tag">
                <Icon name="refresh" :size="11" /> Restart required
              </div>
            </Field>
          </div>

          <!-- Boolean toggles grouped on one row (the two trigger switches). -->
          <div v-if="section.boolItems.length > 0" class="triggers-field">
            <div class="toggle-pair">
              <div v-for="meta in section.boolItems" :key="meta.key" class="toggle-cell">
                <div class="toggle-top">
                  <button
                    type="button"
                    class="toggle"
                    :class="{ on: boolVal(meta.key) }"
                    :aria-pressed="boolVal(meta.key)"
                    @click="toggleBool(meta.key)"
                  >
                    <span class="toggle-knob"></span>
                  </button>
                  <span class="toggle-label">{{ meta.label }}</span>
                </div>
                <p v-if="meta.hint" class="toggle-hint">{{ meta.hint }}</p>
              </div>
            </div>
          </div>
        </template>
      </Card>

    </div>
  </AppShell>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  margin-bottom: var(--space-4);
}
.banner :deep(svg) {
  flex: 0 0 auto;
}
.banner.ok {
  background: var(--success-weak);
  color: var(--success);
}
.banner.warn {
  background: var(--warning-weak);
  color: var(--warning);
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

.sections {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.sec-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.sec-icon {
  display: flex;
  color: var(--accent);
}
.sec-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
}
.sec-desc {
  font-size: var(--text-xs);
  color: var(--text-3);
  margin-bottom: var(--space-5);
  line-height: var(--leading-normal);
}

/* 2-column grid for the compact numeric knobs (queue retry + run timeouts).
 * Collapses to a single column on narrow screens (mobile). */
.knob-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-3) var(--space-4);
}
.knob-grid :deep(.field) {
  margin-bottom: 0;
}
.knob-grid .restart-tag {
  margin-top: 4px;
}
@media (max-width: 540px) {
  .knob-grid {
    grid-template-columns: 1fr;
  }
}

/* GitHub labels editor — rendered by the shared <LabelEditor> component. */

/* Toggle switches for the two trigger booleans, grouped side-by-side on one row. */
.toggle-pair {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.toggle-cell {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}
.toggle-top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.toggle-label {
  font-size: var(--text-sm);
  color: var(--text);
  font-weight: var(--weight-medium);
}
.toggle-hint {
  margin: 0;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--text-3);
}
.toggle {
  position: relative;
  width: 38px;
  height: 22px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border);
  background: var(--surface-3);
  padding: 0;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
  flex: 0 0 auto;
}
.toggle .toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--text-2);
  transition: transform var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.toggle.on {
  background: var(--accent);
  border-color: var(--accent);
}
.toggle.on .toggle-knob {
  transform: translateX(16px);
  background: #000;
}

.input-row {
  position: relative;
  display: flex;
  align-items: center;
}
.input-row .ctrl {
  padding-right: 64px;
}
.input-row .key-area {
  padding-right: var(--space-3);
  resize: vertical;
}
.reveal {
  position: absolute;
  right: 8px;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--text-3);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  transition: color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.reveal:hover {
  color: var(--text);
  background: var(--surface-3);
}

.restart-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--warning);
  background: var(--warning-weak);
  padding: 2px 8px;
  border-radius: var(--radius-full);
}

/* GitHub App creation section */
.app-section {
  margin: var(--space-4) 0;
}
.app-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--success-weak);
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
}
.app-connected {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--success);
}
.app-form {
  padding: var(--space-4);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.app-form-desc {
  font-size: var(--text-xs);
  color: var(--text-3);
  margin-bottom: var(--space-3);
  line-height: var(--leading-normal);
}
.app-form-row {
  display: flex;
  align-items: stretch;
  gap: var(--space-2);
}
.app-form-row .ctrl {
  flex: 1;
}
.app-hint {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  margin-top: var(--space-2);
  line-height: var(--leading-normal);
}
.app-hint.warn {
  color: var(--warning);
}
.app-hint.err {
  color: var(--danger);
}
.pat-divider {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-5) 0 var(--space-3);
  font-size: var(--text-xs);
  color: var(--text-3);
}
.pat-divider::before,
.pat-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border);
}

@media (max-width: 480px) {
  .app-form-row {
    flex-direction: column;
  }
  .app-status {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>

