<script setup lang="ts">
/**
 * First-run setup wizard — full-screen (no app shell). 4 steps with a stepper:
 * GitHub → Model → Password → Review. On finish, shows a "restart required"
 * success state before routing to login.
 */
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { getJson, sendJson, ApiRequestError } from "../api/client.js";
import type { SetupStatus, SetupPayload, SetupResponse, Api } from "../api/types.js";
import Icon from "../components/ui/Icon.vue";
import Button from "../components/ui/Button.vue";
import Field from "../components/ui/Field.vue";
import Card from "../components/ui/Card.vue";
import Select from "../components/ui/Select.vue";
import type { SelectOption } from "../components/ui/Select.vue";

const router = useRouter();
const step = ref(0);
const submitting = ref(false);
const errorMsg = ref("");
const done = ref(false);

const ghMode = ref<"pat" | "app">("pat");
const github = reactive({ token: "", appId: "", privateKey: "", webhookSecret: "" });

const llm = reactive({ model: "", apiKey: "", baseUrl: "", api: "openai-completions" });

/** Option list for the protocol <Select> — mirrors the full Api enum. */
const APIS: Api[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
];
const apiStyleOptions: SelectOption[] = APIS.map((a) => ({ value: a, label: a }));
const uiPassword = ref("");
const uiPasswordConfirm = ref("");

const steps = ["GitHub", "Model", "Password", "Review"];

function canAdvance(): boolean {
  if (step.value === 0) return ghMode.value === "pat" ? !!github.token : !!(github.appId && github.privateKey);
  if (step.value === 1) return !!llm.model && !!llm.baseUrl && !!llm.api;
  if (step.value === 2) return uiPassword.value.length > 0 && uiPassword.value === uiPasswordConfirm.value;
  return true;
}

function next(): void {
  errorMsg.value = "";
  if (step.value === 2 && uiPassword.value !== uiPasswordConfirm.value) {
    errorMsg.value = "Passwords don't match.";
    return;
  }
  if (step.value < 3) step.value++;
}
function back(): void {
  errorMsg.value = "";
  if (step.value > 0) step.value--;
}

async function checkStatus(): Promise<void> {
  try {
    const status = await getJson<SetupStatus>("/api/setup/status");
    if (status.configured) await router.replace({ name: "login" });
  } catch {
    /* leave wizard visible */
  }
}

async function submit(): Promise<void> {
  errorMsg.value = "";
  submitting.value = true;
  const payload: SetupPayload = {
    github:
      ghMode.value === "pat"
        ? { token: github.token.trim() }
        : { appId: github.appId.trim(), privateKey: github.privateKey, webhookSecret: github.webhookSecret.trim() },
    llm: {
      model: llm.model.trim(),
      apiKey: llm.apiKey.trim() || undefined,
      baseUrl: llm.baseUrl.trim(),
      api: llm.api,
    },
    uiPassword: uiPassword.value,
  };
  try {
    await sendJson<SetupResponse>("/api/setup", "POST", payload);
    done.value = true;
  } catch (e) {
    errorMsg.value = e instanceof ApiRequestError ? e.message : "Could not reach server";
  } finally {
    submitting.value = false;
  }
}

function goToLogin(): void {
  void router.replace({ name: "login" });
}

onMounted(checkStatus);
</script>

<template>
  <div class="setup-screen">
    <div class="ambient" aria-hidden="true" />
    <div class="setup-card">
      <!-- Done state -->
      <div v-if="done" class="done-state">
        <div class="done-glyph"><Icon name="check" :size="28" /></div>
        <h1>Setup complete</h1>
        <p>
          Your settings are saved. <strong>Restart Noodle</strong> to apply them —
          the dashboard password, GitHub credentials, and profile take effect on
          the next boot.
        </p>
        <Button variant="primary" @click="goToLogin">Go to sign in</Button>
      </div>

      <template v-else>
        <div class="brand-row">
          <span class="brand-mark"><Icon name="logo" :size="20" /></span>
          <span class="brand-name">Noodle</span>
          <span class="brand-sub">setup</span>
        </div>

        <!-- Stepper -->
        <div class="stepper">
          <div v-for="(label, i) in steps" :key="label" class="step" :class="{ active: i === step, done: i < step }">
            <span class="step-dot">{{ i < step ? "✓" : i + 1 }}</span>
            <span class="step-label">{{ label }}</span>
            <span v-if="i < steps.length - 1" class="step-line" />
          </div>
        </div>

        <div v-if="errorMsg" class="banner err"><Icon name="alert" :size="14" />{{ errorMsg }}</div>

        <!-- Step 0: GitHub -->
        <div v-show="step === 0" class="step-body">
          <h2>Connect GitHub</h2>
          <p class="step-desc">Noodle needs GitHub access to clone repos, push branches, and open pull requests.</p>

          <div class="seg">
            <button :class="{ on: ghMode === 'pat' }" @click="ghMode = 'pat'">Personal Access Token</button>
            <button :class="{ on: ghMode === 'app' }" @click="ghMode = 'app'">GitHub App</button>
          </div>

          <template v-if="ghMode === 'pat'">
            <Field label="GitHub token (PAT)" hint="Needs repo scope, or fine-grained: contents, pull-requests, issues write.">
              <input v-model="github.token" class="ctrl mono" type="password" placeholder="ghp_…" autocomplete="off" />
            </Field>
          </template>
          <template v-else>
            <Field label="App ID"><input v-model="github.appId" class="ctrl" type="text" placeholder="123456" /></Field>
            <Field label="Private key (PEM)">
              <textarea v-model="github.privateKey" class="ctrl mono" placeholder="-----BEGIN RSA PRIVATE KEY-----" />
            </Field>
            <Field label="Webhook secret" hint="The secret GitHub uses to sign webhooks.">
              <input v-model="github.webhookSecret" class="ctrl mono" type="password" autocomplete="off" />
            </Field>
          </template>
        </div>

        <!-- Step 1: Model -->
        <div v-show="step === 1" class="step-body">
          <h2>Pick a model</h2>
          <p class="step-desc">Point Noodle at your LLM endpoint. Every provider — Anthropic, OpenAI, local Ollama — is configured the same way: a protocol, a base URL, and an API key.</p>

          <Field label="Wire protocol" hint="The API format your endpoint speaks.">
            <Select v-model="llm.api" :options="apiStyleOptions" mono />
          </Field>
          <Field label="Base URL" hint="The endpoint URL (e.g. https://api.anthropic.com, http://localhost:11434/v1).">
            <input v-model="llm.baseUrl" class="ctrl mono" type="text" placeholder="https://api.anthropic.com" />
          </Field>
          <Field label="Model" hint="The model identifier the endpoint accepts.">
            <input v-model="llm.model" class="ctrl" type="text" placeholder="claude-sonnet-4-20250514" />
          </Field>
          <Field label="API key" hint="Stored on the profile. Leave empty for no-auth local endpoints.">
            <input v-model="llm.apiKey" class="ctrl mono" type="password" placeholder="sk-…" autocomplete="off" />
          </Field>
        </div>

        <!-- Step 2: Password -->
        <div v-show="step === 2" class="step-body">
          <h2>Set a dashboard password</h2>
          <p class="step-desc">This password gates the dashboard and signs the auth cookie. You'll use it to sign in.</p>

          <Field label="Password">
            <input v-model="uiPassword" class="ctrl mono" type="password" autocomplete="new-password" />
          </Field>
          <Field label="Confirm password">
            <input v-model="uiPasswordConfirm" class="ctrl mono" type="password" autocomplete="new-password" />
          </Field>
        </div>

        <!-- Step 3: Review -->
        <div v-show="step === 3" class="step-body">
          <h2>Review</h2>
          <p class="step-desc">Confirm your setup. You can change everything later in Settings.</p>

          <Card>
            <dl class="review">
              <div class="r-row"><dt>GitHub</dt><dd>{{ ghMode === "pat" ? "Personal Access Token" : "GitHub App" }}</dd></div>
              <div class="r-row"><dt>Model</dt><dd class="mono">{{ llm.model }}</dd></div>
              <div class="r-row"><dt>Endpoint</dt><dd class="mono">{{ llm.baseUrl }}</dd></div>
              <div class="r-row"><dt>Dashboard password</dt><dd>{{ uiPassword ? "set" : "—" }}</dd></div>
            </dl>
          </Card>

          <p class="restart-note">
            <Icon name="refresh" :size="13" />
            The wizard seeds a single default profile. Edit <code>noodle.config.yaml</code> for multiple profiles, routing, and triggers.
          </p>

          <Button variant="primary" size="md" :loading="submitting" @click="submit">
            Finish setup
          </Button>
        </div>

        <!-- Nav -->
        <div v-if="step < 3" class="step-nav">
          <Button v-if="step > 0" variant="ghost" icon="back" @click="back">Back</Button>
          <Button variant="primary" :disabled="!canAdvance()" @click="next" style="margin-left: auto">
            Continue
          </Button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.setup-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100dvh;
  padding: var(--space-8) var(--space-4);
  position: relative;
  overflow-y: auto;
}
.ambient {
  position: fixed;
  width: 600px;
  height: 600px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--accent-weaker) 0%, transparent 60%);
  filter: blur(50px);
  pointer-events: none;
  top: 30%;
  left: 50%;
  transform: translateX(-50%);
}
.setup-card {
  position: relative;
  width: 100%;
  max-width: 480px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: var(--space-8);
  box-shadow: var(--shadow-lg);
}

.brand-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-6);
}
.brand-mark {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background: var(--accent-weak);
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
}
.brand-name {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
}
.brand-sub {
  font-size: var(--text-xs);
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  margin-left: auto;
}

/* Stepper */
.stepper {
  display: flex;
  margin-bottom: var(--space-6);
}
.step {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 0;
}
.step-dot {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  border: 1px solid var(--border-strong);
  background: var(--surface-1);
  color: var(--text-3);
  flex: 0 0 auto;
  transition: all var(--dur) var(--ease);
}
.step.active .step-dot {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-inverse);
}
.step.done .step-dot {
  background: var(--success);
  border-color: var(--success);
  color: var(--text-inverse);
}
.step-label {
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--text-3);
}
.step.active .step-label {
  color: var(--text);
}
.step-line {
  flex: 1 1 auto;
  height: 1px;
  background: var(--border);
  margin: 0 var(--space-2);
}

/* Step body */
.step-body h2 {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  margin-bottom: var(--space-1);
}
.step-desc {
  font-size: var(--text-sm);
  color: var(--text-2);
  margin-bottom: var(--space-5);
  line-height: var(--leading-normal);
}

/* Segmented control (PAT / App) */
.seg {
  display: flex;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 3px;
  margin-bottom: var(--space-5);
  gap: 3px;
}
.seg button {
  flex: 1 1 0;
  height: 32px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--text-2);
  transition: all var(--dur-fast) var(--ease);
}
.seg button.on {
  background: var(--surface-3);
  color: var(--text);
  box-shadow: var(--shadow-sm);
}

/* Banner */
.banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  margin-bottom: var(--space-4);
}
.banner.err {
  background: var(--danger-weak);
  color: var(--danger);
}

/* Review */
.review {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.r-row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  font-size: var(--text-sm);
}
.r-row dt {
  color: var(--text-3);
}
.r-row dd {
  margin: 0;
  color: var(--text);
  text-align: right;
}
.restart-note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-3);
  margin: var(--space-4) 0;
  line-height: var(--leading-normal);
}
.restart-note code {
  font-family: var(--font-mono);
  background: var(--surface-1);
  border: 1px solid var(--border);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
}

/* Nav */
.step-nav {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-6);
  padding-top: var(--space-5);
  border-top: 1px solid var(--border-subtle);
}

/* Done state */
.done-state {
  text-align: center;
  padding: var(--space-6) 0;
}
.done-glyph {
  width: 56px;
  height: 56px;
  margin: 0 auto var(--space-4);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--success-weak);
  color: var(--success);
  border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
}
.done-state h1 {
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  margin-bottom: var(--space-2);
}
.done-state p {
  font-size: var(--text-sm);
  color: var(--text-2);
  line-height: var(--leading-relaxed);
  margin-bottom: var(--space-6);
}
</style>
