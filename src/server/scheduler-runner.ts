import type { JobQueue } from "./queue.js";
import type { SchedulerStore } from "./scheduler-store.js";
import type { AuthProvider } from "../github/auth-provider.js";
import { log } from "../util/log.js";
import type { NoodleConfig } from "../config/schema.js";

/**
 * Periodic cron-job scheduler — the cron equivalent of `Scheduler` (which polls
 * for new issues). Every tick it asks `SchedulerStore.listDueSchedulers()` for enabled
 * cron jobs whose `next_run_at` has passed, enqueues each into the shared job
 * queue (where a worker picks it up and runs `runCronJob`), and advances the
 * job's `next_run_at` to its next fire time.
 *
 * `enqueueCron` dedupes on `(repo, 0, cron_job_id)` for active statuses, so a
 * cron that fires again while its previous run is still going is a no-op — the
 * next_run_at still advances, and the missed run is skipped rather than queued
 * on top of the live one.
 *
 * Deps are injected (listDueSchedulers / enqueue / markScheduled) so the pure
 * `runSchedulerTick` function unit-tests without a DB or the network. The
 * `SchedulerRunner` class just wires it to the real stores + a setInterval.
 */

export interface SchedulerRunnerDeps {
  listDueSchedulers(now?: Date): ReturnType<SchedulerStore["listDueSchedulers"]>;
  enqueueScheduler(repo: string, cronJobId: number, installationId: number | null | undefined, profile: string | null): Promise<void>;
  markScheduled(id: number, now?: Date): void;
}

/**
 * Run one cron tick: enqueue every due cron job and advance its next_run_at.
 * Exported (pure-ish given deps) so `noodle` can call it and tests can exercise
 * it without a timer. Each cron is handled independently — one failing cron
 * (bad repo, no installation, transient API error) is logged + skipped without
 * stalling the others or aborting the tick.
 */
export async function runSchedulerTick(deps: SchedulerRunnerDeps, now: Date = new Date()): Promise<number> {
  const due = deps.listDueSchedulers(now);
  if (due.length === 0) return 0;
  log.info({ due: due.length }, "scheduler tick: enqueuing due scheduler jobs");
  let enqueued = 0;
  for (const scheduler of due) {
    const log_ = log.child({ schedulerId: scheduler.id, name: scheduler.name, repo: scheduler.repo, component: "scheduler-runner" });
    try {
      await deps.enqueueScheduler(scheduler.repo, scheduler.id, null, scheduler.profile);
      deps.markScheduled(scheduler.id, now);
      enqueued++;
      log_.info({ expr: scheduler.cron_expression }, "enqueued scheduler run");
    } catch (e) {
      // Don't advance next_run_at on failure — we want a retry on the next tick.
      // But DO log loudly so a permanently-broken cron (deleted repo, revoked
      // installation) is visible rather than silently spinning.
      log_.error({ err: e }, "failed to enqueue scheduler run; will retry next tick");
    }
  }
  return enqueued;
}

/**
 * setInterval-based cron scheduler. `start()` kicks off the loop (and an
 * immediate first tick so due crons fire on boot); `stop()` cancels the timer.
 *
 * The tick interval is a fixed 60s poll — fine-grained enough that a cron
 * expression like "0 0 * * *" (daily midnight) fires within a minute of the
 * target, without busy-looping. The actual schedule is computed by cron-parser
 * from each job's expression, not by this interval.
 */
export class SchedulerRunner {
  private timer: NodeJS.Timeout | null = null;
  private readonly tickMs: number;

  constructor(
    private readonly deps: SchedulerRunnerDeps,
    tickIntervalMs = 60_000,
  ) {
    this.tickMs = tickIntervalMs;
  }

  start(): void {
    if (this.timer) return;
    log.info({ tickIntervalMs: this.tickMs }, "scheduler runner started");
    runSchedulerTick(this.deps).catch((e) => log.error({ err: e }, "initial scheduler tick failed"));
    this.timer = setInterval(() => {
      runSchedulerTick(this.deps).catch((e) => log.error({ err: e }, "scheduled scheduler tick failed"));
    }, this.tickMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info("scheduler runner stopped");
    }
  }
}

/**
 * Build the real SchedulerRunnerDeps from the shared stores + auth provider.
 * Installation-id resolution happens lazily at job-run time inside the auth
 * provider (forRepo auto-resolves when no id is passed), so enqueueCron doesn't
 * need to do any API calls — it just drops the job in the queue.
 */
export function buildSchedulerRunnerDeps(
  schedulerStore: SchedulerStore,
  queue: JobQueue,
  _authProvider: AuthProvider,
  config: NoodleConfig,
): SchedulerRunnerDeps {
  return {
    listDueSchedulers: (now) => schedulerStore.listDueSchedulers(now),
    enqueueScheduler: async (repo, cronJobId, _installationId, profile) => {
      // No installation-id resolution here — the worker's forRepo() call
      // resolves it from the repo name via the App JWT (see auth-provider.ts).
      // This keeps enqueue fast (no API round-trips) and lets the dedupe index
      // fire before any network call.
      queue.enqueueCron({
        repo,
        cronJobId,
        profile: profile ?? config.default_profile,
      });
    },
    markScheduled: (id, now) => schedulerStore.markScheduled(id, now),
  };
}
