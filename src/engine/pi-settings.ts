import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Profile } from "../config/schema.js";
import { log } from "../util/log.js";

/**
 * Build a pi `SettingsManager` tuned from the profile's retry config, so pi's
 * internal agent-level retry uses our backoff (base × 2^attempt) instead of
 * its defaults.
 *
 * Only the agent-level retry is configured here. pi's provider (HTTP) layer
 * keeps its own built-in retry — that's the OpenAI SDK's hardcoded 0.5s → 8s
 * exponential with jitter, not something we expose or tune.
 *
 * `cwd` + `agentDir` are passed through so pi discovers project-local
 * resources (skills, instructions) the same way the default would.
 */
export function buildSettingsManager(
  cwd: string,
  agentDir: string,
  profile: Pick<Profile, "api_rpm" | "retry_max_attempts" | "retry_base_delay_ms">,
): SettingsManager {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManager.applyOverrides({
    retry: {
      enabled: profile.retry_max_attempts > 0,
      maxRetries: profile.retry_max_attempts,
      baseDelayMs: profile.retry_base_delay_ms,
    },
  });

  log.debug(
    {
      apiRpm: profile.api_rpm,
      retryMax: profile.retry_max_attempts,
      retryBaseMs: profile.retry_base_delay_ms,
    },
    "configured pi retry settings from profile",
  );

  return settingsManager;
}
