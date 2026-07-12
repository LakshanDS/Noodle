<script setup lang="ts">
/**
 * Settings — sectioned cards for editing DB-backed instance secrets. Catalog-
 * driven from the server; secret fields mask on GET and send only when edited.
 * A top banner surfaces after a write, flagging whether a restart is needed.
 *
 * GitHub bot credentials live in their own tab (GitHubBotView); the GitHub
 * keys are filtered out here so they aren't editable in two places.
 */
import { computed, onMounted, reactive, ref } from "vue";
import { getJson, sendJson, ApiRequestError } from "../api/client.js";
import type { SettingsResponse, SettingsPutResponse, SettingMeta } from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Field from "../components/ui/Field.vue";
import Icon from "../components/ui/Icon.vue";
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

// Group icon + copy for each section.
const SECTIONS = [
  { key: "llm", title: "LLM API keys", icon: "key" as IconName, desc: "Provider keys, read per-request. New runs pick these up immediately — no restart needed." },
  { key: "access", title: "Dashboard access", icon: "lock" as IconName, desc: "The dashboard password and the agent's GitHub login. Restart required." },
];

/** GitHub keys are owned by the GitHub bot tab — exclude them here. */
function isGithubKey(key: string): boolean {
  return key.startsWith("GITHUB_") || key === "NOODLE_LOGIN";
}

function sectionOf(meta: SettingMeta): string {
  if (meta.key.endsWith("_API_KEY") && !meta.key.startsWith("GITHUB_")) return "llm";
  if (meta.key.startsWith("NOODLE_")) return "access";
  return "llm";
}

const grouped = computed(() =>
  SECTIONS.map((s) => ({
    ...s,
    items: catalog.value.filter((m) => !isGithubKey(m.key) && sectionOf(m) === s.key),
  })).filter((s) => s.items.length > 0),
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
    for (const meta of body.catalog.filter((m) => !isGithubKey(m.key))) {
      fields[meta.key] = {
        meta,
        value: body.values[meta.key] ?? "",
        dirty: false,
        revealed: !meta.secret,
      };
    }
  } catch (e) {
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
    banner.value = { kind: "err", text: e instanceof ApiRequestError ? e.message : "Could not reach server" };
  } finally {
    saving.value = false;
  }
}

function toggleReveal(key: string): void {
  if (fields[key]) fields[key].revealed = !fields[key].revealed;
}

const anyDirty = computed(() => Object.values(fields).some((f) => f.dirty));

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

        <Field
          v-for="meta in section.items"
          :key="meta.key"
          :label="meta.label"
          :hint="meta.hint"
        >
          <div class="input-row">
            <input
              v-model="fields[meta.key]!.value"
              :type="!meta.secret || fields[meta.key]?.revealed ? 'text' : 'password'"
              class="ctrl"
              :class="{ mono: meta.secret }"
              :placeholder="meta.secret ? 'Not set' : ''"
              autocomplete="off"
              @input="onInput(meta.key)"
            />
            <button
              v-if="meta.secret && fields[meta.key]?.value"
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
      </Card>

      <p class="foot-note">
        Real environment variables always override values stored here. Edit
        <code>noodle.config.yaml</code> for profiles, routing rules, and triggers.
      </p>
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
  max-width: 680px;
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

.input-row {
  position: relative;
  display: flex;
  align-items: center;
}
.input-row .ctrl {
  padding-right: 64px;
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

.foot-note {
  font-size: var(--text-xs);
  color: var(--text-3);
  line-height: var(--leading-normal);
  padding: 0 var(--space-2);
}
.foot-note code {
  font-family: var(--font-mono);
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
}
</style>
