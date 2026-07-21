import { describe, it, expect } from "vitest";
import { StallWatcher, StallTimeoutError, type StallSession } from "../src/engine/stall.js";

/**
 * Deterministic fake timer: captures the ms budget the watcher armed with and
 * the pending callback instead of scheduling it for real. Tests fire manually.
 *
 * Supports MULTIPLE concurrent pending timers (the watcher arms an idle/tool
 * timer AND a separate rate-limit timer simultaneously). Each setTimer returns
 * a unique sentinel so clearTimer only clears the intended one. The legacy
 * single-timer API (lastArmedMs, isArmed, fire) operates on the most-recently
 * armed timer for backward compat with the idle/tool tests.
 */
class FakeTimers {
  private nextId = 1;
  /** Pending timers keyed by their unique sentinel id. */
  private pending = new Map<number, { ms: number; fn: () => void }>();
  cleared = 0;
  /** The ms budget passed to the most recent setTimer call (the active budget). */
  lastArmedMs = 0;

  setTimer = (ms: number, fn: () => void): NodeJS.Timeout => {
    this.lastArmedMs = ms;
    const id = this.nextId++;
    this.pending.set(id, { ms, fn });
    return id as unknown as NodeJS.Timeout;
  };
  clearTimer = (t: NodeJS.Timeout): void => {
    this.cleared++;
    this.pending.delete(t as unknown as number);
  };

  get isArmed(): boolean {
    return this.pending.size > 0;
  }

  /** Fire the most-recently-armed pending timer (legacy single-timer API). */
  fire(): void {
    const last = [...this.pending.entries()].pop();
    if (!last) throw new Error("no timer armed");
    const [id, { fn }] = last;
    this.pending.delete(id);
    fn();
  }

  /** Fire the pending timer armed with the given ms budget, if any. */
  fireByMs(ms: number): void {
    for (const [id, entry] of this.pending) {
      if (entry.ms === ms) {
        this.pending.delete(id);
        entry.fn();
        return;
      }
    }
  }

  /** True when a timer armed with the given ms budget is pending. */
  hasPending(ms: number): boolean {
    for (const entry of this.pending.values()) {
      if (entry.ms === ms) return true;
    }
    return false;
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
  /** pi's auto_retry_start event — carries the error message that triggered retry. */
  retryStart(errorMessage: string): void { this.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage }); }
  /** A successful assistant reply (the kind of progress that exits rate-limit state). */
  assistantOk(): void { this.emit({ type: "message_end", message: { role: "assistant", stopReason: "end_turn" } }); }
  /** An errored assistant reply — NOT progress; must not exit rate-limit state. */
  assistantError(): void { this.emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429" } }); }
}

const IDLE = 15_000;
const TOOL = 60_000;
// Distinct from IDLE/TOOL so hasPending(RATE_LIMIT) can tell the timers apart.
const RATE_LIMIT = 45_000;

describe("StallWatcher — disabled modes", () => {
  it("is disabled when both budgets are 0", () => {
    const w = new StallWatcher(new FakeSession(), { idleTimeoutMs: 0, toolTimeoutMs: 0, rateLimitTimeoutMs: 0 });
    expect(w.enabled).toBe(false);
    expect(w.attach()).toBeUndefined();
  });

  it("is inert when the session has no subscribe function", () => {
    const session: StallSession = { abort: async () => {} };
    const w = new StallWatcher(session, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: 0 });
    expect(w.attach()).toBeUndefined();
  });
});

describe("StallWatcher — idle budget (no tool running)", () => {
  it("arms with the idle budget on attach", () => {
    const t = new FakeTimers();
    const w = new StallWatcher(new FakeSession(), { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: 0 }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    expect(t.lastArmedMs).toBe(IDLE);
    expect(t.isArmed).toBe(true);
    w.dispose();
  });

  it("a generic event re-arms with the idle budget", () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: 0 }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    s.other();
    expect(t.lastArmedMs).toBe(IDLE);
    expect(w.activeBudget).toBe("idle");
    w.dispose();
  });

  it("fires on idle inactivity and calls session.abort()", async () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: 0 }, Date.now, t.setTimer, t.clearTimer);
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
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: 0 }, Date.now, t.setTimer, t.clearTimer);
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
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: 0 }, Date.now, t.setTimer, t.clearTimer);
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
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: 0 }, Date.now, t.setTimer, t.clearTimer);
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
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: 0 }, Date.now, t.setTimer, t.clearTimer);
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
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: 0 }, Date.now, t.setTimer, t.clearTimer);
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
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: 0, rateLimitTimeoutMs: 0 }, Date.now, t.setTimer, t.clearTimer);
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
    const w = new StallWatcher(s, { idleTimeoutMs: 0, toolTimeoutMs: TOOL, rateLimitTimeoutMs: 0 }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    expect(t.lastArmedMs).toBe(TOOL);
    w.dispose();
  });
});

describe("StallWatcher — lifecycle", () => {
  it("does not fire a second time after stalling", async () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: 0 }, Date.now, t.setTimer, t.clearTimer);
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
    const w = new StallWatcher(new FakeSession(), { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: 0 }, Date.now, t.setTimer, t.clearTimer);
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

    const rateLimit = new StallTimeoutError(900_000, "rateLimit");
    expect(rateLimit.message).toMatch(/900s/);
    expect(rateLimit.message).toMatch(/rate-limiting/);
  });
});

/**
 * Rate-limit budget regression: the idle/tool budgets both reset on ANY pi
 * event (including retry chatter), so a sustained 429 storm — where every
 * request is rejected but pi keeps emitting auto_retry_start events — keeps
 * them alive forever. The rate-limit budget measures CONSECUTIVE time in a
 * rate-limited state and fires independently.
 */
describe("StallWatcher — rate-limit budget (the 429-storm fix)", () => {
  it("does NOT enter rate-limited state on a non-429 retry error", () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: RATE_LIMIT }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    // A 404/auth error retry is NOT rate-limiting — don't arm the rate-limit timer.
    s.retryStart('404 "Not Found"');
    expect(w.trippedBudget).toBeUndefined();
    expect(t.hasPending(RATE_LIMIT)).toBe(false); // rate-limit timer NOT armed
    expect(t.isArmed).toBe(true); // idle/tool timer still armed
    w.dispose();
  });

  it("enters rate-limited state and arms the rate-limit timer on a 429 retry", () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: RATE_LIMIT }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    s.retryStart('Upstream 429: {"status":429,"title":"Too Many Requests"}');
    // The rate-limit timer is now armed with the RATE_LIMIT budget (alongside
    // the idle timer, which was poked by the retry event).
    expect(t.hasPending(RATE_LIMIT)).toBe(true);
    w.dispose();
  });

  it("fires (aborts) when the rate-limit budget elapses during a sustained 429 storm", async () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: RATE_LIMIT }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    s.retryStart("429 Too Many Requests");
    // Fire the rate-limit timer specifically — simulates RATE_LIMIT ms of
    // continuous 429s. (The idle timer is also armed but must NOT fire first.)
    t.fireByMs(RATE_LIMIT);
    await Promise.resolve();
    await Promise.resolve();
    expect(w.didStall).toBe(true);
    expect(w.trippedBudget).toBe("rateLimit");
    expect(s.aborted).toBe(1);
  });

  it("exits rate-limited state on real progress (a non-error assistant reply)", () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: RATE_LIMIT }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    s.retryStart("429 Too Many Requests");
    expect(t.hasPending(RATE_LIMIT)).toBe(true);
    // The agent recovers — a successful assistant reply is real progress.
    s.assistantOk();
    // The rate-limit timer is cleared on exit — no longer pending.
    expect(t.hasPending(RATE_LIMIT)).toBe(false);
    expect(w.didStall).toBe(false);
    w.dispose();
  });

  it("an errored assistant reply does NOT exit the rate-limited state", async () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: RATE_LIMIT }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    s.retryStart("429 Too Many Requests");
    // A 429-stopped assistant turn is NOT progress — keep measuring.
    s.assistantError();
    expect(t.hasPending(RATE_LIMIT)).toBe(true); // still armed
    // Fire the rate-limit budget → aborts despite the intervening error reply.
    t.fireByMs(RATE_LIMIT);
    await Promise.resolve();
    await Promise.resolve();
    expect(w.didStall).toBe(true);
    expect(w.trippedBudget).toBe("rateLimit");
  });

  it("rate-limit budget disabled (0) never fires even under sustained 429s", () => {
    const t = new FakeTimers();
    const s = new FakeSession();
    const w = new StallWatcher(s, { idleTimeoutMs: IDLE, toolTimeoutMs: TOOL, rateLimitTimeoutMs: 0 }, Date.now, t.setTimer, t.clearTimer);
    w.attach();
    s.retryStart("429 Too Many Requests");
    expect(t.hasPending(RATE_LIMIT)).toBe(false); // rate-limit timer not armed
    expect(w.didStall).toBe(false);
    w.dispose();
  });
});
