/**
 * Shared API types — mirror the server shapes so the front end is typed against
 * the real contract. Source of truth: src/server/run-store.ts (RunRow),
 * src/server/scheduler-store.ts (SchedulerRow), src/server/session-reader.ts (Parsed*).
 *
 * Kept hand-written (not imported from the server) because the client compiles
 * standalone in its own tsconfig with DOM libs.
 */

export type RunStatus = "running" | "succeeded" | "failed" | "no_changes";

/* ----- GitHub App creation (manifest flow) ----- */
export interface CreateAppResponse {
  manifest: Record<string, unknown>;
  state: string;
}

/* ----- GitHub repo/branch listing (for the cron form's autocomplete) ----- */
export interface RepoData {
  full_name: string;
  default_branch: string;
}
export interface BranchData {
  name: string;
}
export interface ReposResponse {
  repos: RepoData[];
}
export interface BranchesResponse {
  branches: BranchData[];
}

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
  /** Command trigger that drove this run (without leading slash). Null for cron/manual. */
  command: string | null;
  /** Which agent runtime ran this: "pi", "opencode", or null (legacy = pi). */
  runtime: string | null;
}

export interface SchedulerRow {
  id: number;
  name: string;
  repo: string;
  prompt: string;
  branch_name: string;
  cron_expression: string;
  profile: string | null;
  /** Custom label-set JSON, or null to use the global defaults. */
  labels: string | null;
  enabled: number; // 0 | 1
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TriggerRow {
  id: number;
  name: string;
  repo: string;
  event_type: string;
  event_action: string | null;
  branch_pattern: string | null;
  prompt: string;
  profile: string | null;
  branch_name: string;
  label: string | null;
  enabled: number; // 0 | 1
  last_triggered_at: string | null;
  last_run_status: string | null;
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
export interface SchedulersResponse {
  schedulers: SchedulerRow[];
}
export interface SchedulerDetailResponse {
  scheduler: SchedulerRow;
  runs: RunRow[];
}
export interface SchedulerMutationResponse {
  scheduler: SchedulerRow;
}
export interface TriggersResponse {
  triggers: TriggerRow[];
}
export interface TriggerDetailResponse {
  trigger: TriggerRow;
  runs: RunRow[];
}
export interface TriggerMutationResponse {
  trigger: TriggerRow;
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

/** Payload for creating a scheduler job. Mirrors parseSchedulerInput in ui-routes.ts. */
export interface SchedulerInput {
  name: string;
  repo: string;
  prompt: string;
  branch_name: string;
  cron_expression: string;
  profile: string | null;
  /** JSON label-set string, or null to use the global defaults. */
  labels?: string | null;
}

/** Payload for creating a trigger. Mirrors parseTriggerInput in ui-routes.ts. */
export interface TriggerInput {
  name: string;
  repo: string;
  event_type: string;
  event_action: string | null;
  branch_pattern: string | null;
  prompt: string;
  profile: string | null;
  branch_name: string;
  label: string | null;
}

/* ----- Slash commands (DB-backed: /api/commands) ----- */

/**
 * A user-defined slash command. When someone types `/<trigger>` in a GitHub
 * issue/comment, the agent wakes with `system_prompt` as its custom
 * instructions. Supports {system}, {pr}, {issue} template tags.
 */
export interface CommandRow {
  id: number;
  /** Trigger word without the leading slash, e.g. "question". */
  trigger: string;
  description: string;
  /** The custom instructions the agent wakes up with. */
  system_prompt: string;
  profile: string | null;
  /** Runtime override ("pi" | "opencode" | null = inherit). */
  runtime: string | null;
  enabled: number; // 0 | 1
  /** 1 for the seeded default /<agent> command (not deletable). */
  is_builtin: number; // 0 | 1
  /**
   * Custom label set as a JSON string ({cooking,cooked,failed} each {name,color}),
   * or null = use the global default labels. See Settings → GitHub labels.
   */
  labels: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommandsResponse {
  commands: CommandRow[];
}
export interface CommandDetailResponse {
  command: CommandRow;
}
export interface CommandMutationResponse {
  command: CommandRow;
}

/** Payload for creating/updating a command. */
export interface CommandInput {
  trigger: string;
  description: string;
  system_prompt: string;
  profile: string | null;
  runtime?: string | null;
  /** JSON label-set string, or null to use the global defaults. */
  labels?: string | null;
}

/* ----- Skills (filesystem-backed: /api/skills) ----- */

/**
 * A skill — mirrors the frontmatter + body of a bundled SKILL.md file. Keyed by
 * name (the folder identifier), like profiles are keyed by name.
 */
export interface SkillRow {
  /** Folder / frontmatter name, e.g. "noodle-fix". */
  name: string;
  description: string;
  /** SKILL.md markdown body (everything below the frontmatter). */
  body: string;
  /** "bundled" for the seeded built-ins, "custom" for UI-created skills. */
  source: "bundled" | "custom";
  updated_at: string;
}

export interface SkillsResponse {
  skills: SkillRow[];
}
export interface SkillDetailResponse {
  skill: SkillRow;
}
export interface SkillMutationResponse {
  skill: SkillRow;
}

/** Payload for creating/updating a skill. */
export interface SkillInput {
  name: string;
  description: string;
  body: string;
}

/* ----- System log (in-memory ring buffer; mirrors `docker logs`) ----- */

/** One captured log line from the server's pino ring buffer. */
export interface LogEntry {
  /** ISO timestamp (UTC, no trailing Z) — same string the pretty line shows. */
  ts: string;
  /** Numeric pino level (10 trace … 60 fatal). */
  level: number;
  /** Uppercase level label (INFO, WARN, …). */
  levelLabel: string;
  /** The log message. */
  msg: string;
  /** Trailing per-event fields, stringified (key → value). */
  fields: Record<string, string>;
}

export interface LogsResponse {
  /** Entries newest-first. */
  entries: LogEntry[];
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

/* ----- Profiles (DB-managed agent profiles) ----- */

/** The 7 built-in tool names the agent can use. */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type Api =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "mistral-conversations";

/**
 * The full per-profile field set — mirrors ProfileSchema in
 * src/config/schema.ts. Every field the engine applies to a run lives here.
 */
export interface ProfileData {
  model: string;
  base_url: string;
  api: Api;
  /** The API key for this endpoint. Empty string = no-auth (e.g. local Ollama). */
  api_key: string;
  context_window?: number;
  max_tokens?: number;
  input_token_price: number;
  output_token_price: number;
  cache_read_price: number;
  cache_write_price: number;
  reasoning: boolean;
  thinking_level: ThinkingLevel;
  tools: string[];
  api_rpm: number;
  retry_max_attempts: number;
  retry_base_delay_ms: number;
  max_concurrent?: number;
  use_relay: boolean;
}

/** Where a profile comes from — always "db" now (profiles are DB-only). */
export type ProfileSource = "db";

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

/**
 * Body for POST /api/profiles/fetch-models — asks the server to query an
 * endpoint's OpenAI-compatible `/models` route. `api_key` is optional (local
 * no-auth endpoints). `model` is the id currently typed in the form, sent so
 * the server can report whether it's in the returned list.
 */
export interface FetchModelsInput {
  base_url: string;
  api_key?: string;
  model?: string;
}

/** Response from POST /api/profiles/fetch-models. */
export interface FetchModelsResponse {
  /** Sorted unique model ids the endpoint serves. */
  models: string[];
  /** True only when the optional `model` from the request is in `models`. */
  verified: boolean;
  /** False when the endpoint returned no models. */
  found: boolean;
}

/** Body for POST /api/profiles/test-model — sends a minimal completion request
 *  to verify the endpoint + key + model actually work end-to-end. */
export interface TestModelInput {
  base_url: string;
  api_key?: string;
  model: string;
  api?: Api;
}

/** Response from POST /api/profiles/test-model. */
export interface TestModelResponse {
  ok: boolean;
  status?: number;
  error?: string;
}

/* ----- Chats (interactive agent conversations) ----- */

export type ChatStatus = "idle" | "running" | "errored" | "disposed";

export interface ChatRow {
  id: number;
  title: string;
  repo: string;
  branch: string;
  default_branch: string;
  profile: string | null;
  /** Per-chat thinking-level override (off|minimal|low|medium|high|xhigh). */
  thinking_level: ThinkingLevel;
  workspace_path: string | null;
  session_dir: string | null;
  status: ChatStatus;
  last_error: string | null;
  preview: string;
  created_at: string;
  updated_at: string;
}

/** One turn in a chat thread (user / assistant / tool). */
export interface ChatMessageRow {
  id: number;
  chat_id: number;
  role: "user" | "assistant" | "tool";
  text: string;
  tool_name: string | null;
  tool_call_id: string | null;
  created_at: string;
}

export interface ChatsResponse {
  chats: ChatRow[];
}
export interface ChatDetailResponse {
  chat: ChatRow;
  messages: ChatMessageRow[];
}
export interface ChatMutationResponse {
  chat: ChatRow;
}
export interface NewChatInput {
  repo: string;
  branch: string;
  profile?: string | null;
  thinking_level?: ThinkingLevel;
  title?: string;
}

/**
 * SSE event frame from `/api/chats/:id/stream`. The `type` discriminant
 * selects the shape; the `data` envelope wraps the same object (the server
 * emits `event: {type}\ndata: {JSON}\n\n`).
 */
export type ChatStreamEvent =
  | { type: "turn_start" }
  | { type: "delta"; text: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_end"; name: string; ok: boolean; text: string }
  | { type: "turn_end"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };
