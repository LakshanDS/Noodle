import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Writable } from "node:stream";

/**
 * The custom formatter in src/util/log.ts writes to `process.stdout`. To assert
 * on the rendered output we spy on stdout.write — which works here because, unlike
 * pino-pretty's worker-thread transport, our formatter runs in-process and writes
 * synchronously through `process.stdout.write`.
 */

let chunks: string[];

beforeEach(() => {
  vi.resetModules();
  chunks = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LOG_LEVEL;
});

/** Spy on stdout, load the module fresh (so LOG_LEVEL is re-read), return helpers. */
async function loadLog() {
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  const mod = await import("../src/util/log.js");
  return { mod, output: () => chunks.join(""), spy };
}

/**
 * Like loadLog, but also exposes getRecentLogs so we can assert on the ring
 * buffer contents (the dashboard's System log source). Same stdout spy.
 */
async function loadLogWithBuffer() {
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  const mod = await import("../src/util/log.js");
  return {
    mod,
    output: () => chunks.join(""),
    getRecentLogs: mod.getRecentLogs,
    subscribeLogs: mod.subscribeLogs,
    spy,
  };
}

describe("log", () => {
  it("renders a human-readable line: [timestamp] LEVEL: message", async () => {
    const { mod, output } = await loadLog();
    mod.log.info("hello world");
    const line = output().trim().split("\n").pop()!;
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] INFO: hello world$/);
    expect(line.startsWith("{")).toBe(false); // not JSON
  });

  it("does not emit raw JSON objects", async () => {
    const { mod, output } = await loadLog();
    mod.log.info({ foo: "bar", n: 42 }, "started");
    const line = output().trim().split("\n").pop()!;
    expect(line.startsWith("{")).toBe(false);
    expect(line).toContain("started");
    expect(line).toContain("foo=bar");
    expect(line).toContain("n=42");
  });

  it("respects LOG_LEVEL env var", async () => {
    process.env.LOG_LEVEL = "error";
    const { mod, output } = await loadLog();
    mod.log.info("should-not-appear");
    mod.log.error("should-appear");
    const out = output();
    expect(out).toContain("should-appear");
    expect(out).not.toContain("should-not-appear");
  });

  it("defaults LOG_LEVEL to info when unset", async () => {
    delete process.env.LOG_LEVEL;
    const { mod } = await loadLog();
    expect(mod.log.level).toBe("info");
  });

  it("renders all severity levels", async () => {
    process.env.LOG_LEVEL = "trace";
    const { mod, output } = await loadLog();
    mod.log.trace("t"); mod.log.debug("d"); mod.log.info("i"); mod.log.warn("w"); mod.log.error("e");
    const out = output();
    expect(out).toMatch(/\bTRACE: t/);
    expect(out).toMatch(/\bDEBUG: d/);
    expect(out).toMatch(/\bINFO: i/);
    expect(out).toMatch(/\bWARN: w/);
    expect(out).toMatch(/\bERROR: e/);
  });

  it("captures every line into the ring buffer when pino batches multiple records per write", async () => {
    // Pino may coalesce several log calls into one Writable.write() call — the
    // chunk arrives as newline-delimited JSON. Each record must still reach the
    // buffer (and stdout) individually, not just the first parseable line.
    process.env.LOG_LEVEL = "info";
    const { mod, getRecentLogs } = await loadLogWithBuffer();
    mod.log.info("first");
    mod.log.info("second");
    mod.log.info("third");
    const msgs = getRecentLogs().map((e) => e.msg);
    expect(msgs).toContain("first");
    expect(msgs).toContain("second");
    expect(msgs).toContain("third");
  });
});

describe("runLogger", () => {
  it("suppresses run-context fields from the trailing key=value dump", async () => {
    // Run context (jobId, repo, issue, branch, pid) is bound to the raw JSON
    // for grep/tools, but the pretty formatter hides it from per-event lines —
    // it's printed once on the run-header banner instead.
    const { mod, output } = await loadLog();
    const log_ = mod.runLogger({ jobId: "job-9", repo: "owner/repo", issue: 9, branch: "b", pid: 1 });
    log_.info("running");
    const line = output().trim().split("\n").pop()!;
    expect(line).toContain("running");
    expect(line).not.toContain("jobId=");
    expect(line).not.toContain("repo=");
    expect(line).not.toContain("issue=");
    expect(line).not.toContain("branch=");
  });

  it("binds context onto the raw JSON (accessible via bindings())", async () => {
    const { mod } = await loadLog();
    const log_ = mod.runLogger({ jobId: "job-9", repo: "owner/repo", issue: 9 });
    expect(log_.bindings()).toMatchObject({
      jobId: "job-9",
      repo: "owner/repo",
      issue: 9,
    });
  });

  it("inherits the parent's level", async () => {
    process.env.LOG_LEVEL = "warn";
    const { mod } = await loadLog();
    const log_ = mod.runLogger({ jobId: "x" });
    expect(log_.level).toBe("warn");
  });

  it("still renders non-context fields as key=value", async () => {
    const { mod, output } = await loadLog();
    const log_ = mod.runLogger({ jobId: "job-9" });
    log_.info({ step: "clone", durationMs: 42 }, "cloned");
    const line = output().trim().split("\n").pop()!;
    expect(line).toContain("step=clone");
    expect(line).toContain("durationMs=42");
  });
});

describe("subscribeLogs (live tail pub/sub)", () => {
  it("delivers each logged line to a live subscriber", async () => {
    process.env.LOG_LEVEL = "info";
    const { mod, subscribeLogs } = await loadLogWithBuffer();
    const received: string[] = [];
    const unsub = subscribeLogs((entry) => received.push(entry.msg));

    mod.log.info("live-1");
    mod.log.info("live-2");

    expect(received).toEqual(["live-1", "live-2"]);
    unsub();
  });

  it("does NOT deliver lines logged before subscribing (snapshot vs live)", async () => {
    process.env.LOG_LEVEL = "info";
    const { mod, subscribeLogs, getRecentLogs } = await loadLogWithBuffer();
    mod.log.info("before-subscribe");

    const received: string[] = [];
    const unsub = subscribeLogs((entry) => received.push(entry.msg));
    mod.log.info("after-subscribe");

    // The live stream only sees post-subscribe lines; history is via
    // getRecentLogs (the SSE route backfills from there on connect).
    expect(received).toEqual(["after-subscribe"]);
    expect(getRecentLogs().map((e) => e.msg)).toContain("before-subscribe");
    unsub();
  });

  it("stops delivery after the unsubscribe function is called", async () => {
    process.env.LOG_LEVEL = "info";
    const { mod, subscribeLogs } = await loadLogWithBuffer();
    const received: string[] = [];
    const unsub = subscribeLogs((entry) => received.push(entry.msg));

    mod.log.info("before-unsub");
    unsub();
    mod.log.info("after-unsub");

    expect(received).toEqual(["before-unsub"]);
  });

  it("supports multiple concurrent subscribers independently", async () => {
    process.env.LOG_LEVEL = "info";
    const { mod, subscribeLogs } = await loadLogWithBuffer();
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = subscribeLogs((e) => a.push(e.msg));
    const unsubB = subscribeLogs((e) => b.push(e.msg));

    mod.log.info("multi");

    expect(a).toEqual(["multi"]);
    expect(b).toEqual(["multi"]);
    unsubA();
    unsubB();
  });
});
