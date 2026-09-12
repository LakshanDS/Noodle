import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { LiveRunRegistry } from "../src/engine/live-runs.js";

/**
 * LiveRunRegistry now owns a per-job event bus (for the SSE stream) alongside
 * the live-session map (for cancel). These tests pin the bus lifecycle:
 * - events(jobId) is idempotent — same bus across calls
 * - emit(jobId, e) fans to listeners on that bus
 * - delete(jobId) drops the bus (and the session)
 * - isBusy reflects whether a live session is registered
 *
 * The AgentSession shape doesn't matter for these — `set` only stores the ref,
 * so a minimal stub is enough. (abort() behavior is exercised in the cancel
 * endpoint tests; not re-tested here.)
 */
const fakeSession = {} as never;

describe("LiveRunRegistry event bus", () => {
  it("events(jobId) returns the same EventEmitter across calls", () => {
    const reg = new LiveRunRegistry();
    const a = reg.events("job-1");
    const b = reg.events("job-1");
    expect(a).toBe(b);
    // Different jobs get different buses.
    expect(reg.events("job-2")).not.toBe(a);
  });

  it("emit() delivers RunStreamEvents to bus listeners", () => {
    const reg = new LiveRunRegistry();
    const received: unknown[] = [];
    reg.events("job-1").on("event", (e) => received.push(e));

    reg.emit("job-1", { type: "turn_start" });
    reg.emit("job-1", { type: "delta", text: "hello" });
    reg.emit("job-1", { type: "done" });

    expect(received).toEqual([
      { type: "turn_start" },
      { type: "delta", text: "hello" },
      { type: "done" },
    ]);
  });

  it("emit() is a no-op when no bus exists for the job", () => {
    const reg = new LiveRunRegistry();
    // Should not throw — just silently drops (no bus created → no listeners).
    expect(() => reg.emit("job-missing", { type: "done" })).not.toThrow();
  });

  it("isBusy() tracks the live session, independent of the bus", () => {
    const reg = new LiveRunRegistry();
    expect(reg.isBusy("job-1")).toBe(false);

    // Opening the bus alone does NOT make a run "busy" — only a registered
    // session does. (The SSE route uses isBusy to decide whether to synthesize
    // a terminal done; a bus with no session means the run already exited.)
    reg.events("job-1");
    expect(reg.isBusy("job-1")).toBe(false);

    reg.set("job-1", fakeSession);
    expect(reg.isBusy("job-1")).toBe(true);
    expect(reg.has("job-1")).toBe(true);
  });

  it("delete() drops both the session and the bus", () => {
    const reg = new LiveRunRegistry();
    const bus = reg.events("job-1");
    reg.set("job-1", fakeSession);

    reg.delete("job-1");

    expect(reg.has("job-1")).toBe(false);
    expect(reg.isBusy("job-1")).toBe(false);
    // A fresh bus is created after delete — the old one (and any listeners on
    // it) is gone. This is what lets a late SSE subscriber on a finished run
    // hit the synthesize-done path instead of hanging on a dead emitter.
    expect(reg.events("job-1")).not.toBe(bus);
  });

  it("listeners on a deleted bus no longer fire via emit()", () => {
    const reg = new LiveRunRegistry();
    let calls = 0;
    reg.events("job-1").on("event", () => calls++);
    reg.delete("job-1");
    reg.emit("job-1", { type: "done" });
    expect(calls).toBe(0);
  });

  it("EventEmitter is the standard node EventEmitter", () => {
    const reg = new LiveRunRegistry();
    expect(reg.events("job-1")).toBeInstanceOf(EventEmitter);
  });
});
