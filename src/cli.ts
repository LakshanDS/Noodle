#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { loadConfig, ConfigError } from "./config/load.js";
import { createOctokit } from "./github/auth.js";
import { GitHubClient } from "./github/client.js";
import { runJob } from "./engine/run.js";
import { serve } from "./server/serve.js";
import { log } from "./util/log.js";

const program = new Command();

program
  .name("noodle")
  .description("Self-hostable GitHub agent: issues → pull requests, powered by pi.")
  .version("0.1.0");

// --- noodle config validate -------------------------------------------------
const configCmd = program.command("config").description("Config subcommands.");
configCmd
  .command("validate")
  .description("Validate noodle.config.yaml and report any problems.")
  .option("-c, --config <path>", "path to config file")
  .action((opts: { config?: string }) => {
    try {
      const config = loadConfig(opts.config);
      console.log(
        `✓ config valid — ${config.routing.length} routing rules.`,
      );
      console.log(`  Profiles are loaded from the DB at boot.`);
      if (config.default_profile) {
        console.log(`  default_profile: ${config.default_profile} (from DB)`);
      }
      if (config.routing.length > 0) {
        for (const r of config.routing) {
          console.log(`  route: ${r.kind} ${r.match} → ${r.profile}`);
        }
      }
    } catch (e) {
      if (e instanceof ConfigError) {
        console.error(`✗ ${e.message}`);
        for (const d of e.details) console.error(d);
        process.exit(1);
      }
      throw e;
    }
  });

// --- noodle run -------------------------------------------------------------
program
  .command("run")
  .description("Run the agent on an issue.")
  .requiredOption("-r, --repo <owner/name>", "target repository (owner/name)")
  .requiredOption("-i, --issue <number>", "issue number to fix", (v) => parseInt(v, 10))
  .option("-c, --config <path>", "path to config file")
  .action(async (opts: { repo: string; issue: number; config?: string }) => {
    const config = loadConfig(opts.config);
    // Read the GitHub token from the settings DB (not env vars).
    const dbPath = process.env.NOODLE_DB_PATH ?? config.storage.sqlite_path;
    const { SettingStore } = await import("./server/settings-store.js");
    const { ProfileStore } = await import("./server/profile-store.js");
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { readonly: true });
    const token = SettingStore.fromDb(db).get("GITHUB_TOKEN");
    for (const { name, profile } of ProfileStore.fromDb(db).list()) config.profiles[name] = profile;
    db.close();
    if (!token) {
      console.error("✗ No GITHUB_TOKEN in the settings DB. Set it via the dashboard or the setup wizard.");
      process.exit(1);
    }
    const gh = new GitHubClient(createOctokit(token));

    if (opts.issue) {
      const result = await runJob(config, gh, { repo: opts.repo, issueNumber: opts.issue, token });
      console.log(`\n✓ Done — profile: ${result.profile} (${result.model})`);
      if (result.prUrl) {
        console.log(`  PR:   ${result.prUrl}`);
        console.log(`  Files: ${result.changedFiles.join(", ")}`);
      } else {
        console.log(`  (no code changes — see issue comment)`);
      }
      console.log(`  Comment: ${result.commentUrl}`);
    }
  });

// --- noodle serve (Phase 2: webhook server + worker + scheduler) -------------
program
  .command("serve")
  .description("Run the webhook server + job queue (+ optional scheduler). Long-running.")
  .option("-c, --config <path>", "path to config file")
  .option("-H, --host <host>", "bind host (overrides config server.host)")
  .option("-p, --port <number>", "bind port (overrides config server.port)", (v) => parseInt(v, 10))
  .action(async (opts: { config?: string; host?: string; port?: number }) => {
    await serve(opts.config, { host: opts.host, port: opts.port });
  });

// --- noodle doctor ----------------------------------------------------------
program
  .command("doctor")
  .description("Check that pi, API keys, and GitHub token are ready.")
  .option("-c, --config <path>", "path to config file")
  .action(async (opts: { config?: string }) => {
    let ok = true;

    // Open the DB to read all config (creds + profiles + settings).
    const config = loadConfig(opts.config);
    const dbPath = process.env.NOODLE_DB_PATH ?? config.storage.sqlite_path;
    const { ProfileStore } = await import("./server/profile-store.js");
    const { SettingStore } = await import("./server/settings-store.js");
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { readonly: true });
    const settingsStore = SettingStore.fromDb(db);
    const profileStore = ProfileStore.fromDb(db);

    // GitHub auth: check PAT or App creds in the DB.
    const hasAppCreds = settingsStore.has("GITHUB_APP_ID") && (settingsStore.has("GITHUB_PRIVATE_KEY") || !!process.env.GITHUB_PRIVATE_KEY_FILE);
    const token = settingsStore.get("GITHUB_TOKEN");
    if (token) {
      try {
        const gh = new GitHubClient(createOctokit(token));
        const me = await gh.currentUserLogin();
        console.log(`✓ GITHUB_TOKEN valid (as @${me}).`);
      } catch (e) {
        ok = false;
        console.error(`✗ GITHUB_TOKEN set but failed: ${(e as Error).message}`);
      }
    } else if (hasAppCreds) {
      console.log("✓ GitHub App credentials present in DB.");
      console.log("  (App token exchange is exercised by `noodle serve`.)");
    } else {
      ok = false;
      console.error("✗ No GitHub auth: set GITHUB_TOKEN (PAT) or GITHUB_APP_ID + GITHUB_PRIVATE_KEY (App) in the Settings page.");
    }

    if (hasAppCreds && !settingsStore.has("GITHUB_WEBHOOK_SECRET")) {
      console.warn("⚠ GITHUB_WEBHOOK_SECRET not set — required for `noodle serve` webhook verification.");
    }

    // LLM config — profiles are in the DB.
    try {
      const profiles = profileStore.list();
      if (profiles.length === 0) {
        ok = false;
        console.error("✗ No profiles configured — create one via the dashboard.");
      } else {
        const missing = profiles.filter((p) => !p.profile.api_key);
        if (missing.length > 0) {
          console.warn(`⚠ Profiles without an api_key (may be no-auth local endpoints): ${missing.map((p) => p.name).join(", ")}`);
        }
        const defaultProfile = settingsStore.get("default_profile");
        console.log(`✓ ${profiles.length} profile(s) in DB.`);
        if (defaultProfile) console.log(`  default_profile: ${defaultProfile}`);
      }
      db.close();
    } catch {
      ok = false;
      console.error("✗ Could not read profiles from the DB.");
    }

    // pi import sanity (proves @earendil-works/pi-coding-agent installed correctly)
    try {
      const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
      if (typeof createAgentSession !== "function") throw new Error("createAgentSession is not a function");
      console.log("✓ pi (@earendil-works/pi-coding-agent) importable.");
    } catch (e) {
      ok = false;
      console.error(`✗ pi not importable: ${(e as Error).message}`);
    }

    process.exit(ok ? 0 : 1);
  });

program.parseAsync().catch((e) => {
  log.error({ err: e }, "noodle crashed");
  process.exit(1);
});
