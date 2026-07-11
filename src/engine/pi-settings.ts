import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Profile } from "../config/schema.js";
import { log } from "../util/log.js";

/**
 * Build a pi `SettingsManager` tuned from the profile's rate-limit + retry
 * config, so pi's internal retry logic coordinates with the provider's actual
 * limits instead of fighting them.
 *
 * pi has TWO retry layers:
 *
 *  1. Agent-level retry: when an LLM call fails with a 429 (after provider
 *     retry exhausts), pi removes the failed message and re-runs the whole turn
 *     after an exponential backoff (`retry_base_delay_ms * 2^(attempt-1)`).
 *     Configured via `retry_max_attempts` + `retry_base_delay_ms` on the profile.
 *
 *  2. Provider-level HTTP retry: the OpenAI SDK's built-in fetch retry. Fires
 *     BEFORE the agent retry and respects the provider's `Retry-After` header.
 *     Configured via `provider_max_retries` on the profile.
 *
 * The `before_provider_request` throttle (engine/throttle.ts) handles request
 * SPACING — pi has no native "delay each request" setting, so our throttle is
 * the only way to enforce a minimum interval. This function handles request
 * RECOVERY — what happens when a request fails despite the throttle.
 *
 * `cwd` + `agentDir` are passed through so pi discovers project-local
 * resources (skills, instructions) the same way the default would.
 */
export function buildSettingsManager(
  cwd: string,
  agentDir: string,
  profile: Pick<Profile, "api_rpm" | "retry_max_attempts" | "retry_base_delay_ms" | "provider_max_retries">,
): SettingsManager {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManager.applyOverrides({
    retry: {
      enabled: profile.retry_max_attempts > 0,
      maxRetries: profile.retry_max_attempts,
      baseDelayMs: profile.retry_base_delay_ms,
      provider: {
        maxRetries: profile.provider_max_retries,
        maxRetryDelayMs: 60_000,
      },
    },
  });

  log.debug(
    {
      apiRpm: profile.api_rpm,
      retryMax: profile.retry_max_attempts,
      retryBaseMs: profile.retry_base_delay_ms,
      providerMaxRetries: profile.provider_max_retries,
    },
    "configured pi retry settings from profile",
  );

  return settingsManager;
}
