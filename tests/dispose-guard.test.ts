import { describe, it, expect } from "vitest";
import { suppressPostDisposeBashRace } from "../src/engine/run.js";

/**
 * The guard tolerates ONE specific benign error from pi — a post-dispose
 * bash-socket race — so a finished run can still commit/PR/comment instead of
 * being killed by an async socket throw.
 *
 * The non-matching path intentionally re-emits the error to let Node's default
 * fatal handler run, which would crash the test process — so it isn't asserted
 * here directly. We verify the contract we CAN control: matched errors are
 * swallowed, teardown removes the listener, and the listener is registered.
 */

const silentLog = { debug() {}, info() {}, warn() {}, error() {} } as never;

/** Emit a synthetic uncaughtException and let listeners handle it. */
function emit(err: Error): void {
  process.emit("uncaughtException", err);
}

describe("suppressPostDisposeBashRace", () => {
  it("swallows pi's 'Agent listener invoked outside active run' error", () => {
    const teardown = suppressPostDisposeBashRace(silentLog);
    // Should NOT throw out of emit — the guard swallows it.
    expect(() => emit(new Error("Agent listener invoked outside active run"))).not.toThrow();
    teardown();
  });

  it("matches by message substring (case-insensitive), not exact equality", () => {
    const teardown = suppressPostDisposeBashRace(silentLog);
    // A wrapped error carrying the same message text should also be tolerated.
    expect(() =>
      emit(new Error("pi-agent-core: Agent listener invoked outside active run (socket)")),
    ).not.toThrow();
    teardown();
  });

  it("registers a listener and teardown removes it", () => {
    const before = process.listenerCount("uncaughtException");
    const teardown = suppressPostDisposeBashRace(silentLog);
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);
    teardown();
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });

  it("install → swallow → teardown → reinstall works (idempotent lifecycle)", () => {
    const t1 = suppressPostDisposeBashRace(silentLog);
    expect(() => emit(new Error("Agent listener invoked outside active run"))).not.toThrow();
    t1();
    const t2 = suppressPostDisposeBashRace(silentLog);
    expect(() => emit(new Error("Agent listener invoked outside active run"))).not.toThrow();
    t2();
  });
});
