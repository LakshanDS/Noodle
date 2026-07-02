import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { NoodleConfigSchema, crossValidate, type NoodleConfig } from "./schema.js";

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Locate the config file: NOODLE_CONFIG env, else ./noodle.config.{yaml,yml}. */
function configPath(): string {
  if (process.env.NOODLE_CONFIG) return resolve(process.env.NOODLE_CONFIG);
  const cwd = process.cwd();
  for (const name of ["noodle.config.yaml", "noodle.config.yml"]) {
    try {
      const p = resolve(cwd, name);
      readFileSync(p); // throws if missing
      return p;
    } catch {
      // try next
    }
  }
  throw new ConfigError(
    "No config file found. Set NOODLE_CONFIG or create noodle.config.yaml.",
    [
      "Looked for:",
      "  $NOODLE_CONFIG",
      "  ./noodle.config.yaml",
      "  ./noodle.config.yml",
    ],
  );
}

/** Load + zod-validate + cross-validate the config. Throws ConfigError on any problem. */
export function loadConfig(path?: string): NoodleConfig {
  const file = path ?? configPath();
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`Failed to read config ${file}: ${(e as Error).message}`);
  }

  const parsed = NoodleConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Config validation failed for ${file}`,
      parsed.error.issues.map(
        (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    );
  }

  const xerrors = crossValidate(parsed.data);
  if (xerrors.length) {
    throw new ConfigError(`Config has invalid references in ${file}`, xerrors.map((m) => `  ${m}`));
  }

  return parsed.data;
}

/** Look up a profile by name. Throws if missing. */
export function getProfile(config: NoodleConfig, name: string) {
  const p = config.profiles[name];
  if (!p) throw new ConfigError(`Profile "${name}" not defined in config.`);
  return p;
}
