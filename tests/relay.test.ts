import { describe, it, expect } from "vitest";
import { acquireSlot, _resetRateLimiterForTests, type ProfileConfig } from "../src/relay/rate-limiter.js";

const profiles = new Map<string, ProfileConfig>([
  ["minimax", { model: "minimaxai/minimax-m3", api_key: "sk-nvidia-01", api_rpm: 38 }],
  ["glm", { model: "z-ai/glm-5.2", api_key: "sk-nvidia-02", api_rpm: 38 }],
  ["unlimited", { model: "unlimited-model", api_key: "sk-unlimited", api_rpm: 0 }],
]);

describe("acquireSlot (relay rate spacer)", () => {
  it("returns the API key for a known model", async () => {
    expect(await acquireSlot(profiles, "minimaxai/minimax-m3")).toBe("sk-nvidia-01");
  });

  it("throws for an unknown model", async () => {
    await expect(acquireSlot(profiles, "unknown-model")).rejects.toThrow(
      'Model "unknown-model" is not configured',
    );
  });

  it("does not sleep for unlimited RPM (rpm=0)", async () => {
    const start = Date.now();
    await acquireSlot(profiles, "unlimited-model");
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("sleeps ~60000/rpm ms for a metered model", async () => {
    // 30 RPM → 2000ms. The rate spacer is stateful (tracks last-request per
    // model), so the first call never sleeps. Seed the timestamp, then assert
    // the second call actually waits.
    _resetRateLimiterForTests();
    const local = new Map<string, ProfileConfig>([
      ["p", { model: "test-model", api_key: "sk-test", api_rpm: 30 }],
    ]);
    await acquireSlot(local, "test-model"); // seed lastRequest
    const start = Date.now();
    await acquireSlot(local, "test-model");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThan(1500);
  });

  it("sleeps every call after the first (stateful per-model tracking)", async () => {
    _resetRateLimiterForTests();
    const local = new Map<string, ProfileConfig>([
      ["p", { model: "fresh-model", api_key: "sk-test", api_rpm: 30 }],
    ]);
    await acquireSlot(local, "fresh-model"); // seed lastRequest
    const start = Date.now();
    await acquireSlot(local, "fresh-model");
    expect(Date.now() - start).toBeGreaterThan(1500);
  });
});

describe("acquireSlot — concurrency (every request is spaced, no bursts)", () => {
  // This is the core regression: before the fix, two concurrent requests for
  // the same model could both read the same stale `last` timestamp, both sleep
  // the same delta, and fire ~0ms apart — an unsynchronized burst past the RPM
  // limit. The promise-tail fix serializes them: the second only starts spacing
  // AFTER the first completes, so they land intervalMs apart.
  it("serializes concurrent requests for the same model (no overlap)", async () => {
    _resetRateLimiterForTests();
    const local = new Map<string, ProfileConfig>([
      ["p", { model: "conc-model", api_key: "sk-test", api_rpm: 30 }], // 2000ms
    ]);

    const fireTimes: number[] = [];
    // Record the wall-clock moment each request actually "fires" (post-sleep).
    const track = async () => {
      await acquireSlot(local, "conc-model");
      fireTimes.push(Date.now());
    };

    // Fire 3 concurrently — they MUST NOT overlap, must be ~2s apart.
    const start = Date.now();
    await Promise.all([track(), track(), track()]);
    const total = Date.now() - start;

    // 3 serialized requests at 2s spacing ≈ 4s total (request 2 waits 2s,
    // request 3 waits ~2s more). Allow slack for timer jitter.
    expect(total).toBeGreaterThan(3500);
    // Pairwise: each adjacent pair must be at least ~1.9s apart (no burst).
    fireTimes.sort((a, b) => a - b);
    expect(fireTimes[1]! - fireTimes[0]!).toBeGreaterThan(1800);
    expect(fireTimes[2]! - fireTimes[1]!).toBeGreaterThan(1800);
  });

  it("spaces independent models independently (different models don't block each other)", async () => {
    _resetRateLimiterForTests();
    const local = new Map<string, ProfileConfig>([
      ["a", { model: "model-a", api_key: "sk-a", api_rpm: 30 }],
      ["b", { model: "model-b", api_key: "sk-b", api_rpm: 30 }],
    ]);
    // Seed both so the next call sleeps.
    await acquireSlot(local, "model-a");
    await acquireSlot(local, "model-b");

    const start = Date.now();
    // Two different models, fired concurrently — should both fire near-simultaneously
    // (each only waits for ITS OWN last-request, not the other model's).
    await Promise.all([acquireSlot(local, "model-a"), acquireSlot(local, "model-b")]);
    // Both waited ~2s from their own seed; total ≈ 2s, NOT 4s (which would mean
    // they serialized against each other).
    expect(Date.now() - start).toBeLessThan(3500);
  });
});

