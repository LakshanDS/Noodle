import { log } from "../util/log.js";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Per-model request throttle, enforced via pi's `before_provider_request`
 * extension hook (which is `await`ed immediately before every LLM HTTP call).
 *
 * `api_rpm` on a profile converts to a minimum interval between requests; the
 * gate sleeps to honor it. `0` (or unset → default 30) controls the limit. The
 * gate is keyed by `provider/model` so two profiles hitting different providers
 * throttle independently.
 *
 * pi already retries 429s with exponential backoff (3 attempts, 2000ms base);
 * this throttle is the proactive floor that prevents most 429s from firing.
 */

/**
 * PURE: convert a requests-per-minute limit to the minimum milliseconds between
 * consecutive requests. Exported for unit testing.
 */
export function rpmToMinIntervalMs(rpm: number): number {
  return Math.ceil(60_000 / rpm);
}

/**
 * Sleep helper, overridable for tests (so they don't actually wait).
 */
export type SleepFn = (ms: number) => Promise<void>;
export const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A throttle gate: call `await wait(key)` before each request to that key and it
 * will sleep just long enough to respect the configured rpm. Multiple keys share
 * one Throttle (e.g. one per Noodle process); each tracks its own last-request
 * timestamp. `now()` is injected for deterministic tests.
 */
export class Throttle {
  private readonly lastAt = new Map<string, number>();
  constructor(
    private readonly minIntervalMs: number,
    private readonly sleep: SleepFn = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {}

  async wait(key: string): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const t = this.now();
    const last = this.lastAt.get(key);
    const elapsed = last !== undefined ? t - last : Infinity;
    const waitMs = this.minIntervalMs - elapsed;
    if (waitMs > 0) {
      log.debug({ key, waitMs, interval: this.minIntervalMs }, "rate-limit throttle wait");
      await this.sleep(waitMs);
    }
    this.lastAt.set(key, this.now());
  }
}

/** Build a Throttle for a profile's api_rpm. Returns null when rpm is 0 (unlimited). */
export function throttleForRpm(
  rpm: number,
  sleep: SleepFn = defaultSleep,
  now: () => number = Date.now,
): Throttle | null {
  if (rpm <= 0) return null;
  return new Throttle(rpmToMinIntervalMs(rpm), sleep, now);
}

/**
 * An `ExtensionFactory` that gates every provider request through `throttle`.
 * Registered via `DefaultResourceLoader({ extensionFactories: [...] })`. The
 * `before_provider_request` handler is `await`ed by pi immediately before each
 * HTTP call, so a sleep in it serializes/gates the agent loop's requests.
 *
 * `key` is `provider/model` (passed in from run.ts so the factory stays generic;
 * the hook's payload is the request body, which carries the model name but not
 * the provider — so we key on the resolved profile).
 */
export function throttleExtensionFactory(throttle: Throttle, key: string): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("before_provider_request", async () => {
      await throttle.wait(key);
    });
  };
}
