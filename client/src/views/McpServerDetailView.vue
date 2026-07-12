<script setup lang="ts">
/**
 * MCP Server create/edit form. Two columns: form fields on the left, preview
 * context on the right. Save creates or updates via /api/mcp-servers.
 *
 * Mirrors SkillDetailView.vue / CommandDetailView.vue: name (unique key),
 * transport type, conditional fields per type.
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getJson, sendJson } from "../api/client.js";
import type {
  McpServerDetailResponse,
  McpServerMutationResponse,
  McpServerInput,
  McpTransport,
} from "../api/types.js";
import AppShell from "../components/AppShell.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Field from "../components/ui/Field.vue";

const props = defineProps<{ name?: string; isNew?: boolean }>();
const router = useRouter();

const TRANSPORTS: McpTransport[] = ["stdio", "sse", "http"];

const form = ref({
  name: "",
  type: "stdio" as McpTransport,
  command: "",
  args: "",
  env: "" as string, // key=value per line
  url: "",
  description: "",
});
const saving = ref(false);
const deleting = ref(false);
const loading = ref(false);
const errorMsg = ref("");

const editing = computed(() => !props.isNew && props.name != null);

function emptyForm() {
  return { name: "", type: "stdio" as McpTransport, command: "", args: "", env: "", url: "", description: "" };
}

async function load(): Promise<void> {
  if (!editing.value || props.name == null) {
    form.value = emptyForm();
    return;
  }
  loading.value = true;
  errorMsg.value = "";
  try {
    const body = await getJson<McpServerDetailResponse>(`/api/mcp-servers/${encodeURIComponent(props.name)}`);
    const s = body.server;
    form.value = {
      name: s.name,
      type: s.server.type,
      command: s.server.command ?? "",
      args: (s.server.args ?? []).join(" "),
      env: Object.entries(s.server.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"),
      url: s.server.url ?? "",
      description: s.server.description ?? "",
    };
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : "Could not load MCP server.";
  } finally {
    loading.value = false;
  }
}

/** Parse the env textarea into a Record<string, string>. */
function parseEnv(raw: string): Record<string, string> | undefined {
  const entries = raw.split("\n").filter((l) => l.trim() && l.includes("="));
  if (!entries.length) return undefined;
  const env: Record<string, string> = {};
  for (const line of entries) {
    const idx = line.indexOf("=");
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

function payload(): McpServerInput | null {
  const trimmedName = form.value.name.trim();
  if (!trimmedName) { errorMsg.value = "Name is required."; return null; }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmedName)) {
    errorMsg.value = "Name must be lowercase letters, digits, hyphens, and underscores only.";
    return null;
  }
  if (form.value.type === "stdio" && !form.value.command.trim()) {
    errorMsg.value = "Command is required for stdio type.";
    return null;
  }
  if ((form.value.type === "sse" || form.value.type === "http") && !form.value.url.trim()) {
    errorMsg.value = `URL is required for ${form.value.type} type.`;
    return null;
  }
  return {
    name: trimmedName,
    type: form.value.type,
    description: form.value.description.trim() || undefined,
    ...(form.value.type === "stdio"
      ? {
          command: form.value.command.trim(),
          args: form.value.args.trim() || undefined,
          env: parseEnv(form.value.env),
        }
      : {
          url: form.value.url.trim(),
        }),
  };
}

async function save(): Promise<void> {
  errorMsg.value = "";
  saving.value = true;
  try {
    if (editing.value && props.name != null) {
      // Update: send everything except name (immutable).
      const body: Record<string, unknown> = {
        type: form.value.type,
        description: form.value.description.trim() || undefined,
      };
      if (form.value.type === "stdio") {
        body.command = form.value.command.trim();
        body.args = form.value.args.trim() || undefined;
        body.env = parseEnv(form.value.env);
      } else {
        body.url = form.value.url.trim();
      }
      await sendJson<McpServerMutationResponse>(`/api/mcp-servers/${encodeURIComponent(props.name)}`, "PATCH", body);
      await load();
    } else {
      const p = payload();
      if (!p) return;
      const body = await sendJson<McpServerMutationResponse>("/api/mcp-servers", "POST", p);
      await router.replace({ name: "mcp-server-detail", params: { name: body.server.name } });
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : "Could not reach server";
  } finally {
    saving.value = false;
  }
}

async function deleteServer(): Promise<void> {
  if (!editing.value || props.name == null) return;
  if (!confirm(`Delete MCP server "${props.name}"? Profiles referencing it will stop loading it.`)) return;
  deleting.value = true;
  try {
    await sendJson(`/api/mcp-servers/${encodeURIComponent(props.name)}`, "DELETE");
    await router.replace({ name: "mcp-servers" });
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : "Could not delete server";
  } finally {
    deleting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <AppShell :title="editing ? `MCP Server: ${form.name}` : 'New MCP Server'">
    <template #actions>
      <Button variant="secondary" icon="back" @click="router.push({ name: 'mcp-servers' })">Back</Button>
    </template>

    <div v-if="loading" class="loading-row">Loading…</div>
    <div v-else>
      <div class="two-col">
        <div class="form-col">
          <div v-if="errorMsg" class="banner err">{{ errorMsg }}</div>
          <Card title="Server definition">
            <Field label="Name" hint="Unique identifier profiles reference (e.g. filesystem, github-mcp). Lowercase.">
              <input v-model="form.name" class="ctrl mono" type="text" placeholder="my-server" :disabled="editing" />
            </Field>
            <Field label="Description" hint="Shown in the server list.">
              <input v-model="form.description" class="ctrl" type="text" placeholder="e.g. File system access for the agent." />
            </Field>
            <Field label="Transport" hint="stdio runs a local command; sse/http connects to a remote URL.">
              <select v-model="form.type" class="ctrl" :disabled="editing">
                <option v-for="t in TRANSPORTS" :key="t" :value="t">{{ t }}</option>
              </select>
            </Field>
          </Card>

          <!-- stdio fields -->
          <Card v-if="form.type === 'stdio'" title="stdio configuration">
            <Field label="Command" hint="The command to launch (e.g. npx, node, python).">
              <input v-model="form.command" class="ctrl mono" type="text" placeholder="npx" />
            </Field>
            <Field label="Arguments" hint="Space-separated args passed to the command.">
              <input v-model="form.args" class="ctrl mono" type="text" placeholder="-y @modelcontextprotocol/server-filesystem /tmp" />
            </Field>
            <Field label="Environment" hint="One KEY=VALUE per line. Optional.">
              <textarea v-model="form.env" class="ctrl mono" rows="3" placeholder="API_KEY=sk-…" />
            </Field>
          </Card>

          <!-- sse/http fields -->
          <Card v-if="form.type === 'sse' || form.type === 'http'" :title="`${form.type} configuration`">
            <Field label="URL" :hint="`The ${form.type} endpoint URL the agent connects to.`">
              <input v-model="form.url" class="ctrl mono" type="text" placeholder="https://mcp-server.example.com/sse" />
            </Field>
          </Card>

          <div class="actions">
            <Button variant="primary" icon="check" :loading="saving" @click="save">
              {{ editing ? "Save changes" : "Create server" }}
            </Button>
            <Button v-if="editing" variant="danger" icon="trash" :loading="deleting" @click="deleteServer">
              Delete
            </Button>
          </div>
        </div>

        <div class="context-col">
          <Card title="How it works">
            <p class="help">
              MCP servers are shared tool definitions. Create one here, then
              enable it on any profile via the profile's <strong>MCP servers</strong>
              selector. The OpenCode runtime loads enabled servers as tool providers
              for the agent. pi runs ignore the selection (pi has no MCP support).
            </p>
            <p class="help">
              <strong>stdio</strong> servers launch a local process (e.g. <code>npx @modelcontextprotocol/server-filesystem</code>).
              <strong>sse</strong> and <strong>http</strong> servers connect to a remote endpoint.
            </p>
          </Card>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.loading-row { text-align: center; padding: var(--space-8); color: var(--text-muted); }
.banner { padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); margin-bottom: var(--space-4); }
.banner.err { background: var(--surface-error, rgba(255,0,0,.1)); color: var(--text-error, #f66); }
.two-col { display: grid; grid-template-columns: 1fr 280px; gap: var(--space-6); align-items: start; }
.form-col { display: flex; flex-direction: column; gap: var(--space-4); }
.context-col { position: sticky; top: var(--space-4); }
.actions { display: flex; gap: var(--space-3); margin-top: var(--space-4); }
.help { font-size: var(--text-sm); color: var(--text-muted); line-height: 1.5; margin: 0 0 var(--space-3); }
.help:last-child { margin-bottom: 0; }
code { font-family: var(--font-mono); font-size: var(--text-sm); }
@media (max-width: 800px) {
  .two-col { grid-template-columns: 1fr; }
  .context-col { position: static; }
}
</style>
