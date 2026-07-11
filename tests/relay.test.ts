import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter, type ProfileConfig } from "../src/relay/rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;
  let clock: number;

  beforeEach(() => {
    clock = 1000;
    limiter = new RateLimiter(() => clock);
  });

  const profiles = new Map<string, ProfileConfig>([
    ["minimax", { model: "minimaxai/minimax-m3", api_key_env: "NVIDIA_API_KEY_01", api_rpm: 38 }],
    ["glm", { model: "z-ai/glm-5.2", api_key_env: "NVIDIA_API_KEY_02", api_rpm: 38 }],
    ["unlimited", { model: "unlimited-model", api_key_env: "UNLIMITED_KEY", api_rpm: 0 }],
  ]);

  it("returns the API key env for a known model", async () => {
    const keyEnv = await limiter.acquireSlot(profiles, "minimaxai/minimax-m3");
    expect(keyEnv).toBe("NVIDIA_API_KEY_01");
  });

  it("throws for an unknown model", async () => {
    await expect(limiter.acquireSlot(profiles, "unknown-model")).rejects.toThrow(
      'Model "unknown-model" is not configured',
    );
  });

  it("does not sleep on the first call (unlimited RPM)", async () => {
    const start = Date.now();
    await limiter.acquireSlot(profiles, "unlimited-model");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("throttles rapid calls on the same model", async () => {
    // First call — no sleep expected (first request)
    await limiter.acquireSlot(profiles, "minimaxai/minimax-m3");

    // Second call immediately after — should sleep for ~1579ms (60000/38)
    const start = Date.now();
    await limiter.acquireSlot(profiles, "minimaxai/minimax-m3");
    const elapsed = Date.now() - start;

    // Should have slept for approximately the interval (1579ms ± tolerance)
    expect(elapsed).toBeGreaterThan(1000);
  });

  it("throttles different models independently", async () => {
    await limiter.acquireSlot(profiles, "minimaxai/minimax-m3");
    clock = 1100; // 100ms later

    // Different model — should not be throttled
    const start = clock;
    await limiter.acquireSlot(profiles, "z-ai/glm-5.2");
    // No sleep expected for different model
  });

  it("serializes concurrent callers to the same model", async () => {
    // Fire two concurrent requests — the old code had a race condition where
    // both would set independent timers and fire near-simultaneously.
    const [r1, r2] = await Promise.all([
      limiter.acquireSlot(profiles, "minimaxai/minimax-m3"),
      limiter.acquireSlot(profiles, "minimaxai/minimax-m3"),
    ]);
    expect(r1).toBe("NVIDIA_API_KEY_01");
    expect(r2).toBe("NVIDIA_API_KEY_01");
  });

  it("returns correct stats", async () => {
    await limiter.acquireSlot(profiles, "minimaxai/minimax-m3");
    const stats = limiter.getStats();
    expect(stats).toHaveLength(1);
    expect(stats[0].model).toBe("minimaxai/minimax-m3");
    expect(stats[0].intervalMs).toBe(Math.ceil(60_000 / 38));
  });
});
