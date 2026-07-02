#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, ConfigError } from "./config/load.js";
import { createOctokit } from "./github/auth.js";
import { GitHubClient } from "./github/client.js";
import { runJob } from "./engine/run.js";
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
        `✓ config valid — ${Object.keys(config.profiles).length} profiles, ${config.routing.length} routing rules.`,
      );
      console.log(`  default_profile: ${config.default_profile}`);
      for (const [name, p] of Object.entries(config.profiles)) {
        console.log(`  - ${name}: ${p.provider}/${p.model} [${p.thinking_level}]`);
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
  .description("Run the agent on an issue, or dry-run a scan over open issues.")
  .requiredOption("-r, --repo <owner/name>", "target repository (owner/name)")
  .option("-i, --issue <number>", "issue number to fix", (v) => parseInt(v, 10))
  .option("--scan", "list open issues and show which profile would run (dry-run)")
  .option("-c, --config <path>", "path to config file")
  .action(async (opts: { repo: string; issue?: number; scan?: boolean; config?: string }) => {
    if (!opts.issue && !opts.scan) {
      console.error("✗ Provide --issue <n> to run on one issue, or --scan to dry-run all open issues.");
      process.exit(2);
    }
    const config = loadConfig(opts.config);
    const gh = new GitHubClient(createOctokit());

    if (opts.scan) {
      // Dry-run: list open issues and show the routed profile for each.
      console.log(`Scanning open issues in ${opts.repo} (dry-run)…\n`);
      // We don't have a listIssues method on the client yet; reuse getIssue by walking
      // is overkill for the MVP scan — instead, document that full scan comes with
      // the scheduler (Phase 2). For now, point users at --issue.
      console.log("Note: full issue listing arrives with the scheduler (Phase 2).");
      console.log("Use `noodle run --repo <r> --issue <n>` for a single issue.\n");
      process.exit(0);
    }

    if (opts.issue) {
      const result = await runJob(config, gh, { repo: opts.repo, issueNumber: opts.issue });
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

// --- noodle doctor ----------------------------------------------------------
program
  .command("doctor")
  .description("Check that pi, API keys, and GitHub token are ready.")
  .action(async () => {
    let ok = true;

    // GitHub token
    if (process.env.GITHUB_TOKEN) {
      try {
        const gh = new GitHubClient(createOctokit());
        const me = await gh.currentUserLogin();
        console.log(`✓ GITHUB_TOKEN valid (as @${me}).`);
      } catch (e) {
        ok = false;
        console.error(`✗ GITHUB_TOKEN set but failed: ${(e as Error).message}`);
      }
    } else {
      ok = false;
      console.error("✗ GITHUB_TOKEN not set.");
    }

    // LLM keys — at least one provider key should be present per the configured profiles.
    const llmKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "DEEPSEEK_API_KEY"];
    const present = llmKeys.filter((k) => process.env[k]);
    if (present.length === 0) {
      ok = false;
      console.error("✗ No LLM API key found (expected at least one of ANTHROPIC/OPENAI/OPENROUTER/...).");
    } else {
      console.log(`✓ LLM keys present: ${present.join(", ")}`);
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
