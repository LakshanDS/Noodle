import { createWebhookApp } from "./http.js";
import { JobQueue, QueueWorker, type RunJobFn } from "./queue.js";
import { RunStore } from "./run-store.js";
import { Scheduler, SqliteScanState, runScanOnce, type SchedulerDeps } from "./scheduler.js";
import { resolveAuthProvider, isAppMode, type AuthProvider } from "../github/auth-provider.js";
import { runJob } from "../engine/run.js";
import { loadConfig } from "../config/load.js";
import { log } from "../util/log.js";
import type { NoodleConfig } from "../config/schema.js";

/**
 * `noodle serve` — boot the webhook server + worker + (optional) scheduler as
 * one long-running process, with graceful shutdown on SIGINT/SIGTERM.
 *
 * Wiring: webhook → queue → worker → (auth → runJob). The scheduler, when
 * enabled, feeds the same queue via periodic scans. All share one SQLite DB.
 */

export interface ServeOptions {
  host?: string;
  port?: number;
}

export async function serve(configPath: string | undefined, opts: ServeOptions = {}): Promise<void> {
  const config = loadConfig(configPath);
  const host = opts.host ?? config.server.host;
  const port = opts.port ?? config.server.port;

  const authProvider = resolveAuthProvider();
  const queue = new JobQueue(config.storage.sqlite_path);
  const scanState = new SqliteScanState(queue.getDb());
  const runStore = new RunStore(queue.getDb());

  // The worker's runJobFn: resolve auth for the job's repo, build a GitHubClient,
  // and call the existing engine.runJob with the token + run store plumbed through.
  const runJobFn: RunJobFn = async (job) => {
    const { gh, token } = await authProvider.forRepo(job.repo, job.installation_id ?? undefined);
    await runJob(config, gh, {
      repo: job.repo,
      issueNumber: job.issue_number,
      jobId: `job-${job.id}`,
      token,
    }, { runStore });
  };

  const worker = new QueueWorker(queue, runJobFn);

  // Webhook handler → enqueue into the queue.
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
  if (!webhookSecret) {
    log.warn("GITHUB_WEBHOOK_SECRET not set — webhook signatures cannot be verified. Set it before exposing the server.");
  }

  // Noodle's own login — used to scope `assigned` events to assignments that
  // target Noodle. App mode reads NOODLE_LOGIN (declared); PAT mode resolves it
  // once from the API. Left undefined, `assigned` events are ignored.
  const selfLogin = await resolveSelfLogin(authProvider).catch((e) => {
    log.warn({ err: e }, "could not resolve Noodle's own login; `assigned` events will be ignored");
    return undefined;
  });
  if (selfLogin) {
    log.info({ selfLogin }, "assignment trigger scoped to this login");
  } else {
    log.warn("set NOODLE_LOGIN to enable the assignment trigger (Noodle will ignore `assigned` events until then)");
  }

  const app = createWebhookApp(webhookSecret, {
    selfLogin,
    enqueue: async (intent) => {
      queue.enqueue({
        repo: intent.repo,
        issueNumber: intent.issueNumber,
        installationId: intent.installationId,
        source: "webhook",
      });
    },
  });

  // Scheduler (optional). Shares the queue + scan state.
  let scheduler: Scheduler | null = null;
  if (config.scheduler.enabled && config.scheduler.repos.length > 0) {
    const schedulerDeps: SchedulerDeps = {
      listOpenIssues: async (repo, since) => {
        // App mode: resolve installation id per repo. PAT mode: no installation id.
        const instId = await (async () => {
          try {
            const { gh } = await authProvider.forRepo(repo);
            return await gh.repoInstallationId(repo);
          } catch {
            return undefined;
          }
        })();
        const { gh } = await authProvider.forRepo(repo, instId ?? undefined);
        return gh.listOpenIssues(repo, since);
      },
      enqueue: async (repo, issueNumber) => {
        queue.enqueue({ repo, issueNumber, source: "scheduler" });
      },
      state: scanState,
    };
    scheduler = new Scheduler(config, schedulerDeps);
  }

  // --- Boot order: worker first (drains backlog), then http, then scheduler. ---
  const workerPromise = worker.run();

  await app.listen({ host, port });
  log.info({ host, port }, "webhook server listening");

  scheduler?.start();

  // --- Graceful shutdown ---
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    scheduler?.stop();
    worker.stop();
    await app.close().catch((e) => log.error({ err: e }, "http close error"));
    await workerPromise.catch(() => {}); // worker exits its loop
    queue.close();
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep this function alive until shutdown exits the process.
  await workerPromise;
}

/**
 * Resolve Noodle's own login so the `assigned` webhook trigger can be scoped to
 * assignments that target Noodle (not human-to-human reshuffles).
 *
 * - Explicit: `NOODLE_LOGIN` always wins (also the only source in App mode,
 *   where fetching "our own login" would need an extra round-trip per event).
 * - PAT fallback: query `/user` once with the configured token.
 * - App mode without NOODLE_LOGIN: returns undefined → `assigned` is ignored.
 */
async function resolveSelfLogin(authProvider: AuthProvider): Promise<string | undefined> {
  const fromEnv = process.env.NOODLE_LOGIN?.trim();
  if (fromEnv) return fromEnv;
  if (isAppMode()) return undefined; // App mode has no cheap "me" lookup.
  const { gh } = await authProvider.forRepo("__self__");
  return gh.currentUserLogin();
}

/**
 * as a dry-run). Prints what would be enqueued. Reuses serve's wiring minus the
 * server/worker.
 */
export async function scanOnce(configPath: string | undefined, repo: string): Promise<void> {
  const config = loadConfig(configPath);
  const queue = new JobQueue(config.storage.sqlite_path);
  const scanState = new SqliteScanState(queue.getDb());
  const authProvider = resolveAuthProvider();

  const deps: SchedulerDeps = {
    listOpenIssues: async (r, since) => {
      const { gh } = await authProvider.forRepo(r);
      return gh.listOpenIssues(r, since);
    },
    enqueue: async (r, n) => {
      console.log(`  → would enqueue ${r}#${n}`);
    },
    state: scanState,
  };
  // Scope the scan to the requested repo regardless of config.scheduler settings.
  const singleRepoConfig: NoodleConfig = {
    ...config,
    scheduler: { ...config.scheduler, enabled: true, repos: [repo] },
  };
  await runScanOnce(singleRepoConfig, deps);
  queue.close();
}
