/**
 * Stateless rate spacer for the relay. Every request sleeps a fixed interval
 * (`60000 / api_rpm` ms) before being forwarded — no timestamps, no memory, no
 * concurrency math. Because each profile runs with `max_concurrent: 1`, requests
 * to the same model arrive sequentially, so a flat sleep spaces them perfectly.
 *
 * The provider never sends a 429 because we never exceed the RPM.
 */

export interface ProfileConfig {
  model: string;
  api_key_env: string;
  api_rpm: number;
}

/**
 * Sleep `60000 / api_rpm` ms, then return the API key env var name for the
 * model. Throws if the model isn't configured. RPM ≤ 0 = unlimited (no sleep).
 */
export async function acquireSlot(
  profiles: Map<string, ProfileConfig>,
  model: string,
): Promise<string> {
  const profile = findProfileByModel(profiles, model);
  if (!profile) {
    throw new Error(`Model "${model}" is not configured in any profile`);
  }

  if (profile.api_rpm > 0) {
    await sleep(Math.ceil(60_000 / profile.api_rpm));
  }
  return profile.api_key_env;
}

function findProfileByModel(profiles: Map<string, ProfileConfig>, model: string): ProfileConfig | undefined {
  for (const profile of profiles.values()) {
    if (profile.model === model) return profile;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
