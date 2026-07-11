/**
 * Per-profile rate limiter for the relay. Each profile gets its own bucket
 * tracked by model name. Uses a mutex to serialize concurrent callers and
 * prevent race conditions.
 *
 * The limiter is in-memory (no SQLite needed) because the relay is a single
 * process. If the relay restarts, rate limit state resets — acceptable because
 * the provider's own window resets too.
 */

export interface ProfileConfig {
  model: string;
  api_key_env: string;
  api_rpm: number;
}

interface Bucket {
  lastAt: number;
  minIntervalMs: number;
  queue: Array<() => void>;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Wait until a slot is available for the given model. Uses the profile's
   * api_rpm to compute the minimum interval between requests. Returns the
   * API key env var name so the caller can resolve the actual key.
   *
   * Throws if the model is not configured.
   */
  async acquireSlot(profiles: Map<string, ProfileConfig>, model: string): Promise<string> {
    const profile = this.findProfileByModel(profiles, model);
    if (!profile) {
      throw new Error(`Model "${model}" is not configured in any profile`);
    }

    if (profile.api_rpm <= 0) {
      // Unlimited — no throttling.
      return profile.api_key_env;
    }

    const bucket = this.getOrCreateBucket(model, profile.api_rpm);
    await this.waitForSlot(bucket);

    return profile.api_key_env;
  }

  private findProfileByModel(profiles: Map<string, ProfileConfig>, model: string): ProfileConfig | undefined {
    for (const profile of profiles.values()) {
      if (profile.model === model) return profile;
    }
    return undefined;
  }

  private getOrCreateBucket(model: string, rpm: number): Bucket {
    let bucket = this.buckets.get(model);
    if (!bucket) {
      bucket = {
        lastAt: 0,
        minIntervalMs: Math.ceil(60_000 / rpm),
        queue: [],
      };
      this.buckets.set(model, bucket);
    }
    return bucket;
  }

  /**
   * Serialize access to the bucket using a promise-based queue.
   * The first caller dispatches; subsequent callers queue up.
   * Only one setTimeout is active at a time, preventing race
   * conditions when multiple callers arrive concurrently.
   */
  private async waitForSlot(bucket: Bucket): Promise<void> {
    return new Promise<void>((resolve) => {
      bucket.queue.push(resolve);
      if (bucket.queue.length > 1) {
        // Already have a waiter scheduled — the preceding
        // waiter's timeout will dequeue us when it fires.
        return;
      }
      this.dispatchNext(bucket);
    });
  }

  private dispatchNext(bucket: Bucket): void {
    const resolve = bucket.queue[0];
    if (!resolve) return;

    const t = this.now();
    const elapsed = t - bucket.lastAt;
    const waitMs = bucket.minIntervalMs - elapsed;

    if (waitMs <= 0) {
      bucket.lastAt = this.now();
      bucket.queue.shift();
      resolve();
      this.dispatchNext(bucket);
      return;
    }

    setTimeout(() => {
      bucket.lastAt = this.now();
      bucket.queue.shift();
      resolve();
      this.dispatchNext(bucket);
    }, waitMs);
  }

  /**
   * Get the current state of all buckets (for diagnostics).
   */
  getStats(): Array<{ model: string; lastAt: number; intervalMs: number }> {
    return Array.from(this.buckets.entries()).map(([model, bucket]) => ({
      model,
      lastAt: bucket.lastAt,
      intervalMs: bucket.minIntervalMs,
    }));
  }
}
