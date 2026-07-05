import { describe, it, expect } from "vitest";
import { StallWatcher, StallTimeoutError, type StallSession } from "../src/engine/stall.js";

/**
 * Deterministic fake timer: captures the ms budget the watcher armed with and
 * the pending callback instead of scheduling it for real. Tests fire manually.
 */
class FakeTimers {
  private pending: (() => void) | null = null;
  cleared = 0;
  /** The ms budget passed to the most recent setTimer call (the active budget). */
  lastArmedMs = 0;

  setTimer = (ms: number, fn: () => void): NodeJS.Timeout => {
    this.lastArmedMs = ms;
    this.pending = fn;
    // Truthy sentinel so StallWatcher's `if (this.timer)` guard treats it as set.
    return 1 as unknown as NodeJS.Timeout;
  };
  clearTimer = (_t: NodeJS.Timeout): void => {
    this.cleared++;
    this.pending = null;
  };

  get isArmed(): boolean {
    return this.pending !== null;
  }

  fire(): void {
    if (!this.pending) throw new Error("no timer armed");
    const fn = this.pending;
    this.pending = null;
    fn();
  }
}

/**
 * Fake session: records abort() calls and lets tests emit events to subscribers
 * via the typed helpers (start/end/update/other). Mirrors the event names the
 * real pi bash tool emits.
 */
class FakeSession implements StallSession {
  aborted = 0;
  private listeners: Array<(e: unknown) => void> = [];

  subscribe = (fn: (e: unknown) => void): (() => void) => {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  };

  abort = async (): Promise<void> => {
    this.aborted++;
  };

  private emit(e: unknown): void {
    for (const l of this.listeners) l(e);
  }

  toolStart(): void { this.emit({ type: "tool_execution_start", toolName: "bash" }); }
  toolEnd(): void { this.emit({ type: "tool_execution_end", toolName: "bash" }); }
  toolUpdate(): void { this.emit({ type: "tool_execution_update", toolName: "bash", partialResult: {} }); }
  /** A generic non-tool event (turn/message/etc.). */
  other(): void { this.emit({ type: "message_update" }); }
}

const IDLE = 15_000;
const TOOL = 60_000;

describe("StallWatcher — disabled modes", () => {
  it("is disabled when both budgets are 0", () => {
    const w = new StallWatcher(new FakeSession(), { idleTimeoutMs: 0, toolTimeoutMs: 0 });
    expect(w.enabled).toBe(false);
    expect(w.attach()).toBeUndefined();
  });

  it("is inert when the session has no subscribe function", () => {
    const session: StallSession = { abort: async () => {} };
    const w = new StallWatcher(session, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL });
    expect(w.attach()).toBeUndefined();
  });
});

describe("StallWatcher — idle budget (no tool running)", () => {
  it("arms with the idle budget on attach", () => {
    const t = new FakeTimers();
    const w = new StallWatcher(new FakeSession(), { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    expect(t.lastArmedMs).toBe(IDLE);
    expect(t.isArmed).toBe(true);
    w.dispose();
  });

  it("a generic event re-arms with the idle budget", () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    s.other();
    expect(t.lastArmedMs).toBe(IDLE);
    expect(w.activeBudget).toBe("idle");
    w.dispose();
  });

  it("fires on idle inactivity and calls session.abort()", async () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    t.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(w.didStall).toBe(true);
    expect(s.aborted).toBe(1);
  });
});

describe("StallWatcher — tool budget (the silent-build fix)", () => {
  it("switches to the larger tool budget on tool_execution_start", () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    expect(t.lastArmedMs).toBe(IDLE);
    s.toolStart();
    expect(w.activeBudget).toBe("tool");
    expect(t.lastArmedMs).toBe(TOOL);
    w.dispose();
  });

  it("tool_execution_update resets the tool clock (chatty build never trips)", () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    s.toolStart();
    // Simulate a long build that prints output periodically — each update re-arms.
    for (let i = 0; i < 50; i++) s.toolUpdate();
    expect(w.didStall).toBe(false);
    expect(t.isArmed).toBe(true);
    expect(t.lastArmedMs).toBe(TOOL);
    w.dispose();
  });

  it("fires on tool inactivity only after the larger tool budget elapses", async () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    s.toolStart();
    expect(t.lastArmedMs).toBe(TOOL);
    t.fire(); // would only fire after the full tool budget
    await Promise.resolve();
    await Promise.resolve();
    expect(w.didStall).toBe(true);
    expect(s.aborted).toBe(1);
  });

  it("switches back to the idle budget on tool_execution_end", () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    s.toolStart();
    expect(t.lastArmedMs).toBe(TOOL);
    s.toolEnd();
    expect(w.activeBudget).toBe("idle");
    expect(t.lastArmedMs).toBe(IDLE);
    w.dispose();
  });

  it("a silent build protected by the tool budget does NOT trip the idle budget", () => {
    // This is the core scenario the user raised: a build prints nothing for
    // longer than idleTimeoutMs. With the tool budget active, it must survive.
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    s.toolStart(); // toolInFlight=true, budget=TOOL
    // Without re-arming, the tool timer is set for TOOL ms. The idle budget
    // (IDLE, smaller) does NOT apply here — confirmed by lastArmedMs.
    expect(t.lastArmedMs).toBe(TOOL);
    expect(t.lastArmedMs).toBeGreaterThan(IDLE);
    expect(w.didStall).toBe(false);
    w.dispose();
  });
});

describe("StallWatcher — fallback when one budget is disabled", () => {
  it("falls back to idle budget while a tool runs when toolTimeoutMs is 0", () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: 0 }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    expect(t.lastArmedMs).toBe(IDLE);
    s.toolStart();
    // tool budget disabled → falls back to idle so detection still works.
    expect(t.lastArmedMs).toBe(IDLE);
    w.dispose();
  });

  it("falls back to tool budget when idle when idleTimeoutMs is 0", () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: 0, toolTimeoutMs: TOOL }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    expect(t.lastArmedMs).toBe(TOOL);
    w.dispose();
  });
});

describe("StallWatcher — lifecycle", () => {
  it("does not fire a second time after stalling", async () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    t.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.aborted).toBe(1);
    // After firing, events are no-ops (no re-arm).
    s.other();
    expect(t.isArmed).toBe(false);
    expect(s.aborted).toBe(1);
  });

  it("dispose clears the pending timer", () => {
    const t = new FakeTimers();
    const w = new StallWatcher(new FakeSession(), { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    expect(t.isArmed).toBe(true);
    w.dispose();
    expect(t.isArmed).toBe(false);
    expect(t.cleared).toBeGreaterThanOrEqual(1);
  });
});

describe("StallTimeoutError", () => {
  it("includes the stalled duration and budget in the message", () => {
    const idle = new StallTimeoutError(900_000, "idle");
    expect(idle.message).toMatch(/900s/);
    expect(idle.message).toMatch(/LLM/);
    expect(idle.name).toBe("StallTimeoutError");

    const tool = new StallTimeoutError(3_600_000, "tool");
    expect(tool.message).toMatch(/3600s/);
    expect(tool.message).toMatch(/tool was running/);
  });
});
