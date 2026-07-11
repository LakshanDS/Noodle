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
  profiles: string[];
  default: string;
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
