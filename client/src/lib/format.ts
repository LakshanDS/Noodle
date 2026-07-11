/**
 * Pure formatting helpers ported from the original single-file UI, so the new
 * Vue components render identically. No framework code here — just functions.
 */
import type { RunStatus } from "../api/types.js";

/** Short label for a run status, matching the old UI's statusText(). */
export function statusText(s: RunStatus): string {
  const map: Record<RunStatus, string> = {
    succeeded: "ok",
    failed: "fail",
    running: "running",
    no_changes: "no changes",
  };
  return map[s] ?? s;
}

/** Status → CSS color var, for dots/badges. */
export function statusColor(s: RunStatus): string {
  const map: Record<RunStatus, string> = {
    succeeded: "var(--ok)",
    failed: "var(--fail)",
    running: "var(--running)",
    no_changes: "var(--none)",
  };
  return map[s] ?? "var(--none)";
}

/**
 * Format an ISO/SQLite timestamp. SQLite stores naive UTC strings
 * (`datetime('now')`); append Z so JS treats them as UTC, then render locally.
 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** `owner/name` → `name` (the repo leaf), for compact titles. */
export function repoLeaf(repo: string): string {
  return repo.split("/").pop() || repo;
}

/**
 * A collapsed one-line label for a tool call, ported from summarizeArgs().
 * Shows a filename for read/edit/write, the command head for bash, the pattern
 * for grep/glob, else just the tool name.
 */
export function summarizeArgs(name: string, args: Record<string, unknown>): string {
  if (name === "read" || name === "edit" || name === "write") {
    const p = String(args.path ?? "");
    return p.split(/[/\\]/).pop() || p || name;
  }
  if (name === "bash") return String(args.command ?? "").slice(0, 60).trim() || "bash";
  if (name === "grep" || name === "glob") return String(args.pattern ?? args.path ?? name);
  return name;
}

/**
 * Lightweight humanizer for the common cron cases; falls back to the raw expr.
 * Ported verbatim from cronScheduleText().
 */
export function cronScheduleText(expr: string): string {
  const m = expr.trim().split(/\s+/);
  if (m.length === 5) {
    const [min, hr, dom, mon, dow] = m;
    if (min === "0" && hr !== "*" && dom === "*" && mon === "*" && dow === "*") {
      const h = parseInt(hr, 10);
      const ampm = h < 12 ? "AM" : "PM";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `Daily at ${String(h12).padStart(2, "0")}:00 ${ampm}`;
    }
    if (min === "0" && hr === "0" && dom === "*" && mon === "*" && dow === "0-6") return "Daily at 12:00 AM";
    if (min === "0" && hr === "0" && dom === "*" && mon === "*" && dow === "1-5") return "Weekdays at 12:00 AM";
    if (min === "0" && hr === "*" && dom === "*" && mon === "*" && dow === "*") return "Every hour";
    if (/^\*\//.test(min)) return `Every ${min.slice(2)} minutes`;
    if (/^\*\//.test(hr)) return `Every ${hr.slice(2)} hours`;
  }
  return expr;
}
