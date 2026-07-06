import type { Database as Db } from "better-sqlite3";
import { log } from "../util/log.js";
import { resolveProfile } from "../profiles/resolve.js";
import { shouldTrigger } from "../triggers/check.js";
import type { NoodleConfig } from "../config/schema.js";
import type { IssueData } from "../github/client.js";

/**
 * Periodic cron scan of watched repos. Every `interval_minutes`, for each repo
 * in `scheduler.repos`: fetch open issues updated since the last scan, route
 * each through the config rules, and enqueue any that would produce a run.
 *
 * The selection logic is extracted as a pure function (`selectIssuesToEnqueue`)
 * so it unit-tests without touching the network; the timer just wires it to the
 * GitHub client + queue. Per-repo "last seen issue updated_at" is persisted in
 * a `scan_state` table so restarts don't reprocess the whole backlog.
 */

const SCAN_SCHEMA = `
CREATE TABLE IF NOT EXISTS scan_state (
  repo TEXT PRIMARY KEY,
  last_issue_updated_at TEXT
);
`;

export interface ScanStateStore {
  getLastUpdated(repo: string): string | null;
  setLastUpdated(repo: string, isoTs: string): void;
}

/** SQLite-backed per-repo "last issue updated_at" store. */
export class SqliteScanState implements ScanStateStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
    this.db.exec(SCAN_SCHEMA);
  }
  getLastUpdated(repo: string): string | null {
    const row = this.db
      .prepare("SELECT last_issue_updated_at FROM scan_state WHERE repo = ?")
      .get(repo) as { last_issue_updated_at: string | null } | undefined;
    return row?.last_issue_updated_at ?? null;
  }
  setLastUpdated(repo: string, isoTs: string): void {
    this.db
      .prepare(
        `INSERT INTO scan_state (repo, last_issue_updated_at) VALUES (?, ?)
         ON CONFLICT(repo) DO UPDATE SET last_issue_updated_at = excluded.last_issue_updated_at`,
      )
      .run(repo, isoTs);
  }
}

/**
 * PURE: from a list of open issues in one repo, route each and return info
 * about which would be enqueued, with the profile each would run + whether the
 * configured trigger filter accepted the wake signal.
 *
 * Routing always resolves (it falls back to default). `triggered` reflects the
 * configured `triggers` config (default: opt-in on @-mention / keyword / slash
 * / #profile). Returned issues are NOT pre-filtered — both the scheduler (which
 * enqueues) and the dry-run CLI use this function, and the dry-run wants to
 * show "filtered out because no wake signal" alongside the routing result.
 * Callers pick the slice they want via `filterTriggered`.
 *
 * Cheap path: scan-time filtering uses the issue body only (the scheduler
 * deliberately doesn't fetch comments — one extra API call per issue). The
 * webhook layer separately handles `issue_comment.created` to catch the case
 * where a user wakes Noodle on an OLD issue by posting a comment.
 */
export function selectIssuesToEnqueue(
  issues: IssueData[],
  config: NoodleConfig,
  repo: string,
): { issue: IssueData; profile: string; triggered: boolean }[] {
  const profileNames = Object.keys(config.profiles);
  return issues.map((issue) => {
    const resolved = resolveProfile(
      config,
      { title: issue.title, body: issue.body, labels: issue.labels, comments: [] },
      repo,
    );
    const { wake } = shouldTrigger({
      agentName: config.agent_name,
      body: issue.body ?? "",
      comments: [],
      triggers: config.triggers,
      profileNames,
    });
    return { issue, profile: resolved.name, triggered: wake };
  });
}

/** Filter a `selectIssuesToEnqueue` result to issues that pass the trigger filter. */
export function filterTriggered(
  selected: { issue: IssueData; profile: string; triggered: boolean }[],
): { issue: IssueData; profile: string }[] {
  return selected.filter((s) => s.triggered).map(({ issue, profile }) => ({ issue, profile }));
}

export interface SchedulerDeps {
  /** Fetch open issues for a repo (optionally since an ISO timestamp). */
  listOpenIssues(repo: string, since?: string): Promise<IssueData[]>;
  /** Enqueue a selected issue, with its resolved profile (for per-profile gating). */
  enqueue(repo: string, issueNumber: number, profile: string): Promise<void>;
  /** Read/write per-repo last-seen. */
  state: ScanStateStore;
}

/**
 * Run one scan pass over all watched repos. Pure-ish (async, but deterministic
 * given deps). Exported so `noodle run --scan` can call it as a dry-run.
 */
export async function runScanOnce(config: NoodleConfig, deps: SchedulerDeps): Promise<void> {
  for (const repo of config.scheduler.repos) {
    const log_ = log.child({ repo, component: "scheduler" });
    const lastSeen = deps.state.getLastUpdated(repo);
    try {
      const issues = await deps.listOpenIssues(repo, lastSeen ?? undefined);
      const selected = selectIssuesToEnqueue(issues, config, repo);
      // Honor the opt-in trigger filter — only enqueue issues the wake-signal
      // gate accepts. Issues without an @-mention / keyword / slash / #profile
      // are dropped (and would otherwise waste tokens).
      const toEnqueue = filterTriggered(selected);
      log_.info({ total: selected.length, enqueued: toEnqueue.length, lastSeen }, "scanned repo");
      for (const { issue, profile } of toEnqueue) {
        await deps.enqueue(repo, issue.number, profile);
      }
      // Advance the watermark to "now" so the next pass only sees new changes.
      // We use the current time rather than the newest issue's updated_at so a
      // repo with no matching issues still advances (no re-scan of empties).
      deps.state.setLastUpdated(repo, new Date().toISOString());
    } catch (e) {
      log_.error({ err: e }, "scan failed for repo");
    }
  }
}

/**
 * setInterval-based scheduler. `start()` kicks off the loop (and an immediate
 * first run); `stop()` cancels the timer.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: NoodleConfig,
    private readonly deps: SchedulerDeps,
  ) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = this.config.scheduler.interval_minutes * 60 * 1000;
    log.info({ intervalMinutes: this.config.scheduler.interval_minutes }, "scheduler started");
    // Fire one scan immediately so a freshly-booted server doesn't wait.
    runScanOnce(this.config, this.deps).catch((e) => log.error({ err: e }, "initial scan failed"));
    this.timer = setInterval(() => {
      runScanOnce(this.config, this.deps).catch((e) => log.error({ err: e }, "scheduled scan failed"));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info("scheduler stopped");
    }
  }
}
