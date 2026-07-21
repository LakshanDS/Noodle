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
 * ## Three budgets
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
 * ## The rate-limit blind spot — a third budget
 *
 * The idle/tool budgets both reset on ANY pi event, including `auto_retry_*`,
 * `agent_start`, `agent_end`. During a sustained 429 storm pi emits these
 * constantly (every retry attempt), so the idle budget NEVER elapses even
 * though the run is making zero real progress — every request is being rejected
 * by the upstream. The run loops for hours re-poking a throttled endpoint.
 *
 * `rateLimitTimeoutMs` closes this: it measures CONSECUTIVE time spent in a
 * rate-limited state. The state is entered when pi emits an `auto_retry_start`
 * whose `errorMessage` looks like a 429/429-message ("429", "too many
 * requests", "rate limit", "upstream 429"), and exited on any *successful*
 * assistant activity (a non-error `message_end` for an assistant role, or a
 * tool call — real progress). When the run has been continuously rate-limited
 * for `rateLimitTimeoutMs`, we abort: "we've been getting 429'd for 15 min
 * straight, stop." This fires INDEPENDENTLY of the idle/tool budgets, so it
 * catches the storm even when those are being constantly re-armed by retry
 * chatter. Default 15 min; 0 = disabled.
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
  constructor(stalledForMs: number, budget: "idle" | "tool" | "rateLimit") {
    const which =
      budget === "tool"
        ? " (while a tool was running)"
        : budget === "rateLimit"
          ? " (sustained upstream rate-limiting)"
          : " (while waiting on the LLM)";
    super(
      `agent run stalled: no activity for ${Math.round(stalledForMs / 1000)}s${which} — ` +
        `aborting. A healthy long run emits events constantly; this is a hang.`,
    );
    this.name = "StallTimeoutError";
  }
}

/**
 * Regex matching error text that indicates an upstream rate-limit / transient
 * overload (as opposed to a fatal auth/404/quota error). Mirrors pi-ai's
 * `RETRYABLE_PROVIDER_ERROR_PATTERN` subset that matters for stall detection —
 * we want to enter the rate-limited state on 429-ish errors, not on a 404.
 */
const RATE_LIMIT_ERROR_PATTERN = /429|too many requests|rate.?limit|overloaded|upstream 429/i;

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

/** Configuration for the stall budgets. Any may be 0 (disabled). */
export interface StallBudgets {
  /** Max silence (ms) when no tool is running — LLM-call / between-turns silence. */
  idleTimeoutMs: number;
  /** Max silence (ms) while a tool is in flight — a build, test, clone, etc. */
  toolTimeoutMs: number;
  /**
   * Max CONSECUTIVE time (ms) spent in a rate-limited state (upstream 429s).
   * Independent of the idle/tool budgets: those reset on any pi event
   * (including retry chatter), so a 429 storm keeps them alive forever. This
   * budget measures sustained rate-limiting specifically and fires when it
   * has been continuous for this long. 0 = disabled.
   */
  rateLimitTimeoutMs: number;
}

/**
 * Tracks "time since the last poke" and fires once when it exceeds the active
 * budget. Construct one per run, around the `session.prompt()` call:
 *
 *   const watcher = new StallWatcher(session, { idleTimeoutMs, toolTimeoutMs, rateLimitTimeoutMs });
 *   const unsub = watcher.attach();
 *   try { await session.prompt(...); }
 *   finally { watcher.dispose(); unsub?.(); }
 *
 * The active budget switches automatically on `tool_execution_start` /
 * `tool_execution_end` events. All budgets disabled (≤ 0) → attach is a no-op.
 *
 * - Fires at most once. After firing, the timer is cleared (no repeat).
 * - Not re-entrant: `dispose()` is idempotent and clears any pending timer.
 */
export class StallWatcher {
  private timer: NodeJS.Timeout | null = null;
  private fired = false;
  /** Which budget tripped the stall (set when `fired`). Undefined before firing. */
  private firedBudget: "idle" | "tool" | "rateLimit" | undefined = undefined;
  /** True while a tool is in flight (tool_execution_start seen, no matching end). */
  private toolInFlight = false;
  /** True while the run is in a rate-limited state (entered on a 429-ish retry). */
  private rateLimited = false;
  /** The rate-limit budget's armed timer, separate from the idle/tool timer. */
  private rateLimitTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly session: StallSession,
    private readonly budgets: StallBudgets,
    private readonly now: () => number = Date.now,
    private readonly setTimer: SetTimer = defaultSetTimer,
    private readonly clearTimer: ClearTimer = defaultClearTimer,
  ) {}

  /** True when any stall detection is enabled (at least one budget > 0). */
  get enabled(): boolean {
    return (
      this.budgets.idleTimeoutMs > 0 ||
      this.budgets.toolTimeoutMs > 0 ||
      this.budgets.rateLimitTimeoutMs > 0
    );
  }

  /** True once the stall callback has fired (i.e. the run was aborted). */
  get didStall(): boolean {
    return this.fired;
  }

  /**
   * Which budget tripped the stall — "idle", "tool", or "rateLimit". Only
   * meaningful once `didStall` is true. Callers use this to build an accurate
   * StallTimeoutError (the rate-limit budget measures consecutive 429 time,
   * not idle time, so the duration + label differ).
   */
  get trippedBudget(): "idle" | "tool" | "rateLimit" | undefined {
    return this.firedBudget;
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
   * (which also re-arms with the new budget), tracks the rate-limited state
   * from `auto_retry_start` with a 429-ish error, and pokes (re-arms) on every
   * other event. `tool_execution_update` is the load-bearing one for long
   * chatty builds — it keeps resetting the tool budget.
   */
  private handleEvent(e: unknown): void {
    const type = eventType(e);

    // Rate-limit detection: enter on a 429-ish retry, exit on real progress.
    // This runs BEFORE the idle/tool poke so it can short-circuit the arm().
    if (type === "auto_retry_start") {
      const errMsg = (e as { errorMessage?: unknown })?.errorMessage;
      if (typeof errMsg === "string" && RATE_LIMIT_ERROR_PATTERN.test(errMsg)) {
        this.enterRateLimited();
      }
      // Still poke the idle/tool clock — a retry event is activity for those.
      this.poke();
      return;
    }
    // Real progress exits the rate-limited state: a non-error assistant reply
    // or any tool execution means we're no longer stuck on 429s.
    if (this.rateLimited && isProgressEvent(type, e)) {
      this.exitRateLimited();
    }

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
    // Any other event (turn_*, message_*, compaction_*, auto_retry_end,
    // tool_execution_update, agent_start/end) — poke to reset the clock.
    this.poke();
  }

  /**
   * Enter the rate-limited state and arm the rate-limit budget timer (if not
   * already in the state and the budget is enabled). Idempotent within a
   * continuous stretch — re-entering resets nothing, so the budget measures
   * the FULL consecutive duration.
   */
  private enterRateLimited(): void {
    if (this.fired) return;
    if (this.rateLimited) return; // already in the state — keep measuring
    this.rateLimited = true;
    this.armRateLimit();
  }

  /** Exit the rate-limited state (real progress seen). Clears the budget timer. */
  private exitRateLimited(): void {
    if (!this.rateLimited) return;
    this.rateLimited = false;
    if (this.rateLimitTimer) {
      this.clearTimer(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }
  }

  /** Arm the rate-limit budget timer for `rateLimitTimeoutMs` from now. */
  private armRateLimit(): void {
    if (this.fired) return;
    const ms = this.budgets.rateLimitTimeoutMs;
    if (ms <= 0) return; // disabled
    if (this.rateLimitTimer) this.clearTimer(this.rateLimitTimer);
    const startedAt = this.now();
    this.rateLimitTimer = this.setTimer(ms, () => {
      if (this.fired) return;
      // Still rate-limited when the budget elapsed → sustained storm → abort.
      if (!this.rateLimited) return;
      this.fire("rateLimit", startedAt);
    });
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
      if (this.fired) return;
      this.fire(budget, startedAt);
    });
  }

  /**
   * Shared abort path for all three budgets. Marks fired, clears the firing
   * timer, logs, and calls session.abort() (fire-and-forget — it resolves the
   * in-flight prompt(), which throws from the run loop where we can clean up).
   */
  private fire(budget: "idle" | "tool" | "rateLimit", startedAt: number): void {
    if (this.fired) return;
    this.fired = true;
    this.firedBudget = budget;
    this.timer = null;
    this.rateLimitTimer = null;
    const stalledFor = this.now() - startedAt;
    log.error(
      { stalledForMs: stalledFor, budget },
      "agent run stalled — calling session.abort()",
    );
    this.session.abort().catch((e) => {
      log.error({ err: e }, "session.abort() rejected after stall; prompt() may hang");
    });
  }

  /**
   * Clear any pending timer (idle/tool AND rate-limit). Safe to call multiple
   * times. Does NOT unsubscribe the event listener — the caller does that with
   * the fn returned by attach().
   */
  dispose(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.rateLimitTimer) {
      this.clearTimer(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }
  }
}

/**
 * Whether a pi event represents real agent progress (as opposed to retry
 * chatter or lifecycle noise). Used to EXIT the rate-limited state: a
 * non-error assistant reply or any tool execution means we're no longer stuck
 * on upstream 429s.
 */
function isProgressEvent(type: string | undefined, e: unknown): boolean {
  if (type === "tool_execution_start" || type === "tool_execution_end") return true;
  if (type === "message_end") {
    // Only a non-error assistant reply counts as progress. Tool/user
    // message_end events and error replies don't clear the rate-limit state.
    const msg = (e as { message?: { role?: string; stopReason?: string; errorMessage?: string } })?.message;
    if (msg?.role !== "assistant") return false;
    return msg.stopReason !== "error";
  }
  return false;
}
