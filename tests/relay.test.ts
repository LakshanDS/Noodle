import { describe, it, expect } from "vitest";
import { acquireSlot, type ProfileConfig } from "../src/relay/rate-limiter.js";

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
    // 30 RPM → 2000ms.
    const local = new Map<string, ProfileConfig>([
      ["p", { model: "test-model", api_key: "sk-test", api_rpm: 30 }],
    ]);
    const start = Date.now();
    await acquireSlot(local, "test-model");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThan(1500);
  });

  it("sleeps every call — no first-call exemption (stateless)", async () => {
    // The spacer is stateless: every request sleeps, including the first.
    const local = new Map<string, ProfileConfig>([
      ["p", { model: "fresh-model", api_key: "sk-test", api_rpm: 30 }],
    ]);
    const start = Date.now();
    await acquireSlot(local, "fresh-model");
    expect(Date.now() - start).toBeGreaterThan(1500);
  });
});
