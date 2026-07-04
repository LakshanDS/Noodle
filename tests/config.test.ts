import { describe, it, expect } from "vitest";
import { NoodleConfigSchema, crossValidate } from "../src/config/schema.js";

const validBase = {
  default_profile: "cheap",
  profiles: {
    cheap: { provider: "openrouter", model: "haiku" },
    claude: { provider: "anthropic", model: "sonnet" },
  },
  routing: [{ kind: "slash", match: "/claude", profile: "claude" }],
};

describe("config schema", () => {
  it("parses a valid config and applies defaults", () => {
    const c = NoodleConfigSchema.parse(validBase);
    expect(c.profiles.cheap.thinking_level).toBe("off"); // default
    expect(c.profiles.cheap.tools).toContain("read"); // default tool set
    expect(c.profiles.cheap.api_rpm).toBe(30); // default rate limit
    expect(c.routing).toHaveLength(1);
  });

  it("defaults api_rpm to 30 and accepts 0 as unlimited", () => {
    const c = NoodleConfigSchema.parse({
      ...validBase,
      profiles: {
        cheap: { provider: "openrouter", model: "haiku" }, // api_rpm omitted → 30
        unlimited: { provider: "openrouter", model: "haiku", api_rpm: 0 },
      },
    });
    expect(c.profiles.cheap.api_rpm).toBe(30);
    expect(c.profiles.unlimited.api_rpm).toBe(0);
  });

  it("rejects an unknown thinking_level", () => {
    const r = NoodleConfigSchema.safeParse({
      ...validBase,
      profiles: { cheap: { provider: "x", model: "y", thinking_level: "nope" } },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a slash rule whose match lacks leading slash", () => {
    const c = NoodleConfigSchema.parse({
      ...validBase,
      routing: [{ kind: "slash", match: "claude", profile: "claude" }],
    });
    const errs = crossValidate(c);
    expect(errs.join("\n")).toMatch(/must start with "\/"/);
  });
});

describe("crossValidate", () => {
  it("flags a routing rule pointing at an undefined profile", () => {
    const c = NoodleConfigSchema.parse({
      ...validBase,
      routing: [{ kind: "label", match: "x", profile: "ghost" }],
    });
    expect(crossValidate(c).join("\n")).toMatch(/not defined/);
  });

  it("flags default_profile pointing at an undefined profile", () => {
    const c = NoodleConfigSchema.parse({ ...validBase, default_profile: "ghost" });
    expect(crossValidate(c).join("\n")).toMatch(/default_profile "ghost"/);
  });

  it("passes on a fully valid config", () => {
    expect(crossValidate(NoodleConfigSchema.parse(validBase))).toHaveLength(0);
  });
});

describe("Phase 2 config blocks", () => {
  it("applies defaults when server/storage/scheduler are omitted", () => {
    const c = NoodleConfigSchema.parse(validBase);
    expect(c.server).toEqual({ host: "0.0.0.0", port: 3000 });
    expect(c.storage).toEqual({ sqlite_path: "./noodle.db" });
    expect(c.scheduler).toEqual({ enabled: false, interval_minutes: 30, repos: [] });
  });

  it("parses an explicit server/storage/scheduler block", () => {
    const c = NoodleConfigSchema.parse({
      ...validBase,
      server: { host: "127.0.0.1", port: 8080 },
      storage: { sqlite_path: "/var/noodle.db" },
      scheduler: { enabled: true, interval_minutes: 15, repos: ["owner/name"] },
    });
    expect(c.server.port).toBe(8080);
    expect(c.storage.sqlite_path).toBe("/var/noodle.db");
    expect(c.scheduler.enabled).toBe(true);
    expect(c.scheduler.repos).toEqual(["owner/name"]);
  });

  it("flags scheduler enabled with no repos", () => {
    const c = NoodleConfigSchema.parse({
      ...validBase,
      scheduler: { enabled: true, repos: [] },
    });
    expect(crossValidate(c).join("\n")).toMatch(/scheduler.*repos/);
  });

  it("flags a malformed repo in scheduler.repos", () => {
    const c = NoodleConfigSchema.parse({
      ...validBase,
      scheduler: { enabled: true, repos: ["not-a-repo"] },
    });
    expect(crossValidate(c).join("\n")).toMatch(/not a valid "owner\/name"/);
  });

  it("passes when scheduler is enabled with valid repos", () => {
    const c = NoodleConfigSchema.parse({
      ...validBase,
      scheduler: { enabled: true, interval_minutes: 5, repos: ["a/b", "c/d"] },
    });
    expect(crossValidate(c)).toHaveLength(0);
  });
});
