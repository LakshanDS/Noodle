/**
 * Inactivity-based stall timeout for agent runs.
 *
 * A wall-clock timeout can't be used here: a healthy agent run may legitimately
 * take hours. What we actually want to catch is a *hung* run — a dropped
 * socket, a deadlocked tool, an infinite spinner — where the agent is doing
 * nothing at all. pi emits an event on every action (tool call, turn boundary,
 * assistant message, tool output, compaction, retry), so "no event for N
 * minutes" is a strong signal that the run is stuck.
 *
 * ## Two budgets, not one — the silent-build problem
 *
 * pi emits no heartbeat, and a bash tool only emits `tool_execution_update`
 * when the underlying process actually writes output. So a legitimate 20-minute
 * build that prints nothing is *indistinguishable* from a hung process at the
 * event level: both are silent. To avoid killing such builds, the watcher uses
 * TWO inactivity budgets:
 *
 *   - `idleTimeoutMs` — applies when NO tool is running (agent is between
 *     turns, or waiting on an LLM call). Silence here usually means a dropped
 *     connection or deadlocked loop. Catch fast. Default 15 min.
 *   - `toolTimeoutMs` — applies while a tool is in flight (between
 *     `tool_execution_start` and `tool_execution_end`). Silence here is normal:
 *     a build, a test suite, a slow git clone. Use a much larger budget; reset
 *     on `tool_execution_update` so a chatty build never trips it. Default 60 min.
 *
 * The watcher switches budgets the moment a tool starts or ends, re-arming the
 * timer with the now-applicable budget.
 *
 * On stall we call pi's `session.abort()` — a clean shutdown ("abort current
 * operation and wait for agent to become idle") — which causes the in-flight
 * `session.prompt()` to reject. The run is tagged with `StallTimeoutError` so
 * the queue can avoid retrying it (a stall won't recover on its own).
 *
 * Mirrors the `Throttle` pattern: `now` is injected for deterministic tests.
 */

import { log } from "../util/log.js";

/**
 * Thrown when a run is aborted for inactivity. Distinct type so the queue's
 * retry logic can skip retrying it (a stalled run would just stall again).
 * Carries which budget tripped, for actionable log output.
 */
export class StallTimeoutError extends Error {
  constructor(stalledForMs: number, budget: "idle" | "tool") {
    const which = budget === "tool" ? " (while a tool was running)" : " (while waiting on the LLM)";
    super(
      `agent run stalled: no activity for ${Math.round(stalledForMs / 1000)}s${which} — ` +
        `aborting. A healthy long run emits events constantly; this is a hang.`,
    );
    this.name = "StallTimeoutError";
  }
}

/** Minimal session surface StallWatcher needs: subscribe to events + abort. */
export interface StallSession {
  subscribe?(fn: (event: unknown) => void): (() => void) | void;
  abort(): Promise<void>;
}

/** Fakeable setTimeout/clearTimeout for deterministic tests. */
export type SetTimer = (ms: number, fn: () => void) => NodeJS.Timeout;
export type ClearTimer = (t: NodeJS.Timeout) => void;
const defaultSetTimer: SetTimer = (ms, fn) => setTimeout(fn, ms);
const defaultClearTimer: ClearTimer = (t) => clearTimeout(t);

/** Event-shape helper: pull `type` off a pi event defensively. */
function eventType(e: unknown): string | undefined {
  if (e && typeof e === "object" && "type" in e) {
    return (e as { type?: string }).type;
  }
  return undefined;
}

/** Configuration for the two stall budgets. Either may be 0 (disabled). */
export interface StallBudgets {
  /** Max silence (ms) when no tool is running — LLM-call / between-turns silence. */
  idleTimeoutMs: number;
  /** Max silence (ms) while a tool is in flight — a build, test, clone, etc. */
  toolTimeoutMs: number;
}

/**
 * Tracks "time since the last poke" and fires once when it exceeds the active
 * budget. Construct one per run, around the `session.prompt()` call:
 *
 *   const watcher = new StallWatcher(session, { idleTimeoutMs, toolTimeoutMs });
 *   const unsub = watcher.attach();
 *   try { await session.prompt(...); }
 *   finally { watcher.dispose(); unsub?.(); }
 *
 * The active budget switches automatically on `tool_execution_start` /
 * `tool_execution_end` events. Both budgets disabled (≤ 0) → attach is a no-op.
 *
 * - Fires at most once. After firing, the timer is cleared (no repeat).
 * - Not re-entrant: `dispose()` is idempotent and clears any pending timer.
 */
export class StallWatcher {
  private timer: NodeJS.Timeout | null = null;
  private fired = false;
  /** True while a tool is in flight (tool_execution_start seen, no matching end). */
  private toolInFlight = false;

  constructor(
    private readonly session: StallSession,
    private readonly budgets: StallBudgets,
    private readonly now: () => number = Date.now,
    private readonly setTimer: SetTimer = defaultSetTimer,
    private readonly clearTimer: ClearTimer = defaultClearTimer,
  ) {}

  /** True when any stall detection is enabled (at least one budget > 0). */
  get enabled(): boolean {
    return this.budgets.idleTimeoutMs > 0 || this.budgets.toolTimeoutMs > 0;
  }

  /** True once the stall callback has fired (i.e. the run was aborted). */
  get didStall(): boolean {
    return this.fired;
  }

  /** Which budget is currently active — "tool" while a tool runs, else "idle". */
  get activeBudget(): "idle" | "tool" {
    return this.toolInFlight ? "tool" : "idle";
  }

  /**
   * The currently applicable budget, in ms. Tool-in-flight gets the (larger)
   * tool budget; otherwise the idle budget. Falls back to the other budget
   * when one is disabled, so disabling `toolTimeoutMs` doesn't disable stall
   * detection entirely while a tool runs.
   */
  private get activeTimeoutMs(): number {
    const idle = this.budgets.idleTimeoutMs;
    const tool = this.budgets.toolTimeoutMs;
    if (this.toolInFlight) {
      return tool > 0 ? tool : idle;
    }
    return idle > 0 ? idle : tool;
  }

  /**
   * Subscribe to the session and arm the timer. Returns an unsubscribe fn, or
   * undefined when disabled (nothing to unsubscribe).
   */
  attach(): (() => void) | undefined {
    if (!this.enabled) return undefined;
    if (typeof this.session.subscribe !== "function") {
      log.warn({ budgets: this.budgets }, "session.subscribe is not a function; stall watcher inactive");
      return undefined;
    }
    const unsub = this.session.subscribe((e) => this.handleEvent(e));
    this.arm();
    return () => {
      unsub?.();
    };
  }

  /**
   * Pi-event handler. Flips the tool-in-flight flag on tool lifecycle events
   * (which also re-arms with the new budget), and pokes (re-arms) on every
   * other event. `tool_execution_update` is the load-bearing one for long
   * chatty builds — it keeps resetting the tool budget.
   */
  private handleEvent(e: unknown): void {
    const type = eventType(e);
    if (type === "tool_execution_start") {
      this.toolInFlight = true;
      // Re-arm with the (larger) tool budget.
      this.arm();
      return;
    }
    if (type === "tool_execution_end") {
      this.toolInFlight = false;
      // Re-arm with the idle budget.
      this.arm();
      return;
    }
    // Any other event (turn_*, message_*, compaction_*, auto_retry_*,
    // tool_execution_update, agent_start/end) — poke to reset the clock.
    this.poke();
  }

  /**
   * Reset the inactivity timer. No-op once stalled — the run is being aborted.
   */
  poke(): void {
    if (this.fired) return;
    this.arm();
  }

  /**
   * Schedule the stall callback for `activeTimeoutMs` from now. Clears any
   * previously-armed timer first.
   */
  private arm(): void {
    if (this.fired) return;
    const ms = this.activeTimeoutMs;
    if (ms <= 0) return; // disabled
    if (this.timer) this.clearTimer(this.timer);
    const startedAt = this.now();
    const budget: "idle" | "tool" = this.toolInFlight ? "tool" : "idle";
    this.timer = this.setTimer(ms, () => {
      // Guard against a late fire after dispose (timer already cleared → no-op,
      // but the JS event loop may have already queued the callback).
      if (this.fired) return;
      this.fired = true;
      this.timer = null;
      const stalledFor = this.now() - startedAt;
      log.error(
        { stalledForMs: stalledFor, budget, ms },
        "agent run stalled — calling session.abort()",
      );
      // Fire-and-forget the abort: it resolves the in-flight prompt(), which
      // throws StallTimeoutError from the run loop (where we have the right
      // context to dispose + clean up). Errors here are logged, not thrown —
      // throwing from a timer callback would crash the process uncaught.
      this.session.abort().catch((e) => {
        log.error({ err: e }, "session.abort() rejected after stall; prompt() may hang");
      });
    });
  }

  /**
   * Clear any pending timer. Safe to call multiple times. Does NOT unsubscribe
   * the event listener — the caller does that with the fn returned by attach().
   */
  dispose(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
