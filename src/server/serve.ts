import { createWebhookApp } from "./http.js";
import { JobQueue, QueueWorker, type RunJobFn } from "./queue.js";
import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { RunStore } from "./run-store.js";
import { Scheduler, SqliteScanState, runScanOnce, type SchedulerDeps } from "./scheduler.js";
import { CronStore } from "./cron-store.js";
import { CronScheduler, buildCronSchedulerDeps } from "./cron-scheduler.js";
import { SettingStore } from "./settings-store.js";
import { ProfileStore } from "./profile-store.js";
import { hydrateEnvFromDb } from "./hydrate-env.js";
import { resolveAuthProvider, isAppMode, type AuthProvider } from "../github/auth-provider.js";
import { runJob } from "../engine/run.js";
import { runCronJob } from "../engine/cron-run.js";
import { loadConfig } from "../config/load.js";
import { readSetupProfile, synthesizeConfig, hasUsableProfiles } from "../config/setup-fallback.js";
import { createRelayServer } from "../relay/server.js";
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
  // Resolve config. The normal path: loadConfig() reads the YAML. But for a
  // first-run instance set up via the wizard, the YAML may be missing or empty
  // — in that case we open the DB (default path) and synthesize a minimal
  // config from the wizard's setup_initial_profile seed (see setup-fallback.ts).
  const config = resolveConfig(configPath);
  const host = opts.host ?? config.server.host;
  const port = opts.port ?? config.server.port;

  // Open the SQLite DB first so we can hydrate process.env from the settings
  // table BEFORE resolving GitHub auth + reading the UI password — those read
  // env once at boot, so DB-stored secrets (set via the web UI / setup wizard)
  // must be in process.env by this point. Real env vars still win (see
  // hydrate-env.ts), so this never clobbers a per-deploy override.
  const queue = new JobQueue(config.storage.sqlite_path);
  const hydrated = hydrateEnvFromDb(queue.getDb());
  if (hydrated.length) {
    log.info({ keys: hydrated }, "hydrated env from settings DB");
  }
  const authProvider = resolveAuthProvider();
  const scanState = new SqliteScanState(queue.getDb());
  const runStore = new RunStore(queue.getDb());
  const cronStore = new CronStore(queue.getDb());
  const settingsStore = new SettingStore(queue.getDb());
  const profileStore = new ProfileStore(queue.getDb());

  // Merge DB-managed profiles into the in-memory config so they're runnable
  // immediately. DB profiles override same-named YAML profiles on a name clash
  // (the DB is the live, editable source). This happens BEFORE the worker pool,
  // webhook handler, and relay read `config.profiles`, so all of them see the
  // merged set. The UI routes mutate `config.profiles` in lockstep on every
  // create/update/rename/delete so edits take effect without a restart.
  for (const { name, profile } of profileStore.list()) {
    config.profiles[name] = profile;
  }

  // The worker's runJobFn: resolve auth for the job's repo, build a GitHubClient,
  // and dispatch to either runJob (issue→PR) or runCronJob (scheduled → issues)
  // based on whether the job carries a cron_job_id. Both share the runStore +
  // auth provider. Providers re-call forRepo() at each git+HTTP op so a
  // long-running job (2h+) re-mints its token after the GitHub-App installation
  // token's 1h TTL expires. The auth provider caches, so the repeated calls are
  // hash lookups.
  const runJobFn: RunJobFn = async (job) => {
    const instId = job.installation_id ?? undefined;
    const initial = await authProvider.forRepo(job.repo, instId);

    // Cron-originated job: look up its definition and dispatch to runCronJob.
    // A cron job row may have been deleted between enqueue and execution —
    // surface that as a clean failure rather than a crash.
    if (job.cron_job_id && job.cron_job_id > 0) {
      let cron;
      try {
        cron = cronStore.getCron(job.cron_job_id);
      } catch {
        log.warn({ jobId: job.id, cronJobId: job.cron_job_id }, "cron job no longer exists; skipping");
        return;
      }
      await runCronJob(config, initial.gh, {
        repo: job.repo,
        prompt: cron.prompt,
        branchName: cron.branch_name,
        profile: cron.profile,
        jobId: `job-${job.id}`,
        token: initial.token,
      }, {
        runStore,
        tokenProvider: () => authProvider.forRepo(job.repo, instId).then((r) => r.token),
      });
      return;
    }

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

  // Web UI: registered whenever there's a way to reach it. The dashboard
  // password can come from the env (NOODLE_UI_PASSWORD) or the settings DB
  // (set via the wizard / settings page). On a truly blank instance neither is
  // set — but we still register the routes so the first-run setup wizard at
  // /api/setup/* is reachable. In that state, the cookie secret is a random
  // throwaway (no one can log in until the wizard sets a password), and the
  // setup routes are the only useful unauthenticated surface.
  const uiPassword = process.env.NOODLE_UI_PASSWORD ?? settingsStore.get("NOODLE_UI_PASSWORD") ?? "";
  const { registerUiRoutes } = await import("./ui-routes.js");
  // When a real password exists, it's the cookie secret. When none exists
  // (blank instance), use a random per-boot secret — login is impossible until
  // the wizard runs, but the wizard itself is unauthenticated and admitted
  // while isConfigured() is false.
  const cookieSecret = uiPassword || cryptoRandomSecret();
  registerUiRoutes(app, { runStore, secret: cookieSecret, queue, authProvider, agentName: config.agent_name, cronStore, settingsStore, profileStore, config });
  if (uiPassword) {
    log.info("web UI enabled (password-protected)");
  } else {
    log.warn("NOODLE_UI_PASSWORD not set — web UI in setup mode (wizard reachable at /#/setup, login disabled until configured)");
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

  // Cron scheduler: always runs (cron jobs are DB-defined, not config-gated).
  // Fires an immediate tick on boot so due crons run without waiting for the
  // first interval, then every 60s.
  const cronScheduler = new CronScheduler(buildCronSchedulerDeps(cronStore, queue, authProvider, config));

  // API relay (optional). Provides centralized rate limiting for multiple agents
  // sharing the same API keys. When enabled, all API calls from this process
  // route through the relay transparently — no config changes needed.
  let relayApp: ReturnType<typeof createRelayServer> | null = null;
  if (config.relay?.enabled) {
    const relayPort = config.relay.port ?? 4445;
    const relayHost = config.relay.host ?? "0.0.0.0";

    // Save original base URLs before modifying profiles for relay routing.
    const originalUrls = new Map<string, string>();
    for (const [, profile] of Object.entries(config.profiles)) {
      if (profile.base_url) {
        originalUrls.set(profile.model, profile.base_url);
      }
    }

    // Create relay with access to original URLs for forwarding.
    relayApp = createRelayServer(config, { originalUrls });
    await relayApp.listen({ port: relayPort, host: relayHost });
    log.info({ port: relayPort, host: relayHost }, "API relay listening");

    // Rewrite each profile's base_url to route through the relay.
    const relayBase = `http://localhost:${relayPort}/v1`;
    for (const profile of Object.values(config.profiles)) {
      if (profile.base_url) {
        profile.base_url = relayBase;
      }
    }
    log.info({ relayBase }, "rewrote profile base_urls to route through relay");
  }

  // --- Boot order: workers first (drain backlog), then http, then schedulers. ---
  const workerPromises = Promise.all(workers.map((w) => w.run()));

  await app.listen({ host, port });
  log.info({ host, port }, "webhook server listening");

  scheduler?.start();
  cronScheduler.start();

  // --- Graceful shutdown ---
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    scheduler?.stop();
    cronScheduler.stop();
    for (const w of workers) w.stop();
    await relayApp?.close().catch((e) => log.error({ err: e }, "relay close error"));
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
 * A random cookie-signing secret for a blank instance (no UI password set yet).
 * Used only so the cookie auth machinery has *a* secret to sign with; no one
 * can log in with it because verifyPassword compares against the real password
 * (empty in this state), so every login attempt fails until the wizard sets
 * NOODLE_UI_PASSWORD. The wizard routes themselves are unauthenticated.
 */
function cryptoRandomSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Resolve the boot config, with a first-run fallback for wizard-set-up
 * instances.
 *
 * Normal: loadConfig() reads the YAML. If that succeeds and the config has at
 * least one usable profile, use it as-is.
 *
 * Fallback (first run via the setup wizard): if loadConfig throws (no YAML) OR
 * the YAML has zero profiles, open the DB at the default path and look for a
 * `setup_initial_profile` seed. If found, synthesize a minimal config from it.
 * If neither YAML nor a seed exists, rethrow the original loadConfig error —
 * the operator must either create noodle.config.yaml or run the wizard.
 *
 * The DB is opened at the default storage path (./noodle.db or $NOODLE_DB_PATH)
 * for the fallback probe; the real queue opens afterward at the resolved
 * config's storage.sqlite_path (same file). This is a read-only probe that
 * closes its handle so the JobQueue reopens cleanly.
 */
function resolveConfig(configPath: string | undefined): NoodleConfig {
  // Try the normal YAML path first.
  try {
    const config = loadConfig(configPath);
    if (hasUsableProfiles(config)) return config;
    // YAML loaded but has no usable profiles → fall through to the seed check.
    return trySeedFallback(config) ?? config;
  } catch (e) {
    // YAML missing/unloadable. Try the wizard seed before giving up.
    const fromSeed = trySeedFallback();
    if (fromSeed) return fromSeed;
    throw e;
  }
}

/**
 * Open the default DB and synthesize a config from the wizard seed, or null if
 * no seed is stored. `existing` (when the YAML loaded but had no profiles) is
 * returned unchanged if no seed exists, so the caller keeps the YAML config.
 */
function trySeedFallback(existing?: NoodleConfig): NoodleConfig | null {
  const dbPath = process.env.NOODLE_DB_PATH ?? "./noodle.db";
  let db: Db;
  try {
    // Throwaway read-only handle on the default DB path; the JobQueue opens its
    // own long-lived handle afterward on the same file.
    db = new Database(dbPath, { readonly: true });
  } catch {
    return existing ?? null;
  }
  try {
    const seed = readSetupProfile(db);
    if (!seed) return existing ?? null;
    return synthesizeConfig(seed);
  } catch {
    return existing ?? null;
  } finally {
    db.close();
  }
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
