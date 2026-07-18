import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { NoodleConfig, Profile } from "../config/schema.js";
import { log } from "../util/log.js";

/**
 * Every profile is a custom endpoint — defined by base_url + api + api_key.
 * Register each with pi's ModelRegistry so the subsequent find() resolves.
 *
 * Returns a map from profile name → the provider key used in the registry.
 * Profile names are unique, so each is used directly as the provider key —
 * no dedup logic needed.
 */
export function registerCustomProviders(
  config: NoodleConfig,
  registry: ModelRegistry,
): Map<string, string> {
  const providerKeyMap = new Map<string, string>();

  for (const [name, profile] of Object.entries(config.profiles)) {
    const apiKey = resolveApiKey(profile);

    // Profile name is unique — use it directly as the provider key.
    providerKeyMap.set(name, name);

    try {
      registry.registerProvider(name, {
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
          api: profile.api,
          baseUrl: profile.base_url,
          priced,
        },
        "registered custom provider",
      );
    } catch (e) {
      throw new Error(
        `Failed to register custom provider for profile "${name}": ${(e as Error).message}`,
      );
    }
  }

  return providerKeyMap;
}

/**
 * Resolve the API key for an endpoint. Reads it directly from the profile's
 * `api_key` field. An empty string means no-auth (e.g. local Ollama); we pass a
 * placeholder so pi's "apiKey required" validation passes — the endpoint ignores it.
 */
function resolveApiKey(p: Profile): string {
  return p.api_key || "noodle-no-auth";
}
