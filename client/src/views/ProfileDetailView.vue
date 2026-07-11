<script setup lang="ts">
/**
 * Profile create/edit form. Exposes every field of ProfileData (the engine's
 * per-run config), grouped by purpose into cards. Save creates (POST) or updates
 * (PATCH); after a create we navigate to the edit route so a subsequent save
 * PATCHes. YAML-only profiles are loaded read-write — on save they're promoted
 * to a DB row (the DB override takes precedence over the YAML on every boot).
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getJson, sendJson, ApiRequestError } from "../api/client.js";
import type {
  ProfileDetailResponse,
  ProfileMutationResponse,
  ProfileData,
  ProfileInput,
  ProfileSource,
  Api,
  ThinkingLevel,
} from "../api/types.js";
import { BUILTIN_TOOLS } from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Field from "../components/ui/Field.vue";

const props = defineProps<{ name?: string; isNew?: boolean }>();
const router = useRouter();

const editing = computed(() => !props.isNew && props.name != null);

/** All wire protocols a custom endpoint can speak (mirrors Api in types). */
const APIS: Api[] = [
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "bedrock-converse-stream",
];

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Default profile used when creating from scratch (mirrors schema defaults). */
function emptyProfile(): ProfileData {
  return {
    provider: "",
    model: "",
    input_token_price: 0,
    output_token_price: 0,
    cache_read_price: 0,
    cache_write_price: 0,
    reasoning: false,
    thinking_level: "medium",
    tools: [...BUILTIN_TOOLS],
    api_rpm: 30,
    retry_max_attempts: 5,
    retry_base_delay_ms: 3000,
  };
}

const name = ref("");
const source = ref<ProfileSource>("db");
/** Copy of the name as loaded from the server — to detect renames. */
const originalName = ref("");
const form = ref<ProfileData>(emptyProfile());
const saving = ref(false);
const deleting = ref(false);
const loading = ref(false);
const errorMsg = ref("");
const infoMsg = ref("");

const isYaml = computed(() => source.value === "yaml");

/** Toggle a tool name in/out of the form.tools array. */
function toggleTool(tool: string): void {
  const tools = new Set(form.value.tools);
  if (tools.has(tool)) tools.delete(tool);
  else tools.add(tool);
  form.value.tools = [...tools];
}

async function load(): Promise<void> {
  if (!editing.value || props.name == null) {
    name.value = "";
    form.value = emptyProfile();
    return;
  }
  loading.value = true;
  errorMsg.value = "";
  try {
    const body = await getJson<ProfileDetailResponse>(`/api/profiles/${encodeURIComponent(props.name)}`);
    name.value = body.profile.name;
    originalName.value = body.profile.name;
    source.value = body.profile.source;
    form.value = { ...emptyProfile(), ...body.profile.profile };
  } catch (e) {
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Could not load profile.";
  } finally {
    loading.value = false;
  }
}

function payload(): ProfileInput | null {
  const p = form.value;
  // base_url ↔ api must travel together (cross-validation runs on the server
  // too, but catch it early for a snappier error).
  if (p.base_url && !p.api) {
    errorMsg.value = '"api" is required when "base_url" is set (custom endpoint).';
    return null;
  }
  if (p.api && !p.base_url) {
    errorMsg.value = '"base_url" is required when "api" is set (custom endpoint).';
    return null;
  }
  const trimmedName = name.value.trim();
  if (!trimmedName) {
    errorMsg.value = "Name is required.";
    return null;
  }
  if (!p.provider || !p.model) {
    errorMsg.value = "Provider and model are required.";
    return null;
  }
  // Build a clean profile: drop empty optional strings + NaN/blank numbers.
  const clean: ProfileData = {
    provider: p.provider.trim(),
    model: p.model.trim(),
    input_token_price: num(p.input_token_price),
    output_token_price: num(p.output_token_price),
    cache_read_price: num(p.cache_read_price),
    cache_write_price: num(p.cache_write_price),
    reasoning: !!p.reasoning,
    thinking_level: p.thinking_level,
    tools: p.tools,
    api_rpm: numOr(p.api_rpm, 0),
    retry_max_attempts: numOr(p.retry_max_attempts, 0),
    retry_base_delay_ms: numOr(p.retry_base_delay_ms, 0),
  };
  if (p.base_url?.trim()) clean.base_url = p.base_url.trim();
  if (p.api) clean.api = p.api;
  if (p.api_key_env?.trim()) clean.api_key_env = p.api_key_env.trim();
  if (p.context_window) clean.context_window = num(p.context_window);
  if (p.max_tokens) clean.max_tokens = num(p.max_tokens);
  if (p.system_prompt_file?.trim()) clean.system_prompt_file = p.system_prompt_file.trim();
  if (p.max_concurrent) clean.max_concurrent = num(p.max_concurrent);
  return { name: trimmedName, profile: clean };
}

/** Coerce to a finite number, else 0. */
function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}
/** Coerce to a finite number or fall back to `fallback`. */
function numOr(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
}

async function save(): Promise<void> {
  errorMsg.value = "";
  infoMsg.value = "";
  const body = payload();
  if (!body) return;
  saving.value = true;
  try {
    if (editing.value && props.name != null) {
      const res = await sendJson<ProfileMutationResponse>(
        `/api/profiles/${encodeURIComponent(props.name)}`,
        "PATCH",
        body,
      );
      // If the rename changed the URL param, navigate to the new one so a
      // subsequent save PATCHes the right path.
      if (res.profile.name !== props.name) {
        await router.replace({ name: "profile-detail", params: { name: res.profile.name } });
      } else {
        originalName.value = res.profile.name;
        source.value = res.profile.source;
      }
      infoMsg.value = "Saved.";
    } else {
      const res = await sendJson<ProfileMutationResponse>("/api/profiles", "POST", body);
      await router.replace({ name: "profile-detail", params: { name: res.profile.name } });
    }
  } catch (e) {
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Could not reach server";
  } finally {
    saving.value = false;
  }
}

async function deleteProfile(): Promise<void> {
  if (!editing.value || props.name == null) return;
  if (isYaml.value) {
    errorMsg.value = "YAML profiles can't be deleted from the dashboard — remove the entry in noodle.config.yaml.";
    return;
  }
  if (!confirm(`Delete profile "${props.name}"? Existing runs keep their resolved model.`)) return;
  deleting.value = true;
  errorMsg.value = "";
  try {
    await sendJson(`/api/profiles/${encodeURIComponent(props.name)}`, "DELETE");
    await router.replace({ name: "profiles" });
  } catch (e) {
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Could not reach server";
  } finally {
    deleting.value = false;
  }
}

watch(() => [props.name, props.isNew], () => void load());
onMounted(load);
</script>

<template>
  <AppShell>
    <template #actions>
      <Button variant="ghost" size="sm" icon="back" @click="router.back()">Back</Button>
      <Button
        v-if="editing"
        variant="ghost"
        size="sm"
        icon="refresh"
        :loading="loading"
        @click="load"
      >
        Refresh
      </Button>
    </template>

    <div v-if="loading" class="loading-row">Loading…</div>

    <div v-else class="profile-layout">
      <div class="form-col">
        <div v-if="isYaml" class="banner info">
          This profile is defined in your YAML config. Editing it promotes a DB override that
          takes precedence on every boot. Delete removes only the override.
        </div>
        <div v-if="errorMsg" class="banner err">{{ errorMsg }}</div>
        <div v-if="infoMsg" class="banner ok">{{ infoMsg }}</div>

        <!-- Identity -->
        <Card title="Identity">
          <Field label="Name" hint="The key jobs/crons reference, and the #&lt;name&gt; tag.">
            <input v-model="name" class="ctrl" type="text" placeholder="e.g. claude-fast" :disabled="isYaml && editing" />
          </Field>
          <Field label="Provider" hint="e.g. anthropic, openai, openrouter, ollama.">
            <input v-model="form.provider" class="ctrl" type="text" placeholder="anthropic" />
          </Field>
          <Field label="Model" hint="The model identifier the provider accepts.">
            <input v-model="form.model" class="ctrl" type="text" placeholder="claude-sonnet-4-20250514" />
          </Field>
        </Card>

        <!-- Custom endpoint -->
        <Card title="Custom endpoint">
          <Field label="Base URL" hint="Custom endpoint for OpenAI-compatible / proxy servers. Leave blank for built-in providers.">
            <input v-model="form.base_url" class="ctrl mono" type="text" placeholder="http://localhost:11434/v1" />
          </Field>
          <Field label="Wire protocol (api)" hint="Required when a base URL is set.">
            <select v-model="form.api" class="ctrl">
              <option :value="undefined">(none)</option>
              <option v-for="a in APIS" :key="a" :value="a">{{ a }}</option>
            </select>
          </Field>
          <Field label="API key env var" hint="Env var holding the key. Omit for no-auth local endpoints.">
            <input v-model="form.api_key_env" class="ctrl mono" type="text" placeholder="ANTHROPIC_API_KEY" />
          </Field>
        </Card>

        <!-- Model limits -->
        <Card title="Model limits">
          <Field label="Context window" hint="Token budget the model accepts (custom endpoints only).">
            <input v-model.number="form.context_window" class="ctrl" type="number" min="1" placeholder="32768" />
          </Field>
          <Field label="Max output tokens" hint="Cap on a single response (custom endpoints only).">
            <input v-model.number="form.max_tokens" class="ctrl" type="number" min="1" placeholder="8192" />
          </Field>
        </Card>

        <!-- Pricing -->
        <Card title="Token pricing (USD / 1M tokens)">
          <div class="grid-2">
            <Field label="Input">
              <input v-model.number="form.input_token_price" class="ctrl" type="number" min="0" step="0.01" placeholder="0" />
            </Field>
            <Field label="Output">
              <input v-model.number="form.output_token_price" class="ctrl" type="number" min="0" step="0.01" placeholder="0" />
            </Field>
            <Field label="Cache read">
              <input v-model.number="form.cache_read_price" class="ctrl" type="number" min="0" step="0.01" placeholder="0" />
            </Field>
            <Field label="Cache write">
              <input v-model.number="form.cache_write_price" class="ctrl" type="number" min="0" step="0.01" placeholder="0" />
            </Field>
          </div>
        </Card>

        <!-- Reasoning -->
        <Card title="Reasoning">
          <Field label="Supports reasoning" hint="Set true for thinking-capable models on custom endpoints.">
            <label class="toggle">
              <input type="checkbox" v-model="form.reasoning" />
              <span>{{ form.reasoning ? "On" : "Off" }}</span>
            </label>
          </Field>
          <Field label="Thinking level" hint="Forwarded only when reasoning is on (custom endpoints).">
            <select v-model="form.thinking_level" class="ctrl">
              <option v-for="l in THINKING_LEVELS" :key="l" :value="l">{{ l }}</option>
            </select>
          </Field>
        </Card>

        <!-- Tools -->
        <Card title="Tools">
          <p class="hint-block">Built-in tools this profile may use.</p>
          <div class="tools">
            <label v-for="t in BUILTIN_TOOLS" :key="t" class="tool">
              <input type="checkbox" :checked="form.tools.includes(t)" @change="toggleTool(t)" />
              <code>{{ t }}</code>
            </label>
          </div>
        </Card>

        <!-- System prompt -->
        <Card title="System prompt">
          <Field label="System prompt file" hint="Path to a custom system prompt file. Optional.">
            <input v-model="form.system_prompt_file" class="ctrl mono" type="text" placeholder="./prompts/claude.md" />
          </Field>
        </Card>

        <!-- Limits -->
        <Card title="Rate limits & retries">
          <div class="grid-2">
            <Field label="API requests / minute" hint="0 = unlimited. Throttles before each provider call.">
              <input v-model.number="form.api_rpm" class="ctrl" type="number" min="0" placeholder="30" />
            </Field>
            <Field label="Max retry attempts" hint="Agent-level retries after a failed LLM turn.">
              <input v-model.number="form.retry_max_attempts" class="ctrl" type="number" min="0" placeholder="5" />
            </Field>
            <Field label="Retry base delay (ms)" hint="Doubles each attempt.">
              <input v-model.number="form.retry_base_delay_ms" class="ctrl" type="number" min="0" placeholder="3000" />
            </Field>
            <Field label="Max concurrent jobs" hint="Cap on simultaneous runs of this profile. Optional.">
              <input v-model.number="form.max_concurrent" class="ctrl" type="number" min="1" placeholder="(global)" />
            </Field>
          </div>
        </Card>

        <div class="actions">
          <Button variant="primary" icon="check" :loading="saving" @click="save">
            {{ editing ? "Save changes" : "Create profile" }}
          </Button>
          <Button v-if="editing" variant="danger" icon="trash" :loading="deleting" @click="deleteProfile">
            Delete
          </Button>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.loading-row {
  padding: var(--space-12);
  text-align: center;
  color: var(--text-3);
  font-size: var(--text-sm);
}
.profile-layout {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-4);
  align-items: start;
}
.form-col {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  max-width: 720px;
}
.banner {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
}
.banner.err {
  background: var(--danger-weak);
  color: var(--danger);
}
.banner.ok {
  background: var(--accent-weak);
  color: var(--accent);
}
.banner.info {
  background: var(--surface-3);
  color: var(--text-2);
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 var(--space-4);
}
.hint-block {
  margin: 0 0 var(--space-3);
  font-size: var(--text-xs);
  color: var(--text-3);
}
.tools {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.tool {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  color: var(--text-2);
  cursor: pointer;
}
.tool code {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background: var(--surface-1);
  border: 1px solid var(--border);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--text-2);
  cursor: pointer;
}
.actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-2);
}
.ctrl {
  width: 100%;
}
.mono {
  font-family: var(--font-mono);
}
@media (max-width: 640px) {
  .grid-2 {
    grid-template-columns: 1fr;
  }
}
</style>
