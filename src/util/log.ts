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
 *
 * In addition to stdout, each line is teed into an in-memory ring buffer (see
 * `LogEntry` / `getRecentLogs`) so the dashboard's "System log" tab can show the
 * same output `docker logs` captures — without shelling out or reading files.
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

/**
 * One captured log line for the dashboard. Mirrors what the pretty formatter
 * renders to stdout, but as structured data so the UI can color by level and
 * filter without re-parsing text. `fields` is the trailing key=value map (pino
 * internals + run-context already stripped).
 */
export interface LogEntry {
  /** ISO timestamp (UTC, no trailing Z) — same string the pretty line shows. */
  ts: string;
  /** Numeric pino level (10 trace … 60 fatal). */
  level: number;
  /** Uppercase level label (INFO, WARN, …). */
  levelLabel: string;
  /** The log message. */
  msg: string;
  /** Trailing per-event fields, already stringified (key → value). */
  fields: Record<string, string>;
}

/**
 * Cap on how many lines the ring buffer keeps. Bounded so a long-running
 * container can't grow memory unbounded; 1000 is enough history for the
 * dashboard without holding the entire run in memory.
 */
const LOG_BUFFER_MAX = 1000;
const logBuffer: LogEntry[] = [];

/**
 * Snapshot the current ring buffer, oldest-first. The array is copied so callers
 * can iterate without the buffer mutating under them. `getRecentLogs` returns
 * the last `limit` entries (default: all). The buffer starts empty on each boot
 * (it's in-memory), which mirrors `docker logs --since` on a fresh container.
 */
export function getRecentLogs(limit?: number): LogEntry[] {
  if (limit === undefined || limit >= logBuffer.length) return [...logBuffer];
  return logBuffer.slice(logBuffer.length - limit);
}

/**
 * Render one parsed pino record to the pretty stdout line AND tee it into the
 * ring buffer. Returns the formatted string (without trailing newline) so the
 * caller can batch stdout writes when multiple records arrive in one chunk.
 */
function formatLine(obj: Record<string, unknown>): { pretty: string; entry: LogEntry } {
  const ts = new Date(obj.time as number).toISOString().replace("T", " ").replace("Z", "");
  const lvl = LEVELS[obj.level as number] ?? String(obj.level);
  const msg = (obj.msg as string) ?? "";

  // Trailing key=value: skip pino internals + run-context (it's in the
  // header). Per-event fields are kept; callers avoid duplicating a value
  // that's already in the message text.
  const fieldKeys = Object.keys(obj).filter(
    (k) => !SKIP_KEYS.has(k) && !RUN_CONTEXT_KEYS.has(k),
  );
  const fields: Record<string, string> = {};
  for (const k of fieldKeys) fields[k] = fmtValue(obj[k]);
  const fieldsStr = fieldKeys.map((k) => `${k}=${fmtValue(obj[k])}`).join(" ");

  const useColor = process.stdout.isTTY;
  const lvlStr = useColor ? `${COLORS[obj.level as number] ?? ""}${lvl}${RESET}` : lvl;
  const msgStr = useColor ? `\x1b[36m${msg}${RESET}` : msg;
  const pretty = `[${ts}] ${lvlStr}: ${msgStr}${fieldsStr ? " " + fieldsStr : ""}`;
  const entry: LogEntry = { ts, level: obj.level as number, levelLabel: lvl, msg, fields };
  return { pretty, entry };
}

/**
 * pino destination that renders each log line as `[ts] LEVEL: msg key=val …`.
 *
 * Pino emits one JSON object per line, but may batch several into a single
 * `write()` call during bursts (e.g. a busy agent run). We split the chunk on
 * newlines and parse+render each line individually, so every record reaches
 * stdout AND the ring buffer — not just the ones lucky enough to arrive alone.
 */
const prettyStdout = new Writable({
  decodeStrings: false,
  write(chunk: Buffer | string, _enc, cb) {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    // Pino lines are newline-delimited JSON. Split, drop the trailing empty
    // element from the final `\n`, and process each non-empty line.
    const lines = text.split("\n");
    const out: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        // Not a pino record — pass through untouched to stdout.
        out.push(line);
        continue;
      }
      const { pretty, entry } = formatLine(obj);
      out.push(pretty);
      // Tee into the ring buffer for the dashboard's System log tab.
      logBuffer.push(entry);
    }
    // Trim the buffer once for the whole batch (cheaper than per-line).
    if (logBuffer.length > LOG_BUFFER_MAX) {
      logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
    }
    process.stdout.write(out.join("\n") + "\n");
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
