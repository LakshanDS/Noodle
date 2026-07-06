import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { NoodleConfig, Profile } from "../config/schema.js";
import { log } from "../util/log.js";

/**
 * A profile is a "custom endpoint" if it has both base_url + api. Such profiles
 * point at an OpenAI-compatible or Anthropic-compatible endpoint that pi doesn't
 * know about by default (Ollama, vLLM, LM Studio, a corporate gateway, a proxy).
 *
 * Register each with pi's ModelRegistry so the subsequent find() resolves.
 * Built-in providers (anthropic, openai, openrouter, ...) are skipped — pi
 * already knows them.
 *
 * Returns a map from profile name → the provider key used in the registry, so
 * callers can look up the right model even when two profiles share a provider
 * name (e.g. both use `provider: nvidia`).
 */
export function registerCustomProviders(
  config: NoodleConfig,
  registry: ModelRegistry,
): Map<string, string> {
  const providerKeyMap = new Map<string, string>();

  // Track how many times each provider name has been used. pi's
  // registerProvider does a full model replacement per provider name, so two
  // profiles sharing one would clobber each other.
  const seen = new Map<string, number>();

  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!isCustomEndpoint(profile)) continue;
    const apiKey = resolveApiKey(profile);

    // Namespace duplicates: first use keeps the bare name, subsequent ones get
    // `-<profileName>` so each profile's models live under a unique key.
    const count = (seen.get(profile.provider) ?? 0) + 1;
    seen.set(profile.provider, count);
    const providerKey = count > 1 ? `${profile.provider}-${name}` : profile.provider;
    providerKeyMap.set(name, providerKey);

    try {
      registry.registerProvider(providerKey, {
        baseUrl: profile.base_url,
        api: profile.api,
        apiKey,
        models: [
          {
            id: profile.model,
            name: profile.model,
            contextWindow: profile.context_window ?? 32768,
            maxTokens: profile.max_tokens ?? 8192,
            // Opt-in: only true when the profile declares `reasoning: true`.
            // pi-ai gates all thinking-format handling on this flag, so a custom
            // endpoint must set it to receive the thinking_level.
            reasoning: profile.reasoning,
            input: ["text"],
            // USD per 1M tokens. Custom endpoints are $0 unless the profile sets
            // the *_price fields; pi computes cost from these during the run.
            // cache_read_price / cache_write_price matter only for providers that
            // expose prompt caching (e.g. an Anthropic-protocol proxy).
            cost: {
              input: profile.input_token_price,
              output: profile.output_token_price,
              cacheRead: profile.cache_read_price,
              cacheWrite: profile.cache_write_price,
            },
          },
        ],
      });
      const priced =
        profile.input_token_price > 0 ||
        profile.output_token_price > 0 ||
        profile.cache_read_price > 0 ||
        profile.cache_write_price > 0;
      log.info(
        {
          profile: name,
          provider: providerKey,
          api: profile.api,
          baseUrl: profile.base_url,
          priced,
        },
        "registered custom provider",
      );
    } catch (e) {
      throw new Error(
        `Failed to register custom provider for profile "${name}" (${profile.provider}): ${(e as Error).message}`,
      );
    }
  }

  return providerKeyMap;
}

export function isCustomEndpoint(p: Profile): boolean {
  return Boolean(p.base_url && p.api);
}

/**
 * Resolve the API key for a custom endpoint.
 * - If api_key_env is set, read that env var (may be empty for local no-auth endpoints like Ollama).
 * - pi requires *some* apiKey string when models are defined, so pass a placeholder
 *   for endpoints that ignore auth. For real auth, set the env var.
 */
function resolveApiKey(p: Profile): string {
  if (p.api_key_env) {
    return process.env[p.api_key_env] ?? "";
  }
  // No env var named: local endpoints (Ollama) typically need no auth; pass a placeholder
  // so pi's validation passes. The endpoint ignores it.
  return "noodle-no-auth";
}
