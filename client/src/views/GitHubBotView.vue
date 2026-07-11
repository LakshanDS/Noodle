<script setup lang="ts">
/**
 * GitHub bot — credentials the agent uses to talk to GitHub. Same DB-backed
 * settings store as the Settings page (GET/PUT /api/settings), filtered to the
 * GitHub keys only (GITHUB_* + NOODLE_LOGIN). Secrets mask on GET and send only
 * when edited. All of these require a restart to take effect — they're read once
 * at boot — so a restart banner shows after every successful save.
 */
import { computed, onMounted, reactive, ref } from "vue";
import { getJson, sendJson, ApiRequestError } from "../api/client.js";
import type { SettingsResponse, SettingsPutResponse, SettingMeta } from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Field from "../components/ui/Field.vue";
import Icon from "../components/ui/Icon.vue";

interface FieldState {
  meta: SettingMeta;
  value: string;
  dirty: boolean;
  revealed: boolean;
}

const catalog = ref<SettingMeta[]>([]);
const fields = reactive<Record<string, FieldState>>({});
const loading = ref(false);
const saving = ref(false);
const banner = ref<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);

/** A key belongs here if it's a GitHub credential or the agent's bot login. */
function isGithubKey(key: string): boolean {
  return key.startsWith("GITHUB_") || key === "NOODLE_LOGIN";
}

const githubKeys = computed(() => catalog.value.filter((m) => isGithubKey(m.key)));

async function load(): Promise<void> {
  loading.value = true;
  banner.value = null;
  try {
    const body = await getJson<SettingsResponse>("/api/settings");
    catalog.value = body.catalog;
    for (const k of Object.keys(fields)) delete fields[k];
    for (const meta of body.catalog.filter((m) => isGithubKey(m.key))) {
      fields[meta.key] = {
        meta,
        value: body.values[meta.key] ?? "",
        dirty: false,
        revealed: !meta.secret,
      };
    }
  } catch (e) {
    banner.value = { kind: "err", text: e instanceof ApiRequestError ? e.message : "Could not load GitHub settings." };
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
    // Every GitHub key is restart-required, so this always warns.
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

    <div v-if="loading" class="loading-row">Loading GitHub settings…</div>

    <div v-else class="sections">
      <Card>
        <template #header>
          <div class="sec-head">
            <span class="sec-icon"><Icon name="github" :size="15" /></span>
            <h3 class="sec-title">GitHub credentials</h3>
          </div>
        </template>

        <p class="sec-desc">
          Credentials the agent uses to clone, push, and open PRs. Use either a Personal Access
          Token (PAT) or a GitHub App (App ID + private key). Real environment variables override
          values stored here.
        </p>

        <Field
          v-for="meta in githubKeys"
          :key="meta.key"
          :label="meta.label"
          :hint="meta.hint"
        >
          <div class="input-row">
            <textarea
              v-if="meta.key === 'GITHUB_PRIVATE_KEY'"
              v-model="fields[meta.key]!.value"
              :type="fields[meta.key]?.revealed ? 'text' : 'password'"
              class="ctrl mono key-area"
              :placeholder="meta.secret ? 'Not set' : ''"
              autocomplete="off"
              rows="4"
              @input="onInput(meta.key)"
            />
            <input
              v-else
              v-model="fields[meta.key]!.value"
              :type="!meta.secret || fields[meta.key]?.revealed ? 'text' : 'password'"
              class="ctrl"
              :class="{ mono: meta.secret }"
              :placeholder="meta.secret ? 'Not set' : ''"
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
      </Card>

      <p class="foot-note">
        All of these are read once at boot, so changes take effect after a restart.
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

.foot-note {
  font-size: var(--text-xs);
  color: var(--text-3);
  line-height: var(--leading-normal);
  padding: 0 var(--space-2);
}
</style>
