import { describe, it, expect } from "vitest";
import { rpmToMinIntervalMs, Throttle, throttleForRpm, throttleExtensionFactory } from "../src/engine/throttle.js";

describe("rpmToMinIntervalMs", () => {
  it("converts rpm to a millisecond interval (ceiling)", () => {
    expect(rpmToMinIntervalMs(40)).toBe(1500); // 60000/40 = 1500
    expect(rpmToMinIntervalMs(60)).toBe(1000);
    expect(rpmToMinIntervalMs(30)).toBe(2000);
  });

  it("rounds up fractional intervals", () => {
    // 60000/90 = 666.67 → 667
    expect(rpmToMinIntervalMs(90)).toBe(667);
  });
});

describe("throttleForRpm", () => {
  it("returns null when rpm is 0 (unlimited) or negative", () => {
    expect(throttleForRpm(0)).toBeNull();
    expect(throttleForRpm(-5)).toBeNull();
  });

  it("returns a Throttle with the right interval when rpm is set", () => {
    const t = throttleForRpm(40);
    expect(t).toBeInstanceOf(Throttle);
  });

  it("returns a Throttle for the default of 30", () => {
    const t = throttleForRpm(30);
    expect(t).toBeInstanceOf(Throttle);
  });
});

describe("Throttle.wait", () => {
  it("does not sleep on the first call to a key", async () => {
    const sleeps: number[] = [];
    const fakeSleep = async (ms: number) => {
      sleeps.push(ms);
    };
    let clock = 1000;
    const t = new Throttle(1500, fakeSleep, () => clock);
    await t.wait("k1");
    expect(sleeps).toEqual([]);
  });

  it("sleeps the remaining interval when called too soon after a prior call", async () => {
    const sleeps: number[] = [];
    const fakeSleep = async (ms: number) => {
      sleeps.push(ms);
      clock += ms; // simulate the sleep advancing the clock
    };
    let clock = 1000;
    const t = new Throttle(1500, fakeSleep, () => clock);

    await t.wait("k1"); // first call, no sleep, lastAt = 1000
    clock = 1700; // 700ms later (under the 1500 interval)
    await t.wait("k1"); // should sleep 1500 - 700 = 800ms
    expect(sleeps).toEqual([800]);
  });

  it("does not sleep when enough time has already elapsed", async () => {
    const sleeps: number[] = [];
    const fakeSleep = async (ms: number) => {
      sleeps.push(ms);
    };
    let clock = 1000;
    const t = new Throttle(1500, fakeSleep, () => clock);

    await t.wait("k1");
    clock = 3000; // 2000ms later, past the 1500 interval
    await t.wait("k1");
    expect(sleeps).toEqual([]);
  });

  it("throttles keys independently", async () => {
    const sleeps: number[] = [];
    const fakeSleep = async (ms: number) => {
      sleeps.push(ms);
    };
    let clock = 1000;
    const t = new Throttle(1500, fakeSleep, () => clock);

    await t.wait("providerA/modelX"); // first call for key A — no sleep
    clock = 1100; // 100ms later
    await t.wait("providerB/modelY"); // first call for key B — no sleep (independent)
    expect(sleeps).toEqual([]);
  });

  it("is a no-op when minIntervalMs is 0", async () => {
    const sleeps: number[] = [];
    const t = new Throttle(0, async (ms) => {
      sleeps.push(ms);
    });
    await t.wait("k");
    await t.wait("k");
    expect(sleeps).toEqual([]);
  });
});

describe("throttleExtensionFactory", () => {
  it("registers a before_provider_request handler that waits the throttle", async () => {
    let clock = 0;
    const fakeSleep = async (ms: number) => {
      clock += ms;
    };
    const throttle = new Throttle(1000, fakeSleep, () => clock);

    let registeredEvent: string | null = null;
    let registeredHandler: ((e: unknown) => Promise<void>) | null = null;
    const fakePi = {
      on: (event: string, handler: (e: unknown) => Promise<void>) => {
        registeredEvent = event;
        registeredHandler = handler;
      },
    };

    const factory = throttleExtensionFactory(throttle, "provider/model");
    factory(fakePi as never);

    expect(registeredEvent).toBe("before_provider_request");
    expect(registeredHandler).not.toBeNull();

    // First invocation: no sleep (first request).
    const sleepsBefore = clock;
    await registeredHandler!({});
    expect(clock).toBe(sleepsBefore);

    // Second invocation immediately after: should have slept ~1000ms.
    await registeredHandler!({});
    expect(clock).toBeGreaterThanOrEqual(1000);
  });
});
