/**
 * Shared API types — mirror the server shapes so the front end is typed against
 * the real contract. Source of truth: src/server/run-store.ts (RunRow),
 * src/server/cron-store.ts (CronRow), src/server/session-reader.ts (Parsed*).
 *
 * Kept hand-written (not imported from the server) because the client compiles
 * standalone in its own tsconfig with DOM libs.
 */

export type RunStatus = "running" | "succeeded" | "failed" | "no_changes";

export interface RunRow {
  job_id: string;
  repo: string;
  /** Source issue number for normal runs; null for cron runs. */
  issue: number | null;
  branch: string;
  profile: string | null;
  model: string | null;
  status: RunStatus;
  pr_url: string | null;
  comment_url: string | null;
  summary: string | null;
  error: string | null;
  /** Never surfaced to the browser — the server strips it. Kept for type fidelity. */
  session_path: string | null;
  started_at: string;
  finished_at: string | null;
  cron_job_id: number | null;
  output_issue_url: string | null;
}

export interface CronRow {
  id: number;
  name: string;
  repo: string;
  prompt: string;
  branch_name: string;
  cron_expression: string;
  profile: string | null;
  enabled: number; // 0 | 1
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One assistant tool invocation. `args` is the raw arguments object. */
export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** A user or assistant turn. Assistant turns may carry tool calls alongside text. */
export interface ParsedChatMessage {
  role: "user" | "assistant";
  text: string;
  toolCalls?: ParsedToolCall[];
}

/** A tool result, rendered as a dim chip under the turn that produced it. */
export interface ParsedToolResult {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  text: string;
}

export type ParsedMessage = ParsedChatMessage | ParsedToolResult;

/* ----- Response envelopes ----- */

export interface RunsResponse {
  runs: RunRow[];
}
export interface RunDetailResponse {
  run: RunRow;
  messages: ParsedMessage[];
}
export interface CronsResponse {
  crons: CronRow[];
}
export interface CronDetailResponse {
  cron: CronRow;
  runs: RunRow[];
}
export interface CronMutationResponse {
  cron: CronRow;
}
export interface ProfilesResponse {
  /** Flat name list (cron dropdown contract). */
  profiles: string[];
  default: string;
  /** Full-detail list for the profiles tab. */
  items: ProfileListItem[];
}
export interface ApiError {
  error: string;
}

/** Payload for creating a cron. Mirrors parseCronInput in ui-routes.ts. */
export interface CronInput {
  name: string;
  repo: string;
  prompt: string;
  branch_name: string;
  cron_expression: string;
  profile: string | null;
}

/* ----- Settings (DB-backed instance secrets) ----- */

/** One entry in the settings catalog — tells the UI how to render the field. */
export interface SettingMeta {
  key: string;
  label: string;
  restartRequired: boolean;
  secret: boolean;
  hint?: string;
}

export interface SettingsResponse {
  catalog: SettingMeta[];
  /** Masked secrets ("••••last4") + cleartext non-secrets + "" for unset. */
  values: Record<string, string>;
  restartKeys: string[];
}

export interface SettingsPutResponse {
  ok: boolean;
  needsRestart: boolean;
  restartKeys: string[];
}

/* ----- Setup wizard (first-run) ----- */

export interface SetupStatus {
  configured: boolean;
  steps: { github: boolean; llm: boolean; ui: boolean };
  hasProfiles: boolean;
}

export interface SetupPayload {
  github: {
    token?: string;
    appId?: string;
    privateKey?: string;
    webhookSecret?: string;
  };
  llm: {
    provider: string;
    model: string;
    apiKey?: string;
    apiKeyEnv?: string;
    baseUrl?: string;
    api?: string;
  };
  uiPassword: string;
}

export interface SetupResponse {
  ok: boolean;
  needsRestart: boolean;
}

/* ----- Profiles (DB-managed agent profiles) ----- */

/** The 7 built-in tool names the agent can use. */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type Api = | "openai-completions" | "openai-responses" | "azure-openai-responses"
  | "anthropic-messages" | "google-generative-ai" | "google-vertex"
  | "mistral-conversations" | "bedrock-converse-stream";

/**
 * The full per-profile field set — mirrors ProfileSchema in
 * src/config/schema.ts. Every field the engine applies to a run lives here.
 */
export interface ProfileData {
  provider: string;
  model: string;
  base_url?: string;
  api?: Api;
  api_key_env?: string;
  context_window?: number;
  max_tokens?: number;
  input_token_price: number;
  output_token_price: number;
  cache_read_price: number;
  cache_write_price: number;
  reasoning: boolean;
  thinking_level: ThinkingLevel;
  tools: string[];
  system_prompt_file?: string;
  api_rpm: number;
  retry_max_attempts: number;
  retry_base_delay_ms: number;
  max_concurrent?: number;
}

/** Where a profile comes from — DB rows are editable/deletable; YAML are read-only. */
export type ProfileSource = "db" | "yaml";

/** One entry in the profiles list. */
export interface ProfileListItem {
  name: string;
  profile: ProfileData;
  source: ProfileSource;
}

/** Response shape from GET /api/profiles/:name. */
export interface ProfileDetailResponse {
  profile: ProfileListItem;
}

/** Response from POST/PATCH. */
export interface ProfileMutationResponse {
  profile: ProfileListItem;
}

/** Payload for create (POST). */
export interface ProfileInput {
  name: string;
  profile: ProfileData;
}
