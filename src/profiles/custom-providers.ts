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
 */
export function registerCustomProviders(config: NoodleConfig, registry: ModelRegistry): void {
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!isCustomEndpoint(profile)) continue;
    const apiKey = resolveApiKey(profile);
    try {
      registry.registerProvider(profile.provider, {
        baseUrl: profile.base_url,
        api: profile.api,
        apiKey,
        models: [
          {
            id: profile.model,
            name: profile.model,
            contextWindow: profile.context_window ?? 32768,
            maxTokens: profile.max_tokens ?? 8192,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });
      log.info(
        { profile: name, provider: profile.provider, api: profile.api, baseUrl: profile.base_url },
        "registered custom provider",
      );
    } catch (e) {
      throw new Error(
        `Failed to register custom provider for profile "${name}" (${profile.provider}): ${(e as Error).message}`,
      );
    }
  }
}

export function isCustomEndpoint(p: Profile): boolean {
  return Boolean(p.base_url && p.api);
}

/**
 * Resolve the API key for a custom endpoint.
 * - If api_key_env is set, read that env var (may be empty for local no-auth endpoints like Ollama).
 * - pi requires *some* apiKey string when models are defined, so default to a placeholder
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
