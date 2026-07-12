import { describe, it, expect } from "vitest";
import { NoodleConfigSchema } from "../src/config/schema.js";
import { resolveRuntimeName } from "../src/engine/runtime.js";
import type { ResolvedProfile } from "../src/engine/runtime.js";

/**
 * Tests for `resolveRuntimeName` — the precedence chain that picks which agent
 * runtime (pi vs opencode) a run uses. The order is:
 *
 *   1. command/cron runtime override (explicit per-trigger)
 *   2. profile.runtime
 *   3. config.default_runtime (fallback)
 *
 * This is a pure function — no runtimes need to be loaded.
 */

function makeProfile(runtime?: "pi" | "opencode"): ResolvedProfile {
  const base = NoodleConfigSchema.parse({
    agent_name: "TestBot",
    default_profile: "p",
    profiles: { p: { provider: "openai", model: "gpt-4o-mini", ...(runtime ? { runtime } : {}) } },
    routing: [],
  });
  return { name: "p", ...base.profiles.p };
}

function makeConfig(defaultRuntime?: "pi" | "opencode", profileRuntime?: "pi" | "opencode") {
  return NoodleConfigSchema.parse({
    agent_name: "TestBot",
    default_profile: "p",
    ...(defaultRuntime ? { default_runtime: defaultRuntime } : {}),
    profiles: { p: { provider: "openai", model: "gpt-4o-mini", ...(profileRuntime ? { runtime: profileRuntime } : {}) } },
    routing: [],
  });
}

describe("resolveRuntimeName — precedence chain", () => {
  it("defaults to pi when nothing is specified", () => {
    const config = makeConfig();
    const profile = makeProfile();
    expect(resolveRuntimeName(config, profile)).toBe("pi");
  });

  it("uses the profile's runtime when set", () => {
    const config = makeConfig();
    const profile = makeProfile("opencode");
    expect(resolveRuntimeName(config, profile)).toBe("opencode");
  });

  it("uses config.default_runtime as the base default for profiles", () => {
    // Note: ProfileSchema defaults runtime to "pi", so a profile without an
    // explicit runtime always carries "pi" — config.default_runtime only wins
    // for profiles constructed without schema defaults (e.g. a bare object).
    // This test uses a raw profile object (no schema default applied) to verify
    // config.default_runtime is the genuine fallback.
    const config = makeConfig("opencode");
    const profile = { name: "p", provider: "openai", model: "gpt-4o-mini" } as unknown as ResolvedProfile;
    expect(resolveRuntimeName(config, profile)).toBe("opencode");
  });

  it("the trigger override (command/cron) wins over both profile and config", () => {
    // Profile says opencode, config says opencode, but the command says pi.
    const config = makeConfig("opencode");
    const profile = makeProfile("opencode");
    expect(resolveRuntimeName(config, profile, "pi")).toBe("pi");
  });

  it("the trigger override wins when set, even over a profile runtime", () => {
    const config = makeConfig();
    const profile = makeProfile("pi");
    expect(resolveRuntimeName(config, profile, "opencode")).toBe("opencode");
  });

  it("an invalid trigger override falls through to the profile", () => {
    const config = makeConfig();
    const profile = makeProfile("opencode");
    // Only "pi" / "opencode" are valid overrides; anything else is ignored.
    expect(resolveRuntimeName(config, profile, "invalid" as any)).toBe("opencode");
  });

  it("a null/undefined trigger override falls through to the profile", () => {
    const config = makeConfig();
    const profile = makeProfile("opencode");
    expect(resolveRuntimeName(config, profile, null)).toBe("opencode");
    expect(resolveRuntimeName(config, profile, undefined)).toBe("opencode");
  });

  it("profile runtime wins over config.default_runtime", () => {
    const config = makeConfig("opencode");
    const profile = makeProfile("pi");
    expect(resolveRuntimeName(config, profile)).toBe("pi");
  });
});

describe("resolveRuntimeName — schema defaults", () => {
  it("ProfileSchema defaults runtime to 'pi'", () => {
    const config = makeConfig();
    expect(config.profiles.p.runtime).toBe("pi");
  });

  it("NoodleConfigSchema defaults default_runtime to 'pi'", () => {
    const config = makeConfig();
    expect(config.default_runtime).toBe("pi");
  });

  it("both runtimes are selectable via config", () => {
    const piConfig = makeConfig("pi", "pi");
    const ocConfig = makeConfig("opencode", "opencode");
    expect(piConfig.default_runtime).toBe("pi");
    expect(piConfig.profiles.p.runtime).toBe("pi");
    expect(ocConfig.default_runtime).toBe("opencode");
    expect(ocConfig.profiles.p.runtime).toBe("opencode");
  });
});
