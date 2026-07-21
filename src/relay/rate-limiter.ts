/**
 * Stateful rate spacer for the relay. Tracks per-model last-request timestamps
 * so concurrent requests to the same model are properly spaced, even when
 * `max_concurrent > 1`. Falls back to a flat sleep for single-concurrency
 * profiles (the common case).
 *
 * The provider never sends a 429 because we never exceed the RPM.
 *
 * ## Concurrency: every request, including retries, is spaced
 *
 * The earlier implementation had a read-last → sleep → set-last TOCTOU gap: two
 * concurrent requests for the same model could both read the same stale `last`,
 * both sleep the same delta, and both fire ~0ms apart. That's latent for a
 * single agent (the in-process throttle serializes its requests before they
 * reach the relay), but reachable when `max_concurrent > 1` OR when the relay's
 * own 429-retry loop re-fetches without re-spacing (the historical cause of
 * unsynchronized bursts during a 429 storm).
 *
 * Fix: serialize per-model spacing through a promise "tail". Each `acquireSlot`
 * call chains onto the previous one for the same model, so even N concurrent
 * callers are spaced `intervalMs` apart, one after another. The tail is the
 * ONLY state; `lastRequest` is derived inside the chain.
 *
 * ## Observability
 *
 * Every spacing decision is logged: `info` when the relay actually slept
 * (shows the model, RPM, interval, and how long it waited) and `debug` when a
 * request was already within budget (waitMs=0). Without this there was no way
 * to tell from `docker logs` whether rate-limiting was happening at all.
 */

import { log } from "../util/log.js";

export interface ProfileConfig {
  model: string;
  api_key: string;
  api_rpm: number;
}

/**
 * Per-model promise tail. Each in-flight (or pending) `acquireSlot` for a model
 * appends to this chain, so callers serialize: the next one only starts
 * computing its wait AFTER the previous one has set its timestamp and resolved.
 * This closes the read-sleep-write race under concurrency.
 *
 * Resolves to the api_key (kept for API parity; the relay's caller ignores it
 * in favor of the SDK's verbatim auth header).
 */
const tails = new Map<string, Promise<string>>();

/**
 * Sleep until the next allowed request for this model, then return the API key.
 * RPM ≤ 0 = unlimited (no sleep). Serialized per model via the `tails` chain so
 * concurrent callers never read the same stale timestamp.
 */
export async function acquireSlot(
  profiles: Map<string, ProfileConfig>,
  model: string,
): Promise<string> {
  const profile = findProfileByModel(profiles, model);
  if (!profile) {
    throw new Error(`Model "${model}" is not configured in any profile`);
  }

  // Unlimited profile — no spacing, no state, no chain.
  if (profile.api_rpm <= 0) return profile.api_key;

  const intervalMs = Math.ceil(60_000 / profile.api_rpm);

  // Chain onto the previous call for this model. The closure runs only once the
  // prior tail resolves, so `lastTs` is always the most recent completed write.
  const prev = tails.get(model) ?? Promise.resolve("");
  const next = prev.then(() => space(model, intervalMs, profile.api_rpm, profile.api_key));
  // Don't let a rejection in this call break the chain for future callers —
  // space() never throws, but be defensive.
  tails.set(model, next.catch(() => profile.api_key));
  return next;
}

/** Compute the wait for a single serialized caller, sleep, log, and return the key. */
async function space(model: string, intervalMs: number, rpm: number, apiKey: string): Promise<string> {
  const now = Date.now();
  const last = lastRequest.get(model) ?? 0;
  const waitMs = Math.max(0, last + intervalMs - now);
  if (waitMs > 0) {
    log.info({ model, rpm, intervalMs, waitMs }, "relay: rate-limit spacing");
    await sleep(waitMs);
  } else {
    log.debug({ model, rpm, intervalMs, waitMs: 0 }, "relay: rate-limit within budget");
  }
  lastRequest.set(model, Date.now());
  return apiKey;
}

/** Per-model last-request timestamp (ms since epoch). Written only inside `space`. */
const lastRequest = new Map<string, number>();

function findProfileByModel(profiles: Map<string, ProfileConfig>, model: string): ProfileConfig | undefined {
  for (const profile of profiles.values()) {
    if (profile.model === model) return profile;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Test-only: reset all per-model state (last-request timestamps + the
 * serialization chain). Production code never needs this; tests do, so each
 * case starts from a clean slate.
 */
export function _resetRateLimiterForTests(): void {
  lastRequest.clear();
  tails.clear();
}
