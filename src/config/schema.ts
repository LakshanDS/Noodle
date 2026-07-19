import { z } from "zod";

/** Tool names pi understands as built-ins. */
export const BUILTIN_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

export const ThinkingLevel = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

/** The thinking-level string union — the TS type backing `ThinkingLevel`. */
export type ThinkingLevelT = z.infer<typeof ThinkingLevel>;

/**
 * The wire protocol a custom endpoint speaks. Pick by what the endpoint mimics:
 * - openai-completions: Ollama, vLLM, LM Studio, DeepSeek, Cerebras, NVIDIA NIM,
 *   any OpenAI-compatible API (the common catch-all case)
 * - openai-responses: OpenAI's own Responses API (api.openai.com)
 * - anthropic-messages: Anthropic-format proxies/gateways (e.g. Cloudflare, Fireworks)
 * - google-generative-ai: Google Generative AI / Gemini endpoints
 * - mistral-conversations: Mistral's conversation API
 *
 * Built-in providers (anthropic, openai, openrouter, ...) are resolved by name
 * and need no `api`/`base_url` — only set these for custom endpoints.
 */
export const Api = z.enum([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
]);

/** A named agent profile pinned to one model + tool set. */
export const ProfileSchema = z.object({
  model: z.string().min(1),
  /** Endpoint URL every profile speaks (always required — all profiles are custom endpoints). */
  base_url: z.string().url(),
  /** Wire protocol the endpoint speaks. */
  api: Api,
  /** The API key for this endpoint. Empty string = no-auth (e.g. local Ollama). */
  api_key: z.string().default(""),
  /** Model metadata for custom endpoints (pi needs context window etc.). */
  context_window: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  /**
   * USD per 1M tokens — for cost reporting on custom endpoints, which pi
   * otherwise prices at $0. Set to your provider's published rates (e.g.
   * DeepSeek: input=0.14, output=0.28). Ignored for built-in providers, which
   * use pi-ai's built-in price table. 0 (default) = that token type isn't
   * priced (the corresponding cost contribution is $0).
   *
   * cache_read_price / cache_write_price only matter for providers that support
   * prompt caching (e.g. an Anthropic-protocol proxy). Most OpenAI-compatible
   * endpoints don't expose caching — leave them at 0.
   */
  input_token_price: z.number().min(0).default(0),
  output_token_price: z.number().min(0).default(0),
  cache_read_price: z.number().min(0).default(0),
  cache_write_price: z.number().min(0).default(0),
  /**
   * Whether this model supports reasoning/thinking. For built-in providers
   * (anthropic, openai o-series) pi-ai knows this automatically. For custom
   * endpoints, set `reasoning: true` when the underlying model is a
   * reasoning-capable one (DeepSeek-R1, Qwen3-Thinking, o-series proxy) so the
   * thinking_level is forwarded; otherwise leave false (default) and the level
   * is silently dropped. See pi-ai's per-provider thinking-format handling.
   */
  reasoning: z.boolean().default(false),
  thinking_level: ThinkingLevel.default("medium"),
  tools: z.array(z.string()).default([...BUILTIN_TOOLS]),
  /**
   * Max LLM requests per minute for this profile. Noodle installs a pre-request
   * throttle (via pi's `before_provider_request` extension hook) that sleeps to
   * enforce a minimum interval between requests — so the agent loop never
   * exceeds the provider's rate limit. `0` = unlimited (no throttle). Default: 30.
   *
   * pi has no native request-delay setting; this throttle is the only way to
   * space out requests. The interval is `60000 / api_rpm` ms (e.g. 38 rpm →
   * ~1.58s between requests).
   */
  api_rpm: z.number().int().min(0).default(30),
  /**
   * Max agent-level retries after a failed LLM turn (e.g. a 429 that exhausts
   * provider-level retry). pi removes the failed message and re-runs the turn
   * after an exponential backoff (`retry_base_delay_ms * 2^(attempt-1)`).
   * Default: 5. Set to 0 to disable agent-level retry entirely.
   */
  retry_max_attempts: z.number().int().min(0).default(5),
  /**
   * Base delay (ms) for agent-level retry backoff. Doubles each attempt. Should
   * be at least 2× the `api_rpm` interval so a retried turn doesn't land before
   * the provider's rate-limit window resets. Default: 3000.
   */
  retry_base_delay_ms: z.number().int().min(0).default(3000),
  /**
   * Max jobs of this profile that may run at the same time. Defaults to 1 — a
   * profile runs one job at a time unless this is raised. The dispatcher's
   * `claimNext` skips a queued job whose profile is already at its cap, so this
   * is the ONLY concurrency control: there's no global pool size. Profiles on
   * separate API keys can each run up to their own cap in parallel.
   */
  max_concurrent: z.number().int().min(1).default(1),
  /**
   * Route this profile's API requests through the relay server for rate
   * limiting. When true, the relay sleeps to enforce the `api_rpm` interval
   * before forwarding — so the in-process throttle is skipped (the relay
   * handles it). When false (default), requests go direct to the provider
   * and the in-process throttle enforces `api_rpm`.
   */
  use_relay: z.boolean().default(false),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** A routing rule. `match` semantics depend on `kind`. */
export const RoutingRuleSchema = z.object({
  kind: z.enum(["slash", "label", "keyword"]),
  match: z.string().min(1),
  profile: z.string().min(1), // name of a profile
});
export type RoutingRule = z.infer<typeof RoutingRuleSchema>;

export const RepoOverrideSchema = z.object({
  default_profile: z.string().optional(),
  // profiles/routing overrides could be added later; keep MVP narrow.
});
export type RepoOverride = z.infer<typeof RepoOverrideSchema>;

/**
 * Phase 2 server settings. All optional — omitted means the server block is
 * inactive and only the CLI / scheduler (if enabled) run.
 */
export const ServerConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().positive().max(65535).default(3000),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** Where the SQLite job queue + scan state live. */
export const StorageConfigSchema = z.object({
  sqlite_path: z.string().default("./noodle.db"),
});
export type StorageConfig = z.infer<typeof StorageConfigSchema>;

/**
 * Periodic cron scan of watched repos for new issues matching routing rules.
 * `repos` is the explicit list of owner/name repos to poll.
 */
export const SchedulerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Minutes between scans. */
  interval_minutes: z.number().int().positive().default(30),
  /** Repos to watch, as "owner/name". Required when enabled. */
  repos: z.array(z.string().min(1)).default([]),
});
export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;

/**
 * Per-run controls. The stall watcher aborts a run that has emitted no agent
 * activity (tool calls, turns, messages, tool output, compactions) for N
 * minutes — a strong signal of a hang (dropped socket, deadlock) that a
 * wall-clock timeout can't distinguish from a healthy hours-long run. See
 * src/engine/stall.ts for the two-budget design.
 */
export const RunConfigSchema = z.object({
  /**
   * Abort after this many minutes of silence while NO tool is running — i.e.
   * the agent is between turns or waiting on an LLM call. Silence here usually
   * means a dropped connection or deadlocked loop; catch it fast. 0 = off.
   * Default 15.
   */
  stall_timeout_minutes: z.number().int().min(0).default(15),
  /**
   * Abort after this many minutes of silence while a tool IS running — e.g. a
   * build, a test suite, a slow clone. Silence here is normal (a bash command
   * only emits events when the process writes output), so this must be larger
   * than stall_timeout_minutes. It still catches a genuinely hung tool; a chatty
   * build (which emits tool_execution_update) never trips it. Falls back to
   * stall_timeout_minutes when set to 0. Default 60.
   */
  tool_stall_minutes: z.number().int().min(0).default(60),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;

/**
 * Job-queue retry behavior. How many jobs run at once is controlled entirely by
 * each profile's `max_concurrent` cap (default 1) — the dispatcher's
 * `claimNext` skips a job whose profile is at its cap, so there's no global
 * pool size here. Each concurrent agent run holds a workspace + a pi session in
 * memory, so raise a profile's cap only with headroom.
 */
export const QueueConfigSchema = z.object({
  /** Total attempts per job (1 = no retry). */
  max_attempts: z.number().int().min(1).default(3),
  /** Base backoff seconds; doubles each attempt, capped at 10 min. */
  retry_backoff_seconds: z.number().int().min(1).default(60),
});
export type QueueConfig = z.infer<typeof QueueConfigSchema>;

/**
 * How the agent wakes up on an issue. By default Noodle is opt-in: it ONLY
 * runs when the issue or a comment carries an explicit wake signal (an
 * `@<agent>` mention, a listed keyword, a `/<agent>` slash command, or a
 * `#<profile>` tag). Without these filters the agent would fire on every new
 * issue in an installed repo — burning tokens on issues the reporter never
 * intended for it. Opt-in eliminates that.
 *
 *   - `trigger_on_mention: true` (default) — fires when body/comments @-mention
 *     the agent (e.g. `@Noodle`, `@noodle`, `@noodle-agent`). Case-insensitive,
 *     word-boundary-aware so `@noodles` does NOT match.
 *   - `trigger_keywords: [...]` — extra substrings (compared case-insensitive)
 *     that also fire when present in body or a comment.
 *   - `trigger_on_open: false` (default) — when `true`, the agent ALSO fires on
 *     any new/reopened/labeled issue regardless of mention/keyword; this
 *     restores the pre-opt-in behavior for users who want it.
 *
 * Slash commands (`/<agent>` in a comment), assignment to the agent, and a
 * `#<profile-name>` tag are always honored — they're explicit user intent
 * regardless of this config.
 */
export const TriggersConfigSchema = z.object({
  trigger_on_mention: z.boolean().default(true),
  trigger_keywords: z.array(z.string().min(1)).default([]),
  trigger_on_open: z.boolean().default(false),
});
export type TriggersConfig = z.infer<typeof TriggersConfigSchema>;

export const NoodleConfigSchema = z.object({
  /** Display name used in issue labels, comments, PR bodies, branch names, etc. */
  agent_name: z.string().min(1).default("Noodle"),
  /** The fallback profile when no routing rule matches. Loaded from the DB at boot. */
  default_profile: z.string().min(1).optional(),
  /** Profiles are loaded from the DB at boot; YAML profiles are not supported. */
  profiles: z.record(z.string(), ProfileSchema).default({}),
  routing: z.array(RoutingRuleSchema).nullish().transform((v) => v ?? []),
  repos: z.record(z.string(), RepoOverrideSchema).nullish().transform((v) => v ?? {}),
  server: ServerConfigSchema.nullish().transform((v) => v ?? { host: "0.0.0.0", port: 3000 }),
  storage: StorageConfigSchema.nullish().transform((v) => v ?? { sqlite_path: "./noodle.db" }),
  scheduler: SchedulerConfigSchema.nullish().transform((v) => v ?? {
    enabled: false,
    interval_minutes: 30,
    repos: [],
  }),
  run: RunConfigSchema.nullish().transform((v) => v ?? { stall_timeout_minutes: 15, tool_stall_minutes: 60 }),
  queue: QueueConfigSchema.nullish().transform((v) => v ?? {
    max_attempts: 3,
    retry_backoff_seconds: 60,
  }),
  /**
   * Wakeup filters for `issues.*` events (webhooks, scheduler scan). See
   * `TriggersConfigSchema` above. Slash commands, assignment, and `#<profile>`
   * tags are always honored regardless of this block.
   */
  triggers: TriggersConfigSchema.nullish().transform((v) => v ?? {
    trigger_on_mention: true,
    trigger_keywords: [],
    trigger_on_open: false,
  }),
});
export type NoodleConfig = z.infer<typeof NoodleConfigSchema>;

/**
 * Validate cross-references that zod can't express: every routing rule's
 * `profile` and the top-level `default_profile` must name a real profile.
 * Returns a list of human-readable error strings (empty = valid).
 *
 * When profiles is empty (profiles are loaded from the DB at boot, not from
 * the YAML), cross-references can't be checked yet — returns no errors. The
 * post-merge step in serve.ts handles validation once DB profiles are loaded.
 */
export function crossValidate(config: NoodleConfig): string[] {
  const errors: string[] = [];
  const names = new Set(Object.keys(config.profiles));

  // Profiles come from the DB — skip cross-reference checks when empty.
  if (names.size === 0) return errors;

  if (config.default_profile && !names.has(config.default_profile)) {
    errors.push(
      `default_profile "${config.default_profile}" is not defined in profiles`,
    );
  }

  for (const [i, rule] of config.routing.entries()) {
    if (!names.has(rule.profile)) {
      errors.push(
        `routing[${i}]: profile "${rule.profile}" is not defined in profiles`,
      );
    }
    if (rule.kind === "slash" && !rule.match.startsWith("/")) {
      errors.push(`routing[${i}]: slash rule match must start with "/"`);
    }
    if (rule.kind === "keyword") {
      try {
        new RegExp(rule.match);
      } catch (e) {
        errors.push(`routing[${i}]: invalid keyword regex "${rule.match}": ${(e as Error).message}`);
      }
    }
  }

  // base_url + api are both required (enforced by Zod). No pairing check needed.
  for (const [repo, override] of Object.entries(config.repos)) {
    if (override.default_profile && !names.has(override.default_profile)) {
      errors.push(`repos.${repo}.default_profile "${override.default_profile}" is not defined`);
    }
  }

  // NOTE: the repo-scan scheduler was removed (cron + webhooks + manual runs
  // cover all trigger paths now). The `scheduler` config block is still parsed
  // for back-compat so existing YAML configs don't crash on load, but it's no
  // longer validated or consumed — nothing boots from it.

  return errors;
}
