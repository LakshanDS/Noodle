import { createWebhookApp } from "./http.js";
import { JobQueue, Dispatcher, type RunJobFn } from "./queue.js";
import { randomBytes } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { RunStore } from "./run-store.js";
import { SchedulerStore } from "./scheduler-store.js";
import { SchedulerRunner, buildSchedulerRunnerDeps } from "./scheduler-runner.js";
import { TriggerStore } from "./trigger-store.js";
import { SettingStore } from "./settings-store.js";
import { ProfileStore } from "./profile-store.js";
import { SkillStore } from "./skill-store.js";
import { CommandStore, seedBuiltinCommand } from "./command-store.js";
import { ChatStore } from "./chat-store.js";
import { ChatRuntime } from "../engine/chat-runtime.js";
import { resolveAuthProvider, isAppMode, type AuthProvider } from "../github/auth-provider.js";
import { runJob, pruneSessionDirs } from "../engine/run.js";
import { runSchedulerJob } from "../engine/scheduler-run.js";
import { runTriggerJob } from "../engine/trigger-run.js";
import { loadConfig, ConfigError } from "../config/load.js";
import { NoodleConfigSchema } from "../config/schema.js";
import { createRelayServer } from "../relay/server.js";
import { log, initLogFile, closeLogFile } from "../util/log.js";
import { slugify } from "../util/slugify.js";
import type { NoodleConfig } from "../config/schema.js";

/**
 * `noodle serve` — boot the webhook server + worker + cron scheduler as one
 * long-running process, with graceful shutdown on SIGINT/SIGTERM.
 *
 * Wiring: webhook → queue → worker → (auth → runJob). The cron scheduler feeds
 * the same queue on DB-defined schedules. All share one SQLite DB.
 */

export interface ServeOptions {
  host?: string;
  port?: number;
}

export async function serve(configPath: string | undefined, opts: ServeOptions = {}): Promise<void> {
  // Resolve config. The YAML file (optional) carries only boot-critical
  // settings: the DB path and server host/port. Everything else — profiles,
  // GitHub creds, UI password, triggers, routing, queue — is loaded from the
  // settings DB after it opens. If no YAML exists, defaults are used.
  // Env vars (NOODLE_DB_PATH, NOODLE_HOST, NOODLE_PORT) override the YAML — this
  // lets Docker deployments set everything in docker-compose with no YAML file.
  const config = resolveConfig(configPath);
  if (process.env.NOODLE_DB_PATH) config.storage.sqlite_path = process.env.NOODLE_DB_PATH;
  const host = opts.host ?? process.env.NOODLE_HOST ?? config.server.host;
  const port = opts.port ?? (process.env.NOODLE_PORT ? parseInt(process.env.NOODLE_PORT, 10) : undefined) ?? config.server.port;

  // Start persistent log files alongside the DB (e.g. /data/logs/noodle.log).
  // Rotates at 10MB × 5 files. Non-fatal: if the dir can't be created, stdout
  // + the ring buffer still work.
  const dbDir = dirname(resolve(config.storage.sqlite_path));
  const logDir = join(dbDir, "logs");
  initLogFile(logDir);

  // Open the SQLite DB — all configuration lives here now. Secrets (GitHub
  // creds, UI password, webhook secret) and behavioral settings (agent name,
  // triggers, routing, queue) are read from the settings table directly, not
  // via env vars. Only the DB path, server host/port, and log
  // level remain env/CLI flags (they're needed before the DB opens or the
  // server starts listening).
  const queue = new JobQueue(config.storage.sqlite_path);
  const runStore = new RunStore(queue.getDb());
  const schedulerStore = new SchedulerStore(queue.getDb());
  const triggerStore = new TriggerStore(queue.getDb());
  const settingsStore = new SettingStore(queue.getDb());
  const profileStore = new ProfileStore(queue.getDb());
  const skillStore = new SkillStore();
  const commandStore = new CommandStore(queue.getDb());
  const chatStore = ChatStore.fromDb(queue.getDb());
  // Seed (or refresh) the built-in /<agent> command — the default framing every
  // agent run falls back to when no other command matched. Idempotent: updates
  // the existing row's trigger + prompt on boot so an agent_name change renames
  // the trigger; never creates a duplicate.
  seedBuiltinCommand(commandStore, config.agent_name);
  const authProvider = resolveAuthProvider(settingsStore);
  const chatRuntime = new ChatRuntime({ config, authProvider });
  // Any chats left 'running' from a crash get marked errored (no live session
  // survives a restart). Best-effort — a failure here is not fatal.
  try {
    const stale = chatStore.resetStaleRunning();
    if (stale > 0) log.info({ chatsReset: stale }, "reset stale running chats at boot");
  } catch (e) {
    log.warn({ err: e }, "could not reset stale running chats at boot");
  }

  // Load profiles from the DB — the only source of profiles now. The YAML
  // config carries behavioral settings only (routing, triggers, server, etc.).
  // This happens BEFORE the dispatcher, webhook handler, and relay read
  // `config.profiles`, so all of them see the full set. The UI routes mutate
  // `config.profiles` in lockstep on every create/update/rename/delete so
  // edits take effect without a restart.
  for (const { name, profile } of profileStore.list()) {
    config.profiles[name] = profile;
  }

  // Resolve the default profile from the settings DB. If unset, fall back to
  // the first profile (alphabetically) so the system always has a default.
  const storedDefault = settingsStore.get("default_profile");
  if (storedDefault && config.profiles[storedDefault]) {
    config.default_profile = storedDefault;
  } else if (!config.default_profile && Object.keys(config.profiles).length > 0) {
    const first = Object.keys(config.profiles)[0];
    config.default_profile = first;
    log.warn({ default_profile: first }, "no default_profile in settings — using first profile");
  }

  if (Object.keys(config.profiles).length === 0) {
    log.warn("no profiles configured — create one via the dashboard");
  }

  // API relay: always runs on :4445. Profiles with use_relay route their API
  // requests through it for rate limiting. originalUrls holds the real upstream
  // base_urls (before relay rewrite) so the relay can forward. Shared with
  // ui-routes so profile CRUD can update them live.
  const relayPort = 4445;
  const relayBase = `http://localhost:${relayPort}/v1`;
  const originalUrls = new Map<string, string>();
  for (const [, profile] of Object.entries(config.profiles)) {
    if (profile.base_url) {
      originalUrls.set(profile.model, profile.base_url);
    }
  }

  // Overlay behavioral settings from the DB onto the config object. These
  // override the YAML defaults. Boot-critical settings (queue) take effect at
  // boot; per-run settings (stall timeouts) are read from config at run time.
  // Changes to boot-critical settings require a restart.
  loadSettingsIntoConfig(config, settingsStore);

  // The worker's runJobFn: resolve auth for the job's repo, build a GitHubClient,
  // and dispatch to either runJob (issue→PR) or runSchedulerJob (scheduled → issues)
  // based on whether the job carries a cron_job_id. Both share the runStore +
  // auth provider. Providers re-call forRepo() at each git+HTTP op so a
  // long-running job (2h+) re-mints its token after the GitHub-App installation
  // token's 1h TTL expires. The auth provider caches, so the repeated calls are
  // hash lookups.
  const runJobFn: RunJobFn = async (job) => {
    const instId = job.installation_id ?? undefined;
    const initial = await authProvider.forRepo(job.repo, instId);

    // Cron-originated job: look up its definition and dispatch to runSchedulerJob.
    // A cron job row may have been deleted between enqueue and execution —
    // surface that as a clean failure rather than a crash.
    if (job.cron_job_id && job.cron_job_id > 0) {
      let scheduler;
      try {
        scheduler = schedulerStore.getScheduler(job.cron_job_id);
      } catch {
        log.warn({ jobId: job.id, cronJobId: job.cron_job_id }, "cron job no longer exists; skipping");
        return;
      }
      await runSchedulerJob(config, initial.gh, {
        repo: job.repo,
        prompt: scheduler.prompt,
        branchName: scheduler.branch_name,
        profile: scheduler.profile,
        jobId: `job-${job.id}`,
        token: initial.token,
      }, {
        runStore,
        tokenProvider: () => authProvider.forRepo(job.repo, instId).then((r) => r.token),
        systemPrompt: settingsStore.get("system_prompt") || undefined,
        // Apply this cron's custom labels to its output issue; falls back to the
        // global defaults when the cron has no override (labels === null).
        labelOverrides: scheduler.labels,
      });
      return;
    }

    // Trigger-originated job: look up its definition and dispatch to runTriggerJob.
    // A trigger row may have been deleted between enqueue and execution —
    // surface that as a clean failure rather than a crash.
    if (job.trigger_id && job.trigger_id > 0) {
      let trigger;
      try {
        trigger = triggerStore.getTrigger(job.trigger_id);
      } catch {
        log.warn({ jobId: job.id, triggerId: job.trigger_id }, "trigger no longer exists; skipping");
        return;
      }
      await runTriggerJob(config, initial.gh, {
        repo: job.repo,
        prompt: trigger.prompt,
        branchName: trigger.branch_name,
        profile: trigger.profile,
        jobId: `job-${job.id}`,
        token: initial.token,
        eventType: trigger.event_type,
        eventAction: trigger.event_action,
      }, {
        runStore,
        tokenProvider: () => authProvider.forRepo(job.repo, instId).then((r) => r.token),
        systemPrompt: settingsStore.get("system_prompt") || undefined,
        triggerStore,
        triggerId: trigger.id,
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
      // Operator's global system prompt — always active, expanded and prepended
      // to sysInfo (same as scheduler/trigger runs).
      systemPrompt: settingsStore.get("system_prompt") || undefined,
      // Resolve slash commands from the issue body + comments so a matched
      // command's system_prompt extends the base and its profile override
      // applies. Newest-first scanning happens inside runJob.
      resolveCommand: (texts) => commandStore.resolveByTrigger(texts),
      // Issue/PR runs use the global default labels for now (no per-run override).
      labelOverrides: null,
    });
  };

  // Dispatcher: a single process pulls claimable jobs from the queue and fires
  // each off. Per-profile concurrency is enforced inside claimNext, which skips
  // a job whose profile is already at its `max_concurrent` cap (default 1) — so
  // there's no pool to size: a "default" cap=5 + "glm" cap=2 lets 7 jobs run at
  // once, each gated to its own profile. All three knobs are getters so Settings
  // / Profiles edits apply live (caps on the next claim, retry knobs on the next
  // failure) without a restart.
  const capacityFor = (profile: string): number =>
    config.profiles[profile]?.max_concurrent ?? 1;
  const dispatcher = new Dispatcher(queue, runJobFn, {
    capacityFor,
    maxAttempts: () => config.queue.max_attempts,
    retryBackoffSec: () => config.queue.retry_backoff_seconds,
  });
  log.info(
    { maxAttempts: config.queue.max_attempts, perProfile: Object.fromEntries(Object.entries(config.profiles).map(([k, p]) => [k, p.max_concurrent ?? 1])) },
    "dispatcher configured",
  );

  // Webhook handler → enqueue into the queue. The secret is read from the
  // settings DB per-request so changes take effect without a restart.
  const getWebhookSecret = (): string => settingsStore.get("GITHUB_WEBHOOK_SECRET") ?? "";
  if (!getWebhookSecret()) {
    log.warn("GITHUB_WEBHOOK_SECRET not set — webhook signatures cannot be verified. Set it in the Settings page.");
  }

  // The agent's own login — used to scope `assigned` events to assignments that
  // target the agent. Derived from agent_name (e.g. "Noodle" → "noodle-agent")
  // unless NOODLE_LOGIN is set explicitly.
  const selfLogin = await resolveSelfLogin(authProvider, config.agent_name, settingsStore).catch((e) => {
    log.warn({ err: e }, "could not resolve agent login; `assigned` events will be ignored");
    return undefined;
  });
  if (selfLogin) {
    log.info({ selfLogin }, "assignment trigger scoped to this login");
  } else {
    log.warn("set NOODLE_LOGIN in the Settings page to enable the assignment trigger (`assigned` events will be ignored until then)");
  }

  const app = createWebhookApp(getWebhookSecret, {
    // These are getters (not captured values) so edits in the Settings page take
    // effect without a restart: NOODLE_LOGIN / agent_name / triggers / profiles
    // are re-read on each webhook. `selfLogin` prefers an explicit NOODLE_LOGIN,
    // then derives the App bot's real login `<app-slug>[bot]` (or falls back to
    // the agent slug). GitHub ALWAYS emits `<app-slug>[bot]` as the sender for
    // App-identity events, so this is what self-trigger suppression must compare
    // against. In PAT mode the boot-time `currentUserLogin()` value is used.
    selfLogin: () =>
      settingsStore.get("NOODLE_LOGIN")?.trim() ||
      (isAppMode(settingsStore)
        ? `${settingsStore.get("GITHUB_APP_SLUG")?.trim() || slugify(config.agent_name)}[bot]`
        : selfLogin),
    agentName: () => config.agent_name,
    // Opt-in wake filter for `issues.*` events — see src/triggers/check.ts.
    // Slash commands (`/<agent>`), assignment, and `#<profile>` tags are always
    // honored and don't go through this filter.
    triggers: () => config.triggers,
    profileNames: () => Object.keys(config.profiles),
    // Active command triggers (read live from the store) so any enabled
    // /<trigger> in a comment wakes the agent — not just the built-in /<agent>.
    commandTriggers: () => commandStore.activeTriggers(),
    // Event-driven triggers: match incoming webhook events against stored triggers.
    triggerStore,
    enqueueTrigger: async (opts) => {
      queue.enqueueTrigger({
        repo: opts.repo,
        triggerId: opts.triggerId,
        installationId: opts.installationId,
        profile: opts.profile,
      });
      dispatcher.dispatch();
    },
    defaultProfile: () => config.default_profile,
    enqueue: async (intent) => {
      queue.enqueue({
        repo: intent.repo,
        issueNumber: intent.issueNumber,
        installationId: intent.installationId,
        source: "webhook",
        profile: intent.profileHint ?? config.default_profile,
      });
      // Trigger the dispatcher so the new job starts immediately rather than
      // waiting up to 5s for the safety-net timer.
      dispatcher.dispatch();
    },
  });

  // Web UI: the dashboard password is read from the settings DB per-request, so
  // password changes take effect without a restart. On a blank instance (no
  // password set), seed a default so the dashboard is reachable out of the box.
  // Idempotent — only seeds when the row is missing, so an operator who changes
  // the password never gets clobbered.
  //
  // ⚠ KNOWN DEFAULT: the seeded value below is a fixed, public default. Any
  // fresh instance is reachable by anyone who knows it until the operator
  // changes it via the Settings page. Only acceptable for local / trusted
  // networks — change it immediately on anything exposed.
  const { registerUiRoutes, seedDefaultSettings } = await import("./ui-routes.js");
  if (!settingsStore.has("NOODLE_UI_PASSWORD")) {
    settingsStore.set("NOODLE_UI_PASSWORD", DEFAULT_UI_PASSWORD);
    log.warn(`NOODLE_UI_PASSWORD not set — seeded default "${DEFAULT_UI_PASSWORD}". Change it in Settings on any exposed instance.`);
  }
  // Seed the editable instance defaults (system prompt, run timeouts, triggers,
  // routing, queue, labels) on a fresh DB so the Settings page has real values
  // the moment the UI comes up. Idempotent.
  seedDefaultSettings(settingsStore);
  const fallbackSecret = cryptoRandomSecret();
  const getUiPassword = (): string => settingsStore.get("NOODLE_UI_PASSWORD") ?? fallbackSecret;
  // Expose dispatch so UI routes can trigger it after enqueueing (manual cron
  // run) — new jobs start immediately instead of waiting for the 5s safety net.
  const dispatch = (): void => dispatcher.dispatch();
  registerUiRoutes(app, { runStore, getSecret: getUiPassword, queue, authProvider, schedulerStore, triggerStore, settingsStore, profileStore, commandStore, chatStore, chatRuntime, skillStore, config, logDir, dispatch, originalUrls, relayBase });
  if (settingsStore.has("NOODLE_UI_PASSWORD")) {
    log.info("web UI enabled (password-protected)");
  } else {
    log.warn("NOODLE_UI_PASSWORD not set — login disabled until configured via Settings");
  }

  // Cron scheduler: always runs (cron jobs are DB-defined, not config-gated).
  // Fires an immediate tick on boot so due crons run without waiting for the
  // first interval, then every 60s.
  const schedulerRunner = new SchedulerRunner(buildSchedulerRunnerDeps(schedulerStore, queue, authProvider, config));

  // API relay — always runs so profiles can toggle use_relay at runtime
  // without a restart. Passes the shared originalUrls map (live reference)
  // so the relay resolves upstream URLs for any model, even ones toggled on
  // after boot. Rewrites relay-enabled profiles' base_url to route through it.
  let relayApp: ReturnType<typeof createRelayServer> | null = null;
  const relayHost = "0.0.0.0";
  relayApp = createRelayServer(config, { originalUrls });
  await relayApp.listen({ port: relayPort, host: relayHost });
  log.info({ port: relayPort, host: relayHost }, "API relay listening");

  for (const profile of Object.values(config.profiles)) {
    if (profile.use_relay && profile.base_url) {
      profile.base_url = relayBase;
    }
  }

  // --- Boot order: prune stale session dirs, start the dispatcher (drains
  // backlog immediately + arms the 5s safety net), then http, then cron scheduler. ---
  pruneSessionDirs();
  dispatcher.start();
  await app.listen({ host, port });
  log.info({ host, port }, "webhook server listening");

  schedulerRunner.start();

  // --- Graceful shutdown ---
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    schedulerRunner.stop();
    await relayApp?.close().catch((e) => log.error({ err: e }, "relay close error"));
    await app.close().catch((e) => log.error({ err: e }, "http close error"));
    await dispatcher.stop(); // graceful: in-flight jobs finish before exit
    await chatRuntime.disposeAll(); // best-effort: tear down live sessions + workspaces
    queue.close();
    closeLogFile();
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep this function alive until shutdown exits the process.
  await new Promise<void>(() => {});
}

/**
 * ⚠ KNOWN DEFAULT password seeded into a fresh DB (one with no
 * NOODLE_UI_PASSWORD row). Seeding it enables login immediately so the
 * dashboard is usable out of the box. Because this value is public in the
 * source tree, ANY fresh instance is reachable by anyone who knows it until
 * the operator changes it in Settings. Acceptable for local/trusted networks;
 * unacceptable for anything exposed — change it immediately on deployment.
 * Idempotent: an existing row is never overwritten.
 */
const DEFAULT_UI_PASSWORD = "Noodle69";

/**
 * A random cookie-signing secret for a blank instance (no UI password set yet).
 * Used only so the cookie auth machinery has *a* secret to sign with; no one
 * can log in with it because verifyPassword compares against the real password
 * (empty in this state), so every login attempt fails until the password is
 * set via Settings.
 */
function cryptoRandomSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Resolve the boot config. The YAML file carries behavioral config only
 * (agent_name, routing, triggers, server, storage, etc.) — profiles and
 * default_profile are loaded from the DB at boot.
 *
 * If the YAML is missing entirely, fall back to a minimal config with sensible
 * defaults. The server starts, and the operator creates profiles via the
 * dashboard Settings page.
 */
function resolveConfig(configPath: string | undefined): NoodleConfig {
  try {
    return loadConfig(configPath);
  } catch (e) {
    // YAML missing (not found or unreadable) → produce minimal defaults so the
    // server can boot and the Settings page is usable. A validation error means the YAML
    // exists but is malformed — surface that.
    if (e instanceof ConfigError && /No config file found|Failed to read config/.test(e.message)) {
      return NoodleConfigSchema.parse({});
    }
    throw e;
  }
}

/**
 * Read behavioral settings from the DB and overlay them on the config object.
 * Each setting overrides the YAML default. Values are stored as strings in the
 * settings table — booleans are "true"/"false", numbers are stringified, arrays
 * are JSON strings. Only non-empty values override (an unset DB key keeps the
 * YAML/schema default).
 */
function loadSettingsIntoConfig(config: NoodleConfig, store: SettingStore): void {
  const triggerOnMention = store.get("trigger_on_mention");
  if (triggerOnMention != null) config.triggers.trigger_on_mention = triggerOnMention === "true";

  const triggerOnOpen = store.get("trigger_on_open");
  if (triggerOnOpen != null) config.triggers.trigger_on_open = triggerOnOpen === "true";

  const triggerKeywords = store.get("trigger_keywords");
  if (triggerKeywords) {
    try { config.triggers.trigger_keywords = JSON.parse(triggerKeywords); } catch { /* leave default */ }
  }

  const routing = store.get("routing");
  if (routing) {
    try { config.routing = JSON.parse(routing); } catch { /* leave default */ }
  }

  const qMaxAttempts = store.get("queue_max_attempts");
  if (qMaxAttempts) config.queue.max_attempts = parseInt(qMaxAttempts, 10) || config.queue.max_attempts;
  const qBackoff = store.get("queue_retry_backoff_seconds");
  if (qBackoff) config.queue.retry_backoff_seconds = parseInt(qBackoff, 10) || config.queue.retry_backoff_seconds;

  const stall = store.get("run_stall_timeout_minutes");
  if (stall) config.run.stall_timeout_minutes = parseInt(stall, 10) || config.run.stall_timeout_minutes;
  const toolStall = store.get("run_tool_stall_minutes");
  if (toolStall) config.run.tool_stall_minutes = parseInt(toolStall, 10) || config.run.tool_stall_minutes;
}

/**
 * Resolve the agent's own login so the `assigned` webhook trigger can be scoped
 * to assignments that target the agent (not human-to-human reshuffles), and so
 * self-trigger suppression (the bot's own comments/label swaps) matches against
 * the correct identity.
 *
 * - Explicit: NOODLE_LOGIN from the settings DB always wins (also the only
 *   source in App mode, where fetching "our own login" would need an extra
 *   round-trip per event).
 * - App mode default: `<app-slug>[bot]` (or `<agent-slug>[bot]` if the App slug
 *   is unset). GitHub ALWAYS emits `<app-slug>[bot]` as the sender for
 *   App-identity events, so this is the value self-suppression must match.
 * - PAT mode: query `/user` once, fall back to `<agent-slug>[bot]`.
 */
async function resolveSelfLogin(authProvider: AuthProvider, agentName: string, settingsStore: SettingStore): Promise<string | undefined> {
  const fromSettings = settingsStore.get("NOODLE_LOGIN")?.trim();
  if (fromSettings) return fromSettings;
  // App mode: the real bot login is `<app-slug>[bot]`. Warn when the App slug
  // is missing — self-suppression then falls back to the agent slug and may not
  // match the actual sender until the operator sets GITHUB_APP_SLUG.
  if (isAppMode(settingsStore)) {
    const appSlug = settingsStore.get("GITHUB_APP_SLUG")?.trim();
    if (!appSlug) {
      log.warn("GITHUB_APP_SLUG not set in App mode — self-trigger suppression falls back to the agent slug. Set it for reliable matching.");
    }
    return `${appSlug || slugify(agentName)}[bot]`;
  }
  // PAT mode: try to resolve from the API, fall back to a derived default.
  try {
    const { gh } = await authProvider.forRepo("__self__");
    return gh.currentUserLogin();
  } catch {
    return `${slugify(agentName)}[bot]`;
  }
}
