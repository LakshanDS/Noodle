import { createWebhookApp } from "./http.js";
import { JobQueue, QueueWorker, type RunJobFn } from "./queue.js";
import { RunStore } from "./run-store.js";
import { Scheduler, SqliteScanState, runScanOnce, type SchedulerDeps } from "./scheduler.js";
import { resolveAuthProvider, isAppMode, type AuthProvider } from "../github/auth-provider.js";
import { runJob } from "../engine/run.js";
import { loadConfig } from "../config/load.js";
import { log } from "../util/log.js";
import { slugify } from "../util/slugify.js";
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
  // Providers re-call forRepo() at each git+HTTP op so a long-running job (2h+)
  // re-mints its token after the GitHub-App installation token's 1h TTL expires.
  // The auth provider caches, so the repeated calls are hash lookups.
  const runJobFn: RunJobFn = async (job) => {
    const instId = job.installation_id ?? undefined;
    const initial = await authProvider.forRepo(job.repo, instId);
    await runJob(config, initial.gh, {
      repo: job.repo,
      issueNumber: job.issue_number,
      jobId: `job-${job.id}`,
      token: initial.token,
    }, {
      runStore,
      tokenProvider: () => authProvider.forRepo(job.repo, instId).then((r) => r.token),
      ghProvider: () => authProvider.forRepo(job.repo, instId).then((r) => r.gh),
      // Correct the job row's profile hint once the authoritative profile is
      // known, so per-profile concurrency gating stays accurate.
      onProfileResolved: (profile) => queue.setJobProfile(job.id, profile),
    });
  };

  // Worker pool: N workers pulling from the shared queue. `claimNext` is
  // transactional so two workers never grab the same job. Default concurrency is
  // 1 (safe for a small VPS — each agent run holds a workspace + pi session in
  // memory); raise via `queue.concurrency` only with headroom.
  const concurrency = config.queue.concurrency;
  // Per-profile concurrency cap: profiles with `max_concurrent` set are limited
  // to that many simultaneous runs (so profiles on separate API keys can run in
  // parallel without a single key being split). Profiles without it fall back to
  // the global ceiling. The global pool size is still the hard total cap.
  const capacityFor = (profile: string): number =>
    config.profiles[profile]?.max_concurrent ?? concurrency;
  const workerOpts = {
    maxAttempts: config.queue.max_attempts,
    retryBackoffSec: config.queue.retry_backoff_seconds,
    capacityFor,
  };
  const workers = Array.from({ length: concurrency }, () => new QueueWorker(queue, runJobFn, workerOpts));
  log.info(
    { concurrency, maxAttempts: workerOpts.maxAttempts, perProfile: Object.fromEntries(Object.entries(config.profiles).filter(([, p]) => p.max_concurrent).map(([k, p]) => [k, p.max_concurrent])) },
    "worker pool configured",
  );

  // Webhook handler → enqueue into the queue.
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
  if (!webhookSecret) {
    log.warn("GITHUB_WEBHOOK_SECRET not set — webhook signatures cannot be verified. Set it before exposing the server.");
  }

  // The agent's own login — used to scope `assigned` events to assignments that
  // target the agent. Derived from agent_name (e.g. "Noodle" → "noodle-agent")
  // unless NOODLE_LOGIN is set explicitly.
  const selfLogin = await resolveSelfLogin(authProvider, config.agent_name).catch((e) => {
    log.warn({ err: e }, "could not resolve agent login; `assigned` events will be ignored");
    return undefined;
  });
  if (selfLogin) {
    log.info({ selfLogin }, "assignment trigger scoped to this login");
  } else {
    log.warn("set NOODLE_LOGIN to enable the assignment trigger (`assigned` events will be ignored until then)");
  }

  const app = createWebhookApp(webhookSecret, {
    selfLogin,
    agentName: config.agent_name,
    // Opt-in wake filter for `issues.*` events — see src/triggers/check.ts.
    // Slash commands (`/<agent>`), assignment, and `#<profile>` tags are always
    // honored and don't go through this filter.
    triggers: config.triggers,
    profileNames: Object.keys(config.profiles),
    enqueue: async (intent) => {
      queue.enqueue({
        repo: intent.repo,
        issueNumber: intent.issueNumber,
        installationId: intent.installationId,
        source: "webhook",
        profile: intent.profileHint ?? config.default_profile,
      });
    },
  });

  // Web UI (Phase 3): fail-closed — only registered when NOODLE_UI_PASSWORD is
  // set, so an unconfigured deployment exposes nothing beyond /health + /webhook.
  // The password doubles as the signed-cookie secret (see ui-auth.ts).
  const uiPassword = process.env.NOODLE_UI_PASSWORD;
  if (uiPassword) {
    const { registerUiRoutes } = await import("./ui-routes.js");
    registerUiRoutes(app, { runStore, secret: uiPassword });
    log.info("web UI enabled (password-protected)");
  } else {
    log.warn("NOODLE_UI_PASSWORD not set — web UI disabled (/health + /webhook only)");
  }

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
      enqueue: async (repo, issueNumber, profile) => {
        queue.enqueue({ repo, issueNumber, source: "scheduler", profile });
      },
      state: scanState,
    };
    scheduler = new Scheduler(config, schedulerDeps);
  }

  // --- Boot order: workers first (drain backlog), then http, then scheduler. ---
  const workerPromises = Promise.all(workers.map((w) => w.run()));

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
    for (const w of workers) w.stop();
    await app.close().catch((e) => log.error({ err: e }, "http close error"));
    await workerPromises.catch(() => {}); // all workers exit their loops
    queue.close();
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep this function alive until shutdown exits the process.
  await workerPromises;
}

/**
 * Resolve the agent's own login so the `assigned` webhook trigger can be scoped
 * to assignments that target the agent (not human-to-human reshuffles).
 *
 * - Explicit: `NOODLE_LOGIN` always wins (also the only source in App mode,
 *   where fetching "our own login" would need an extra round-trip per event).
 * - Default: derived from `agent_name` → `<slug>-agent` (e.g. "Noodle" → "noodle-agent").
 * - PAT fallback: if no env var and not App mode, query `/user` once.
 * - App mode without NOODLE_LOGIN: returns the derived default.
 */
async function resolveSelfLogin(authProvider: AuthProvider, agentName: string): Promise<string | undefined> {
  const fromEnv = process.env.NOODLE_LOGIN?.trim();
  if (fromEnv) return fromEnv;
  // Derive a sensible default from the agent name.
  const derived = `${slugify(agentName)}-agent`;
  if (isAppMode()) return derived; // App mode: use derived default.
  // PAT mode: try to resolve from the API, fall back to derived default.
  try {
    const { gh } = await authProvider.forRepo("__self__");
    return gh.currentUserLogin();
  } catch {
    return derived;
  }
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
    enqueue: async (r, n, profile) => {
      console.log(`  → would enqueue ${r}#${n} (profile: ${profile})`);
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
