/**
 * Shared runtime-event helpers — consumed by `runJob` and `runCronJob` (formerly
 * duplicated between them). These operate on the normalized `RuntimeEvent`
 * union (see `./runtime.ts`), not on any runtime's native events, so both pi
 * and OpenCode runs log identically.
 *
 * Kept deliberately minimal so `docker logs` stays readable: one short line
 * per thing that matters. Tool outputs, args, turn boundaries, and streaming
 * updates are dropped here — they live in the persisted session file if ever
 * needed. The runtime also echoes each tool result back as a follow-up message;
 * we suppress that echo so a result isn't logged twice.
 */

import type { RuntimeEvent } from "./runtime.js";
import type { log as LogType } from "../util/log.js";

/**
 * Subscribe to a runtime session's events and mirror the meaningful ones into
 * the run log. One short line per event:
 *
 *   ▶ agent started
 *   » <full assistant reply>
 *   $ npm test                   (bash — the actual command)
 *   ✓ grep                       (tool finished ok)
 *   ✗ bash: <first line of err>  (tool errored)
 *   ↻ retry 1/3: 429 …
 *   ♻ compacting context
 *
 * Returns the unsubscribe function (pass-through from `session.subscribe`).
 */
export function subscribeForLogging(
  session: { subscribe?(fn: (e: RuntimeEvent) => void): (() => void) | void },
  log_: typeof LogType,
): (() => void) | undefined {
  if (typeof session.subscribe !== "function") return undefined;
  // Text of the most recent tool result, so a follow-up assistant message that
  // just echoes it can be detected and skipped.
  let lastToolOutput = "";
  return session.subscribe((e: RuntimeEvent) => {
    switch (e.type) {
      case "agent_start":
        log_.info("▶ agent started");
        break;

      case "agent_end":
        log_.info(e.willRetry === true ? "■ agent finished (will retry)" : "■ agent finished");
        break;

      case "message_end": {
        // Only the assistant's own reply is useful as a log line.
        if (e.role && e.role !== "assistant") break;
        const text = e.text.trim();
        if (!text || text === lastToolOutput) break;
        lastToolOutput = "";
        log_.info(`» ${text}`);
        break;
      }

      case "tool_start":
        lastToolOutput = "";
        log_.info(toolStartLabel(e.tool, e.args));
        break;

      case "tool_end": {
        const isError = e.isError;
        const out = e.output.trim();
        lastToolOutput = out.slice(0, 300);
        if (isError) {
          log_.warn(`✗ ${e.tool}: ${truncate(firstLine(out), 200)}`);
        } else {
          log_.info(`✓ ${e.tool}`);
        }
        break;
      }

      case "retry":
        log_.warn(`↻ retry ${e.attempt}/${e.maxAttempts}: ${e.error}`);
        break;

      case "compaction":
        if (e.phase === "start") {
          log_.info("♻ compacting context");
        } else if (e.error) {
          log_.warn("♻ compaction failed");
        }
        break;

      case "activity":
        // Catch-all for runtime-specific output (e.g. a chatty build's partial
        // output) — no log line, just keeps the stall watcher fed.
        break;
    }
  }) ?? undefined;
}

/**
 * Label for a `tool_start` event. Each tool gets a short symbol + the one arg
 * that matters for log readability (a file path, a pattern, the shell command).
 * Shared by both run paths so they read the same in the console.
 */
function toolStartLabel(tool: string, args?: Record<string, unknown>): string {
  const a = args ?? {};
  const pathOf = () => (typeof a.path === "string" ? a.path : "?");
  const patternOf = () => (typeof a.pattern === "string" ? a.pattern : "?");
  switch (tool) {
    case "read":
      return `☰ read > ${pathOf()}`;
    case "write":
      return `✎ write > ${pathOf()}`;
    case "edit":
      return `✎ edit > ${pathOf()}`;
    case "bash": {
      const cmd = a.command;
      if (typeof cmd === "string" && cmd.trim()) return `$ ${truncate(cmd.replace(/\s+/g, " ").trim(), 300)}`;
      return "$ ?";
    }
    case "find":
      return `⌖ find > ${patternOf()}`;
    case "grep":
      return `⌕ grep > ${patternOf()}`;
    case "ls":
      return `≡ ls > ${pathOf()}`;
    default:
      return `▸ ${tool}`;
  }
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `… (+${s.length - max} more chars)` : s;
}

/** First non-empty line of `s`, trimmed — used to summarize a tool error. */
export function firstLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}
