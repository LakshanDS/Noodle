/**
 * Stateful rate spacer for the relay. Tracks per-model last-request timestamps
 * so concurrent requests to the same model are properly spaced, even when
 * `max_concurrent > 1`. Falls back to a flat sleep for single-concurrency
 * profiles (the common case).
 *
 * The provider never sends a 429 because we never exceed the RPM.
 */

export interface ProfileConfig {
  model: string;
  api_key: string;
  api_rpm: number;
}

/** Per-model state: last request timestamp (ms since epoch). */
const lastRequest = new Map<string, number>();

/**
 * Sleep until the next allowed request for this model, then return the API key.
 * RPM ≤ 0 = unlimited (no sleep).
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
    const intervalMs = Math.ceil(60_000 / profile.api_rpm);
    const now = Date.now();
    const last = lastRequest.get(model) ?? 0;
    const waitMs = Math.max(0, last + intervalMs - now);
    if (waitMs > 0) await sleep(waitMs);
    lastRequest.set(model, Date.now());
  }
  return profile.api_key;
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
