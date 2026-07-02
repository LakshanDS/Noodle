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

/**
 * The wire protocol a custom endpoint speaks. Pick by what the endpoint mimics:
 * - openai-completions: Ollama, vLLM, LM Studio, DeepSeek, Cerebras, any OpenAI-compatible API
 * - anthropic-messages: Anthropic-format proxies/gateways (e.g. Cloudflare, Fireworks)
 * - openai-responses / azure-openai-responses: OpenAI/Azure Responses API
 * - google-generative-ai / google-vertex / mistral-conversations / bedrock-converse-stream: rarer
 *
 * Built-in providers (anthropic, openai, openrouter, ...) are resolved by name
 * and need no `api`/`base_url` — only set these for custom endpoints.
 */
export const Api = z.enum([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "bedrock-converse-stream",
]);

export const ProviderName = z.string().min(1); // pi supports many; validated at resolve time

/** A named agent profile pinned to one model + tool set. */
export const ProfileSchema = z.object({
  provider: ProviderName,
  model: z.string().min(1),
  /** Custom endpoint. When set with `api`, the profile is treated as a custom provider. */
  base_url: z.string().url().optional(),
  /** Wire protocol the custom endpoint speaks (required when base_url is set). */
  api: Api.optional(),
  /** Env var holding the endpoint's API key. Defaults to no auth (e.g. local Ollama). */
  api_key_env: z.string().optional(),
  /** Model metadata for custom endpoints (pi needs context window etc.). */
  context_window: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  thinking_level: ThinkingLevel.default("off"),
  tools: z.array(z.string()).default([...BUILTIN_TOOLS]),
  system_prompt_file: z.string().optional(),
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

export const NoodleConfigSchema = z.object({
  default_profile: z.string().min(1),
  profiles: z.record(z.string(), ProfileSchema),
  routing: z.array(RoutingRuleSchema).nullish().transform((v) => v ?? []),
  repos: z.record(z.string(), RepoOverrideSchema).nullish().transform((v) => v ?? {}),
});
export type NoodleConfig = z.infer<typeof NoodleConfigSchema>;

/**
 * Validate cross-references that zod can't express: every routing rule's
 * `profile` and the top-level `default_profile` must name a real profile.
 * Returns a list of human-readable error strings (empty = valid).
 */
export function crossValidate(config: NoodleConfig): string[] {
  const errors: string[] = [];
  const names = new Set(Object.keys(config.profiles));

  if (!names.has(config.default_profile)) {
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

  // Custom-endpoint profiles need both base_url and api together.
  for (const [name, p] of Object.entries(config.profiles)) {
    if (p.base_url && !p.api) {
      errors.push(`profiles.${name}: "api" is required when "base_url" is set (custom endpoint)`);
    }
    if (p.api && !p.base_url) {
      errors.push(`profiles.${name}: "base_url" is required when "api" is set (custom endpoint)`);
    }
  }

  for (const [repo, override] of Object.entries(config.repos)) {
    if (override.default_profile && !names.has(override.default_profile)) {
      errors.push(`repos.${repo}.default_profile "${override.default_profile}" is not defined`);
    }
  }

  return errors;
}
