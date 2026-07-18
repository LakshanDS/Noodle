<script setup lang="ts">
/**
 * Profile create/edit form. Exposes every field of ProfileData (the engine's
 * per-run config), grouped by purpose into cards. Save creates (POST) or updates
 * (PATCH); after a create we navigate to the edit route so a subsequent save
 * PATCHes. All profiles are DB-managed — created, edited, and deleted here.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getJson, sendJson, ApiRequestError, isAuthError } from "../api/client.js";
import type {
  ProfileDetailResponse,
  ProfileMutationResponse,
  ProfileData,
  ProfileInput,
  ProfilesResponse,
  FetchModelsResponse,
  TestModelResponse,
  Api,
  ThinkingLevel,
} from "../api/types.js";
import { BUILTIN_TOOLS } from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import ConfirmDialog from "../components/ui/ConfirmDialog.vue";
import Field from "../components/ui/Field.vue";
import Icon from "../components/ui/Icon.vue";
import Select from "../components/ui/Select.vue";
import type { SelectOption } from "../components/ui/Select.vue";

const props = defineProps<{ name?: string; isNew?: boolean }>();
const router = useRouter();

const editing = computed(() => !props.isNew && props.name != null);

/** All wire protocols a custom endpoint can speak (mirrors Api in types). */
const APIS: Api[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
];

/**
 * Canonical base URL per protocol — the official first-party endpoint. Used to
 * pre-fill base_url when the protocol changes. A custom URL the user typed is
 * preserved: the watcher only replaces base_url when it's empty or currently
 * holding another protocol's canonical default.
 *
 * openai-completions has NO default — it's the catch-all for any
 * OpenAI-compatible endpoint (Ollama, vLLM, DeepSeek, NVIDIA NIM, …), so
 * pre-filling a single URL would be misleading. Selecting it leaves base_url
 * empty for the user to fill.
 */
const DEFAULT_BASE_URLS: Record<Api, string> = {
  "openai-completions": "",
  "openai-responses": "https://api.openai.com/v1",
  "anthropic-messages": "https://api.anthropic.com",
  "google-generative-ai": "https://generativelanguage.googleapis.com",
  "mistral-conversations": "https://api.mistral.ai/v1",
};
/** Set of all canonical defaults, for "is base_url still a default?" checks. */
const DEFAULT_BASE_URL_VALUES = new Set(Object.values(DEFAULT_BASE_URLS));

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Option lists for the styled <Select> dropdowns. */
const apiOptions: SelectOption[] = APIS.map((a) => ({ value: a, label: a }));
const thinkingOptions: SelectOption[] = THINKING_LEVELS.map((l) => ({ value: l, label: l }));

/** Default profile used when creating from scratch (mirrors schema defaults). */
function emptyProfile(): ProfileData {
  return {
    model: "",
    base_url: "",
    api: "openai-completions",
    api_key: "",
    // Model limits: 256k context, 8k out — sensible defaults for modern models.
    context_window: 256000,
    max_tokens: 8192,
    // Pricing defaults to 0 (no cost tracking unless the operator sets rates).
    input_token_price: 0,
    output_token_price: 0,
    cache_read_price: 0,
    cache_write_price: 0,
    reasoning: false,
    thinking_level: "medium",
    tools: [...BUILTIN_TOOLS],
    // Rate limits: 30 req/min, 5 retries, 3s base delay, 1 concurrent job.
    api_rpm: 30,
    retry_max_attempts: 5,
    retry_base_delay_ms: 3000,
    max_concurrent: 1,
    use_relay: false,
  };
}

const name = ref("");
/** Copy of the name as loaded from the server — to detect renames. */
const originalName = ref("");
const form = ref<ProfileData>(emptyProfile());
const saving = ref(false);
const deleting = ref(false);
const settingDefault = ref(false);
/** True when this profile is the current default (config.default_profile). */
const isDefault = ref(false);
const loading = ref(false);
const showDeleteConfirm = ref(false);
const errorMsg = ref("");
const infoMsg = ref("");

/* ---------- Per-card "customize" toggles ----------
 * Each optional card has a switch in its header (#actions slot). Off = hide the
 * fields and omit them on save so the server applies schema defaults. State is
 * inferred from the loaded profile in load() so reopening shows the right view.
 * Rate limits has no separate ref — form.use_relay is its toggle. All default
 * to off (use defaults) for a new profile. */
const customizeLimits = ref(false);
const customizePricing = ref(false);
const customizeTools = ref(false);

/* ---------- Summary preview formatters (mirror ProfilesView) ---------- */

/** Compact token-count label: ≥1M → "1M"/"1.5M", ≥1K → "256K", else raw, "—" if unset. */
function ctxLabel(ctx?: number): string {
  if (!ctx || ctx <= 0) return "—";
  if (ctx >= 1_000_000) {
    const m = ctx / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}K`;
  return String(ctx);
}

/** "$3.00"-style price for a per-1M-token value, "" when unset (0). */
function priceLabel(v: number): string {
  if (!v || v <= 0) return "";
  return `$${v.toFixed(2)}`;
}

/** "in $3.00 / out $15.00" — only the non-zero halves render. "" when both 0. */
const priceSummary = computed(() => {
  const inP = priceLabel(form.value.input_token_price);
  const outP = priceLabel(form.value.output_token_price);
  if (inP && outP) return `${inP} / ${outP}`;
  return inP || outP;
});

/** Compact "context / output" summary, e.g. "256K / 8K". "—" for either side
 *  when unset, so a half-configured profile reads as "256K / —". */
const contextSummary = computed(
  () => `${ctxLabel(form.value.context_window)} / ${ctxLabel(form.value.max_tokens)}`,
);

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
    // New profile: all card toggles off (use defaults).
    customizeLimits.value = false;
    customizePricing.value = false;
    customizeTools.value = false;
    isDefault.value = false;
    return;
  }
  loading.value = true;
  errorMsg.value = "";
  try {
    // Fetch the profile + the profiles list (for the default flag) in parallel.
    const [body, list] = await Promise.all([
      getJson<ProfileDetailResponse>(`/api/profiles/${encodeURIComponent(props.name)}`),
      getJson<ProfilesResponse>("/api/profiles"),
    ]);
    name.value = body.profile.name;
    originalName.value = body.profile.name;
    const p = { ...emptyProfile(), ...body.profile.profile };
    form.value = p;
    isDefault.value = list.default === body.profile.name;
    // Infer per-card toggle state from what the stored profile actually sets.
    // A card saved with its toggle off omits its fields, so the server fills
    // schema defaults — we detect "off" by comparing against those defaults:
    // limits on if either field is present; pricing on if any price > 0; tools
    // on only if the stored set differs from the default built-in set.
    customizeLimits.value = p.context_window != null || p.max_tokens != null;
    customizePricing.value =
      !!(p.input_token_price || p.output_token_price || p.cache_read_price || p.cache_write_price);
    const defaultTools = [...BUILTIN_TOOLS];
    customizeTools.value =
      p.tools.length !== defaultTools.length ||
      p.tools.some((t) => !defaultTools.includes(t as (typeof BUILTIN_TOOLS)[number]));
  } catch (e) {
    if (isAuthError(e)) return;
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Could not load profile.";
  } finally {
    loading.value = false;
  }
}

/**
 * Mark this profile as the default fallback. The server holds default_profile
 * as a single key, so setting this one unsets any other — there's exactly one
 * default at a time.
 */
async function setDefault(): Promise<void> {
  if (!editing.value || props.name == null) return;
  errorMsg.value = "";
  infoMsg.value = "";
  settingDefault.value = true;
  try {
    await sendJson(`/api/profiles/${encodeURIComponent(props.name)}/default`, "POST");
    isDefault.value = true;
    infoMsg.value = "Default profile.";
  } catch (e) {
    if (isAuthError(e)) return;
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Could not set default profile.";
  } finally {
    settingDefault.value = false;
  }
}

function payload(): ProfileInput | null {
  const p = form.value;
  const trimmedName = name.value.trim();
  if (!trimmedName) {
    errorMsg.value = "Name is required.";
    return null;
  }
  if (!p.model) {
    errorMsg.value = "Model is required.";
    return null;
  }
  if (!p.base_url?.trim()) {
    errorMsg.value = "Base URL is required.";
    return null;
  }
  if (!p.api) {
    errorMsg.value = "Wire protocol (api) is required.";
    return null;
  }
  // Build a clean profile. Fields gated behind a disabled card toggle are
  // deleted from the payload so the server applies its schema defaults — the
  // toggle is the source of truth for "use defaults vs. customize". Built as a
  // Record so we can delete keys without fighting ProfileData's required fields.
  const clean: Record<string, unknown> = {
    model: p.model.trim(),
    base_url: p.base_url.trim(),
    api: p.api,
    api_key: p.api_key?.trim() ?? "",
    // reasoning is derived from thinking_level: any level above "off" means the
    // model is thinking-capable and the level should be forwarded to the endpoint.
    reasoning: p.thinking_level !== "off",
    thinking_level: p.thinking_level,
    use_relay: !!p.use_relay,
  };

  // Model limits card — only when customized.
  if (customizeLimits.value) {
    if (p.context_window) clean.context_window = num(p.context_window);
    if (p.max_tokens) clean.max_tokens = num(p.max_tokens);
  }

  // Token pricing card — only when customized. Omitted → server default 0.
  if (customizePricing.value) {
    clean.input_token_price = num(p.input_token_price);
    clean.output_token_price = num(p.output_token_price);
    clean.cache_read_price = num(p.cache_read_price);
    clean.cache_write_price = num(p.cache_write_price);
  }

  // Tools card — only when customized. Omitted → server default (all built-ins).
  if (customizeTools.value) clean.tools = p.tools;

  // Rate limits — the relay switch is the toggle. The numerics configure the
  // relay, so they're only meaningful (and only sent) when relay is on. In
  // direct mode the engine applies the in-process throttle using the server
  // default api_rpm (30) — omitting them preserves that behavior.
  if (p.use_relay) {
    clean.api_rpm = numOr(p.api_rpm, 0);
    clean.retry_max_attempts = numOr(p.retry_max_attempts, 0);
    clean.retry_base_delay_ms = numOr(p.retry_base_delay_ms, 0);
    if (p.max_concurrent) clean.max_concurrent = num(p.max_concurrent);
  }

  return { name: trimmedName, profile: clean as unknown as ProfileData };
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
      }
      infoMsg.value = "Saved.";
    } else {
      const res = await sendJson<ProfileMutationResponse>("/api/profiles", "POST", body);
      await router.replace({ name: "profile-detail", params: { name: res.profile.name } });
    }
  } catch (e) {
    if (isAuthError(e)) return;
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Could not reach server";
  } finally {
    saving.value = false;
  }
}

function deleteProfile(): void {
  if (!editing.value || props.name == null) return;
  errorMsg.value = "";
  showDeleteConfirm.value = true;
}

async function confirmDeleteProfile(): Promise<void> {
  if (props.name == null) return;
  deleting.value = true;
  try {
    await sendJson(`/api/profiles/${encodeURIComponent(props.name)}`, "DELETE");
    showDeleteConfirm.value = false;
    await router.replace({ name: "profiles" });
  } catch (e) {
    if (isAuthError(e)) return;
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Could not reach server";
  } finally {
    deleting.value = false;
  }
}

/* ---------- Model combobox + endpoint verify ----------
 * The Model field is a combobox: a text input whose typed value IS form.model
 * (so a custom id not in the endpoint's list still works), with a dropdown of
 * the endpoint's reported models that filters as you type. The link button on
 * the right pings the endpoint — green check when the typed model is one the
 * endpoint actually serves.
 *
 * The dropdown panel is Teleported to <body> (Card has overflow:hidden, so a
 * non-teleported panel would be clipped) and positioned under the input via
 * getBoundingClientRect(), mirroring the pattern in Select.vue. */

/** Models the endpoint reported via GET {base_url}/models. */
const fetchedModels = ref<string[]>([]);

const verifying = ref(false);
/** Green-check state: the typed model is in the endpoint's model list. */
const modelVerified = ref(false);
const verifyError = ref(false);
const verifyMsg = ref("");

const canVerify = computed(() => !!form.value.base_url?.trim());

/** Models matching the current typed text (case-insensitive substring). The
 *  typed value is always editable independently — this only gates the list. */
const filteredModels = computed<string[]>(() => {
  const q = form.value.model.trim().toLowerCase();
  if (!q) return fetchedModels.value;
  return fetchedModels.value.filter((m) => m.toLowerCase().includes(q));
});

/* ----- Combobox open/highlight state + teleported panel positioning ----- */
const modelOpen = ref(false);
const modelHighlight = ref(-1);
const modelInput = ref<HTMLInputElement | null>(null);
const modelWrap = ref<HTMLElement | null>(null);
const modelPanel = ref<HTMLElement | null>(null);
const modelPanelPos = ref({ top: 0, left: 0, width: 0 });

function syncModelPanelPos(): void {
  const el = modelInput.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  modelPanelPos.value = { top: r.bottom + 4, left: r.left, width: r.width };
}

function openModelPanel(): void {
  if (modelOpen.value || !filteredModels.value.length) return;
  syncModelPanelPos();
  modelHighlight.value = Math.max(
    0,
    filteredModels.value.indexOf(form.value.model.trim()),
  );
  modelOpen.value = true;
}
function closeModelPanel(): void {
  modelOpen.value = false;
}

/** Pick a model from the list into form.model, then close. Does NOT mark
 *  verified — that needs an explicit verify click (a real completion request). */
function pickModel(m: string, e?: MouseEvent): void {
  e?.preventDefault();
  form.value.model = m;
  closeModelPanel();
  void nextTick(() => modelInput.value?.focus());
}

function onModelKeydown(e: KeyboardEvent): void {
  const n = filteredModels.value.length;
  if (!modelOpen.value) {
    // Open on ArrowDown when there's something to show.
    if ((e.key === "ArrowDown" || e.key === "Enter") && n) {
      e.preventDefault();
      openModelPanel();
    }
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    modelHighlight.value = n ? (modelHighlight.value + 1) % n : -1;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    modelHighlight.value = n ? (modelHighlight.value - 1 + n) % n : -1;
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (modelHighlight.value >= 0 && modelHighlight.value < n) {
      pickModel(filteredModels.value[modelHighlight.value]);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeModelPanel();
  }
}

/** Click-outside closes the panel (checks both the wrapper and teleported panel). */
function onModelDocClick(e: MouseEvent): void {
  const t = e.target as Node;
  if (modelWrap.value?.contains(t)) return;
  if (modelPanel.value?.contains(t)) return;
  closeModelPanel();
}
function onModelScrollOrResize(): void {
  if (modelOpen.value) syncModelPanelPos();
}

/** Call the fetch-models route. Returns the parsed response, or null when the
 *  form lacks a base_url. Throws on network/auth errors so callers can surface
 *  them. */
async function fetchModels(): Promise<FetchModelsResponse | null> {
  if (!canVerify.value) return null;
  return sendJson<FetchModelsResponse>("/api/profiles/fetch-models", "POST", {
    base_url: form.value.base_url.trim(),
    api_key: form.value.api_key?.trim() || undefined,
    model: form.value.model?.trim() || undefined,
  });
}

/**
 * Explicit verify click: fire a REAL minimal completion request to the endpoint
 * (POST /api/profiles/test-model) to confirm the URL + key + model work
 * end-to-end. Green check only on a 2xx — this catches cases where /models
 * lists a model but the endpoint rejects it on an actual call.
 */
async function verifyModel(): Promise<void> {
  errorMsg.value = "";
  if (!form.value.model?.trim()) {
    verifyError.value = true;
    verifyMsg.value = "Enter a model id first.";
    return;
  }
  verifying.value = true;
  verifyError.value = false;
  verifyMsg.value = "";
  try {
    const r = await sendJson<TestModelResponse>("/api/profiles/test-model", "POST", {
      base_url: form.value.base_url.trim(),
      api_key: form.value.api_key?.trim() || undefined,
      model: form.value.model.trim(),
      api: form.value.api,
    });
    if (r.ok) {
      modelVerified.value = true;
      verifyMsg.value = "";
    } else {
      modelVerified.value = false;
      verifyError.value = true;
      verifyMsg.value = r.error || "Model did not respond successfully.";
    }
  } catch (e) {
    modelVerified.value = false;
    verifyError.value = true;
    verifyMsg.value = e instanceof ApiRequestError ? e.message : "Could not reach endpoint.";
  } finally {
    verifying.value = false;
  }
}

/**
 * When the wire protocol changes, pre-fill base_url with that protocol's
 * canonical default — but ONLY if base_url is empty or still holds another
 * protocol's default. A URL the user typed by hand is preserved so custom
 * proxies / local endpoints (Ollama, vLLM) aren't clobbered. Changing the URL
 * then triggers the auto-load watcher below.
 */
watch(
  () => form.value.api,
  (api, prev) => {
    if (api === prev) return;
    const url = form.value.base_url.trim();
    const stillDefault = url === "" || DEFAULT_BASE_URL_VALUES.has(url);
    // Also preserve when the old value matched the previous protocol's default.
    const prevDefault = prev ? DEFAULT_BASE_URLS[prev] : "";
    if (stillDefault || url === prevDefault) {
      form.value.base_url = DEFAULT_BASE_URLS[api];
    }
  },
);

/**
 * Auto-load the model dropdown whenever BOTH base_url and api_key are set
 * (debounced 600ms). Most endpoints reject the /models request without a key,
 * so filling only base_url is not enough — wait for the key too. Also clears
 * the green-check/error state since the previous verification no longer
 * applies. Silently swallows errors on auto-load — the explicit verify button
 * is where failures are surfaced. This only fills the dropdown; it does NOT
 * mark the model verified (that needs a real completion request).
 */
let autoTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => [form.value.base_url, form.value.api_key],
  ([url, key]) => {
    if (autoTimer) clearTimeout(autoTimer);
    fetchedModels.value = [];
    modelVerified.value = false;
    verifyError.value = false;
    verifyMsg.value = "";
    const hasUrl = !!url && !!String(url).trim();
    const hasKey = !!key && !!String(key).trim();
    if (!hasUrl || !hasKey) return;
    autoTimer = setTimeout(() => {
      void fetchModels()
        .then((r) => {
          if (r) fetchedModels.value = r.models;
        })
        .catch(() => {
          /* silent on auto-load; the verify button surfaces errors */
        });
    }, 600);
  },
);

/** Typing/editing the model invalidates a prior green check (needs re-verify). */
watch(
  () => form.value.model,
  () => {
    if (modelVerified.value) modelVerified.value = false;
  },
);

/** Verify title text for the button's hover tooltip. */
const verifyTitle = computed(() => {
  if (verifying.value) return "Sending a test request…";
  if (modelVerified.value) return "Model verified — test request succeeded.";
  if (verifyError.value) return verifyMsg.value || "Could not verify.";
  return "Send a test request to check the model works.";
});

onMounted(() => {
  document.addEventListener("mousedown", onModelDocClick);
  window.addEventListener("scroll", onModelScrollOrResize, true);
  window.addEventListener("resize", onModelScrollOrResize);
});
onBeforeUnmount(() => {
  if (autoTimer) clearTimeout(autoTimer);
  document.removeEventListener("mousedown", onModelDocClick);
  window.removeEventListener("scroll", onModelScrollOrResize, true);
  window.removeEventListener("resize", onModelScrollOrResize);
});

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
        <span class="btn-label">Refresh</span>
      </Button>
    </template>

    <div v-if="loading" class="loading-row">Loading…</div>

    <div v-else class="profile-layout">
      <div class="form-col">
        <div v-if="errorMsg" class="banner err">{{ errorMsg }}</div>
        <div v-if="infoMsg" class="banner ok">{{ infoMsg }}</div>

        <!-- Identity -->
        <Card title="Identity">
          <Field label="Name" hint="The key jobs/schedules reference, and the #&lt;name&gt; tag.">
            <input v-model="name" class="ctrl" type="text" placeholder="e.g. claude-fast" />
          </Field>
        </Card>

        <!-- Endpoint -->
        <Card title="Endpoint & Model">
          <!-- Honeypot decoys: browsers that insist on autofilling a
               username/password pair fill these invisible fields instead of the
               real base_url/api_key below. Must stay before the real fields and
               use display:block (display:none disables autofill). tabindex="-1"
               keeps them out of the keyboard flow; aria-hidden + autocomplete
               values steer the manager onto them. -->
          <input class="autofill-trap" type="text" name="username" tabindex="-1" aria-hidden="true" autocomplete="username" />
          <input class="autofill-trap" type="password" name="password" tabindex="-1" aria-hidden="true" autocomplete="new-password" />

          <Field label="Base URL" hint="The endpoint URL — OpenAI-compatible, Anthropic-compatible, proxy, or local.">
            <input
              v-model="form.base_url"
              class="ctrl mono"
              type="text"
              name="profile-base-url"
              autocomplete="off"
              placeholder="https://api.anthropic.com"
            />
          </Field>
          <Field label="API key" hint="The key for this endpoint. Leave empty for no-auth local endpoints (e.g. Ollama).">
            <input
              v-model="form.api_key"
              class="ctrl mono"
              type="password"
              name="profile-api-key"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              placeholder="sk-…"
            />
          </Field>
          <Field label="Wire protocol (api)" hint="The protocol the endpoint speaks.">
            <Select v-model="form.api" :options="apiOptions" mono />
          </Field>
          <Field label="Model" hint="Auto-fills from the endpoint's /models list once a base URL is set. The link button sends a test request to confirm the model works.">
            <div ref="modelWrap" class="model-combo">
              <div class="model-row">
                <input
                  ref="modelInput"
                  v-model="form.model"
                  class="ctrl mono"
                  type="text"
                  placeholder="claude-sonnet-4-20250514"
                  autocomplete="off"
                  @focus="openModelPanel"
                  @input="openModelPanel"
                  @keydown="onModelKeydown"
                />
                <button
                  type="button"
                  class="verify-btn"
                  :class="{ ok: modelVerified, loading: verifying, err: verifyError }"
                  :disabled="!canVerify || verifying"
                  :title="verifyTitle"
                  @click="verifyModel"
                >
                  <Icon
                    :name="modelVerified ? 'check' : verifying ? 'refresh' : 'link'"
                    :size="14"
                    :class="{ spin: verifying }"
                  />
                </button>
              </div>
              <p v-if="verifyMsg" class="verify-msg" :class="{ err: verifyError, ok: modelVerified }">
                {{ verifyMsg }}
              </p>

              <!-- Teleported dropdown — escapes Card's overflow:hidden. -->
              <Teleport to="body">
                <Transition name="dd">
                  <ul
                    v-if="modelOpen && filteredModels.length"
                    ref="modelPanel"
                    class="model-panel mono"
                    role="listbox"
                    :style="{
                      top: modelPanelPos.top + 'px',
                      left: modelPanelPos.left + 'px',
                      width: modelPanelPos.width + 'px',
                    }"
                  >
                    <li
                      v-for="(m, i) in filteredModels"
                      :key="m"
                      class="mp-opt"
                      :class="{ active: i === modelHighlight, selected: m === form.model }"
                      role="option"
                      :aria-selected="m === form.model"
                      @mousedown.prevent="pickModel(m, $event)"
                      @mouseenter="modelHighlight = i"
                    >
                      <span class="mp-label">{{ m }}</span>
                      <Icon v-if="m === form.model" name="check" :size="13" class="mp-check" />
                    </li>
                  </ul>
                </Transition>
              </Teleport>
            </div>
          </Field>
          <Field label="Thinking level" hint="Off = reasoning disabled. Other levels are forwarded to the endpoint only for thinking-capable models.">
            <Select v-model="form.thinking_level" :options="thinkingOptions" />
          </Field>
        </Card>

        <!-- Model limits -->
        <Card title="Model limits" :body="customizeLimits">
          <template #actions>
            <div class="toggle-top">
              <span class="toggle-label">Customize</span>
              <button
                type="button"
                class="toggle"
                :class="{ on: customizeLimits }"
                :aria-pressed="customizeLimits"
                @click="customizeLimits = !customizeLimits"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>
          </template>
          <template v-if="customizeLimits">
            <Field label="Context window" hint="Token budget the model accepts.">
              <input v-model.number="form.context_window" class="ctrl" type="number" min="1" placeholder="32768" />
            </Field>
            <Field label="Max output tokens" hint="Cap on a single response.">
              <input v-model.number="form.max_tokens" class="ctrl" type="number" min="1" placeholder="8192" />
            </Field>
          </template>
        </Card>

        <!-- Pricing -->
        <Card title="Token pricing (USD / 1M tokens)" :body="customizePricing">
          <template #actions>
            <div class="toggle-top">
              <span class="toggle-label">Customize</span>
              <button
                type="button"
                class="toggle"
                :class="{ on: customizePricing }"
                :aria-pressed="customizePricing"
                @click="customizePricing = !customizePricing"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>
          </template>
          <template v-if="customizePricing">
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
          </template>
        </Card>

        <!-- Rate limits & retries — the Use relay switch is the card toggle. -->
        <Card title="Rate limits & retries" :body="form.use_relay">
          <template #actions>
            <div class="toggle-top">
              <span class="toggle-label">Use relay</span>
              <button
                type="button"
                class="toggle"
                :class="{ on: form.use_relay }"
                :aria-pressed="form.use_relay"
                @click="form.use_relay = !form.use_relay"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>
          </template>
          <template v-if="form.use_relay">
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
              <Field label="Max concurrent jobs" hint="Max simultaneous runs of this profile (default 1).">
                <input v-model.number="form.max_concurrent" class="ctrl" type="number" min="1" placeholder="1" />
              </Field>
            </div>
          </template>
        </Card>

        <!-- Tools -->
        <Card title="Tools" :body="customizeTools">
          <template #actions>
            <div class="toggle-top">
              <span class="toggle-label">Customize</span>
              <button
                type="button"
                class="toggle"
                :class="{ on: customizeTools }"
                :aria-pressed="customizeTools"
                @click="customizeTools = !customizeTools"
              >
                <span class="toggle-knob"></span>
              </button>
            </div>
          </template>
          <template v-if="customizeTools">
            <div class="tools">
              <button
                v-for="t in BUILTIN_TOOLS"
                :key="t"
                type="button"
                class="tool-chip"
                :class="{ on: form.tools.includes(t) }"
                :aria-pressed="form.tools.includes(t)"
                @click="toggleTool(t)"
              >
                <Icon
                  :name="form.tools.includes(t) ? 'check' : 'dot'"
                  :size="12"
                  class="tool-chip-icon"
                />
                <span class="tool-chip-label">{{ t }}</span>
              </button>
            </div>
            <p class="hint-block below">Built-in tools this profile may use. Click to toggle.</p>
          </template>
        </Card>

        <div class="actions">
          <Button variant="primary" icon="check" :loading="saving" @click="save">
            {{ editing ? "Save changes" : "Create profile" }}
          </Button>
          <Button
            v-if="editing"
            :variant="isDefault ? 'ghost' : 'secondary'"
            :icon="isDefault ? 'check' : 'bolt'"
            :disabled="isDefault"
            :loading="settingDefault"
            @click="setDefault"
          >
            {{ isDefault ? "Default" : "Set default" }}
          </Button>
          <Button v-if="editing" variant="danger" icon="trash" @click="deleteProfile">
            Delete
          </Button>
        </div>
      </div>

      <!-- Side column: live summary + help -->
      <aside class="side-col">
        <!-- Profile summary preview — updates as you type -->
        <Card title="Profile summary">
          <dl class="summary">
            <div class="sum-row">
              <dt>Name</dt>
              <dd class="mono">{{ name || "—" }}</dd>
            </div>
            <div class="sum-row">
              <dt>Model</dt>
              <dd class="mono">
                {{ form.model || "—" }}
                <Icon v-if="modelVerified" name="check" :size="12" class="sum-check" />
              </dd>
            </div>
            <div class="sum-row">
              <dt>Context</dt>
              <dd>{{ contextSummary }}</dd>
            </div>
            <div class="sum-row">
              <dt>Pricing</dt>
              <dd>{{ priceSummary || "—" }}</dd>
            </div>
            <div class="sum-row">
              <dt>Tools</dt>
              <dd>{{ form.tools.length }}</dd>
            </div>
          </dl>
        </Card>

        <!-- How profiles work -->
        <Card title="How profiles work">
          <p class="hint-text">
            A profile pins a <strong>provider + model + tool set</strong> the agent runs as. Route
            issues and schedules to it with a <code class="inline mono">#{{ name || "name" }}</code> tag.
          </p>
          <p class="hint-text">
            Every profile points at an <strong>endpoint</strong> via base URL + wire protocol.
            Set context window and max output tokens to match the model's limits.
          </p>
          <p class="hint-text">
            <strong>Pricing</strong> is per 1M tokens (USD) and only used for cost tracking — leave
            at 0 if you don't need it.
          </p>
        </Card>
      </aside>

      <!-- Mobile-only duplicate of the action row. Renders after the sidebar so
           buttons are the last thing on a phone. Hidden on >=641px via CSS;
           the in-form .actions is hidden on mobile. Same handlers/state, so the
           two blocks can never drift out of sync. -->
      <div class="actions actions-mobile">
        <Button variant="primary" icon="check" :loading="saving" @click="save">
          {{ editing ? "Save changes" : "Create profile" }}
        </Button>
        <Button
          v-if="editing"
          :variant="isDefault ? 'ghost' : 'secondary'"
          :icon="isDefault ? 'check' : 'bolt'"
          :disabled="isDefault"
          :loading="settingDefault"
          @click="setDefault"
        >
          {{ isDefault ? "Default" : "Set default" }}
        </Button>
        <Button v-if="editing" variant="danger" icon="trash" @click="deleteProfile">
          Delete
        </Button>
      </div>
    </div>

    <ConfirmDialog
      v-model:open="showDeleteConfirm"
      :title='`Delete profile "${props.name}"?`'
      message="Existing runs keep their resolved model. This can't be undone."
      confirm-label="Delete"
      danger
      :loading="deleting"
      @confirm="confirmDeleteProfile"
    />
  </AppShell>
</template>

<style scoped>
/* Honeypot decoy inputs that absorb browser autofill (username/password pair)
 * so it doesn't populate the real base_url/api_key fields. Must NOT be
 * display:none / visibility:hidden — that disables autofill. Off-screen clip
 * keeps them invisible while remaining autofill-eligible. */
.autofill-trap {
  position: absolute;
  left: -9999px;
  top: -9999px;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.loading-row {
  padding: var(--space-12);
  text-align: center;
  color: var(--text-3);
  font-size: var(--text-sm);
}
.profile-layout {
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: var(--space-5);
  align-items: start;
}
.form-col {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
/* Sticky side column — summary + help. Stays put while the form scrolls, like
 * the RunDetailView meta sidebar. `top` = action panel height (44) + its bottom
 * margin (16) = 60px, matching the card's load offset from the scrollport. */
.side-col {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  position: sticky;
  top: 60px;
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
/* When the hint sits below content (e.g. under the tool chips), flip the
 * margin to the top so spacing reads correctly. */
.hint-block.below {
  margin: var(--space-3) 0 0;
}
.tools {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
/* Tool toggle chip — content-sized pill, left-aligned so the set wraps
 * naturally. On = accent fill + accent border + check icon. */
.tool-chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border);
  background: var(--surface-1);
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.tool-chip:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.tool-chip.on {
  background: var(--accent-weak);
  border-color: var(--accent);
  color: var(--accent);
}
.tool-chip-icon {
  flex: 0 0 auto;
}
.tool-chip-label {
  font-family: var(--font-mono);
}

/* Switch toggle — mirrors SettingsView's trigger switches. Used in card #actions
 * slots (customize toggles) and inline in the Rate limits card (Use relay). */
.toggle-top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.toggle-label {
  font-size: var(--text-sm);
  color: var(--text-2);
  font-weight: var(--weight-medium);
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
  flex: 0 0 auto;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
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
.actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-2);
}
/* Mobile-only duplicate action row — hidden on desktop, shown via the 640px
 * media query below. */
.actions-mobile {
  display: none;
}
.ctrl {
  width: 100%;
}
.mono {
  font-family: var(--font-mono);
}

/* ---------- Model combobox: text input + verify button + teleported list ---------- */
.model-combo {
  position: relative;
}
.model-row {
  display: flex;
  gap: var(--space-2);
}
.model-row .ctrl {
  flex: 1 1 auto;
}
/* 36px square ghost button — matches .ctrl height (.md). */
.verify-btn {
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text-2);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.verify-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}
.verify-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* Green check — endpoint serves the typed model. */
.verify-btn.ok {
  border-color: var(--success, var(--accent));
  color: var(--success, var(--accent));
  background: var(--accent-weak);
}
/* Red — endpoint unreachable or model not found. */
.verify-btn.err {
  border-color: var(--danger);
  color: var(--danger);
  background: var(--danger-weak);
}
/* Spin the refresh icon while loading. */
.verify-btn .spin {
  animation: noodle-spin 0.8s linear infinite;
}
@keyframes noodle-spin {
  to {
    transform: rotate(360deg);
  }
}
.verify-msg {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  color: var(--text-3);
}
.verify-msg.err {
  color: var(--danger);
}
.verify-msg.ok {
  color: var(--success, var(--accent));
}
/* Inline green check beside the model id in the side summary. */
.sum-check {
  vertical-align: middle;
  color: var(--success, var(--accent));
  margin-left: 4px;
}

/* ---------- Side column: summary + help ---------- */
.summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
}
.sum-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}
.sum-row dt {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-3);
  font-weight: var(--weight-medium);
}
.sum-row dd {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}
.hint-text {
  font-size: var(--text-xs);
  color: var(--text-3);
  margin: var(--space-2) 0 0;
  line-height: 1.5;
}
.hint-text:first-child {
  margin-top: 0;
}
.hint-text code.inline {
  font-family: var(--font-mono);
  background: var(--surface-4);
  color: var(--text-2);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
}

/* Collapse the two-column layout on smaller screens; the side card drops below. */
@media (max-width: 900px) {
  .profile-layout {
    grid-template-columns: 1fr;
  }
  .side-col {
    position: static;
  }
}
@media (max-width: 640px) {
  .grid-2 {
    grid-template-columns: 1fr;
  }
  /* Hide the in-form actions on mobile; a duplicate centered block renders
   * after the sidebar so buttons are always the last thing on the page. */
  .form-col > .actions {
    display: none;
  }
  .actions-mobile {
    display: flex;
    justify-content: center;
    margin-top: var(--space-2);
  }
}
</style>

<!--
  The model dropdown panel is Teleported to <body>, so its styles must be
  unscoped (global) to apply — scoped styles add a data-attribute selector the
  teleported node won't carry. Unique class names avoid collisions (mirrors the
  pattern in Select.vue).
-->
<style>
.model-panel {
  position: fixed;
  z-index: 1000;
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 260px;
  overflow-y: auto;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
}
.model-panel.mono .mp-label {
  font-family: var(--font-mono);
}
.model-panel .mp-opt {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 7px var(--space-3);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.model-panel .mp-opt:hover,
.model-panel .mp-opt.active {
  background: var(--accent-weak);
}
.model-panel .mp-opt.selected {
  color: var(--accent);
}
.model-panel .mp-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  color: var(--text-2);
}
.model-panel .mp-opt.selected .mp-label,
.model-panel .mp-opt.active .mp-label {
  color: var(--text);
}
.model-panel .mp-check {
  flex: 0 0 auto;
  color: var(--accent);
}

/* Open/close transition — shared name "dd" with Select.vue's. */
.dd-enter-active,
.dd-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}
.dd-enter-from,
.dd-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
