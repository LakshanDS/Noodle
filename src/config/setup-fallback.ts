import type { Database as Db } from "better-sqlite3";
import { SettingStore } from "../server/settings-store.js";
import { NoodleConfigSchema, crossValidate, type NoodleConfig } from "./schema.js";
import { ConfigError } from "./load.js";

/**
 * First-run config fallback.
 *
 * Normal operation requires `noodle.config.yaml` with at least one profile.
 * But the setup wizard is meant to get a blank instance working from the
 * browser — without forcing the operator to hand-write YAML. To bridge that,
 * the wizard stores the chosen {provider, model, api_key_env} triple in the
 * settings DB under SETUP_PROFILE_KEY. This module reads that triple and
 * synthesizes a minimal valid NoodleConfig from it.
 *
 * Used ONLY when the YAML file is missing or has zero profiles. If the YAML
 * defines profiles, it wins — the wizard's seed is ignored. This keeps the
 * "behavioral config = YAML, instance config = DB" boundary clean: the wizard
 * produces the minimal seed to boot, and the operator graduates to YAML for
 * anything richer (routing, multiple profiles, triggers).
 */

export const SETUP_PROFILE_KEY = "setup_initial_profile";

export interface SetupProfile {
  provider: string;
  model: string;
  /** The env var name the key was stored under (profile.api_key_env). */
  api_key_env?: string;
  /** Optional base_url for custom/OpenAI-compatible providers. */
  base_url?: string;
  /** Optional api style for custom providers. */
  api?: string;
  /** Optional runtime selection: "pi" (default) or "opencode". */
  runtime?: "pi" | "opencode";
}

/** Read + JSON-parse the setup profile from the DB. Returns null if absent/invalid. */
export function readSetupProfile(db: Db): SetupProfile | null {
  const store = new SettingStore(db);
  const raw = store.get(SETUP_PROFILE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SetupProfile;
    if (typeof parsed.provider !== "string" || typeof parsed.model !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Synthesize a minimal NoodleConfig from a setup profile. Produces a config
 * with one profile named "default" set as the default_profile, the built-in
 * tool set, and sensible defaults for server/storage/queue/run/triggers.
 *
 * Runs the result through the same Zod schema + cross-validation as loadConfig,
 * so a malformed wizard seed surfaces as a clear error rather than a runtime
 * crash deep in the engine.
 */
export function synthesizeConfig(seed: SetupProfile): NoodleConfig {
  const raw = {
    agent_name: "Noodle",
    // If the wizard picked OpenCode, make it the instance default so untagged
    // runs use it too — not just the seeded profile.
    ...(seed.runtime === "opencode" ? { default_runtime: "opencode" as const } : {}),
    default_profile: "default",
    profiles: {
      default: {
        provider: seed.provider,
        model: seed.model,
        ...(seed.runtime ? { runtime: seed.runtime } : {}),
        ...(seed.api_key_env ? { api_key_env: seed.api_key_env } : {}),
        ...(seed.base_url ? { base_url: seed.base_url } : {}),
        ...(seed.api ? { api: seed.api } : {}),
      },
    },
    // All other blocks fall back to their schema defaults via safeParse.
  };

  const parsed = NoodleConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      "Setup profile produced an invalid config",
      parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const xerrors = crossValidate(parsed.data);
  if (xerrors.length) {
    throw new ConfigError("Setup profile produced an invalid config", xerrors.map((m) => `  ${m}`));
  }
  return parsed.data;
}

/**
 * Is the given config one that the setup wizard would consider "unconfigured"?
 * True when there are zero profiles OR no default profile resolves. Used by the
 * setup status endpoint to decide whether to admit the wizard.
 */
export function hasUsableProfiles(config: NoodleConfig): boolean {
  return Object.keys(config.profiles).length > 0 && !!config.profiles[config.default_profile];
}
