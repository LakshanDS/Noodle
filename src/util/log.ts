import pino from "pino";
import { Writable } from "node:stream";

/**
 * Noodle's logger. Always pretty to stdout — simple human-readable lines:
 *
 *   [2026-07-05 12:00:00.123] INFO: started agent run jobId=... repo=o/r
 *
 * No JSON in `docker logs`. Container platforms capture stdout natively, so
 * there's no per-run log file. Set LOG_LEVEL to trace|debug|info|warn|error.
 *
 * The custom formatter below replaces pino-pretty: pino-pretty always appends a
 * JSON blob of the bound fields, which is exactly the noisy output we wanted to
 * avoid. ~15 lines here gives the exact format we want with one less dep.
 */

const level = process.env.LOG_LEVEL ?? "info";

const LEVELS: Record<number, string> = {
  10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL",
};
const COLORS: Record<number, string> = {
  10: "\x1b[90m", 20: "\x1b[36m", 30: "\x1b[32m", 40: "\x1b[33m", 50: "\x1b[31m", 60: "\x1b[31m\x1b[1m",
};
const RESET = "\x1b[0m";
/** Always-suppressed pino internals. */
const SKIP_KEYS = new Set(["level", "time", "pid", "hostname", "msg"]);
/**
 * Run-context fields bound by `runLogger`. Suppressed from the trailing key=value
 * dump on every line — they're printed once on the run-header banner instead,
 * which keeps per-event lines readable. (They remain in the JSON for grep/tools.)
 */
const RUN_CONTEXT_KEYS = new Set(["jobId", "repo", "issue", "branch", "pid"]);

function fmtValue(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

/** pino destination that renders each log line as `[ts] LEVEL: msg key=val …`. */
const prettyStdout = new Writable({
  decodeStrings: false,
  write(chunk: Buffer | string, _enc, cb) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(typeof chunk === "string" ? chunk : chunk.toString());
    } catch {
      // Malformed line — pass through untouched.
      process.stdout.write(chunk);
      cb();
      return;
    }
    const ts = new Date(obj.time as number).toISOString().replace("T", " ").replace("Z", "");
    const lvl = LEVELS[obj.level as number] ?? String(obj.level);
    const msg = (obj.msg as string) ?? "";

    // Trailing key=value: skip pino internals + run-context (it's in the
    // header). Per-event fields are kept; callers avoid duplicating a value
    // that's already in the message text.
    const fields = Object.keys(obj)
      .filter((k) => !SKIP_KEYS.has(k) && !RUN_CONTEXT_KEYS.has(k))
      .map((k) => `${k}=${fmtValue(obj[k])}`)
      .join(" ");

    const useColor = process.stdout.isTTY;
    const lvlStr = useColor ? `${COLORS[obj.level as number] ?? ""}${lvl}${RESET}` : lvl;
    const msgStr = useColor ? `\x1b[36m${msg}${RESET}` : msg;
    process.stdout.write(`[${ts}] ${lvlStr}: ${msgStr}${fields ? " " + fields : ""}\n`);
    cb();
  },
});

export const log = pino({ level }, prettyStdout);

export type Logger = typeof log;

/**
 * A child logger with run context (jobId, repo, issue, branch, pid) bound onto
 * every line for correlation in the raw JSON. The pretty formatter suppresses
 * these from the trailing key=value dump (they appear once on the run-header
 * banner) so per-event lines stay readable. Used per agent-run; everything else
 * uses `log` directly.
 */
export function runLogger(context: Record<string, unknown>): Logger {
  return log.child(context);
}
