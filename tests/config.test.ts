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
    expect(c.agent_name).toBe("Noodle"); // default
    expect(c.profiles.cheap.thinking_level).toBe("medium"); // default
    expect(c.profiles.cheap.reasoning).toBe(false); // default
    expect(c.profiles.cheap.tools).toContain("read"); // default tool set
    expect(c.profiles.cheap.api_rpm).toBe(30); // default rate limit
    expect(c.routing).toHaveLength(1);
  });

  it("accepts a custom agent_name", () => {
    const c = NoodleConfigSchema.parse({ ...validBase, agent_name: "MyBot" });
    expect(c.agent_name).toBe("MyBot");
  });

  it("rejects an empty agent_name", () => {
    const r = NoodleConfigSchema.safeParse({ ...validBase, agent_name: "" });
    expect(r.success).toBe(false);
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

  it("applies opt-in trigger defaults", () => {
    const c = NoodleConfigSchema.parse(validBase);
    expect(c.triggers).toEqual({
      trigger_on_mention: true,
      trigger_keywords: [],
      trigger_on_open: false,
    });
  });

  it("accepts an explicit triggers block (legacy always-fire mode)", () => {
    const c = NoodleConfigSchema.parse({
      ...validBase,
      triggers: {
        trigger_on_mention: false,
        trigger_keywords: ["noodle-fix"],
        trigger_on_open: true,
      },
    });
    expect(c.triggers).toEqual({
      trigger_on_mention: false,
      trigger_keywords: ["noodle-fix"],
      trigger_on_open: true,
    });
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

describe("Phase 3 config blocks (run + queue)", () => {
  it("applies defaults when run/queue are omitted", () => {
    const c = NoodleConfigSchema.parse(validBase);
    expect(c.run).toEqual({ stall_timeout_minutes: 15, tool_stall_minutes: 60 });
    expect(c.queue).toEqual({ concurrency: 1, max_attempts: 3, retry_backoff_seconds: 60 });
  });

  it("parses an explicit run block with both budgets", () => {
    const c = NoodleConfigSchema.parse({
      ...validBase,
      run: { stall_timeout_minutes: 30, tool_stall_minutes: 120 },
    });
    expect(c.run.stall_timeout_minutes).toBe(30);
    expect(c.run.tool_stall_minutes).toBe(120);
  });

  it("parses an explicit queue block", () => {
    const c = NoodleConfigSchema.parse({
      ...validBase,
      queue: { concurrency: 2, max_attempts: 5, retry_backoff_seconds: 120 },
    });
    expect(c.queue.concurrency).toBe(2);
    expect(c.queue.max_attempts).toBe(5);
    expect(c.queue.retry_backoff_seconds).toBe(120);
  });

  it("accepts stall_timeout_minutes: 0 (disabled)", () => {
    const c = NoodleConfigSchema.parse({ ...validBase, run: { stall_timeout_minutes: 0, tool_stall_minutes: 60 } });
    expect(c.run.stall_timeout_minutes).toBe(0);
  });

  it("accepts tool_stall_minutes: 0 (falls back to idle budget)", () => {
    const c = NoodleConfigSchema.parse({ ...validBase, run: { stall_timeout_minutes: 15, tool_stall_minutes: 0 } });
    expect(c.run.tool_stall_minutes).toBe(0);
  });

  it("rejects a negative stall_timeout_minutes", () => {
    const r = NoodleConfigSchema.safeParse({ ...validBase, run: { stall_timeout_minutes: -1 } });
    expect(r.success).toBe(false);
  });

  it("rejects a negative tool_stall_minutes", () => {
    const r = NoodleConfigSchema.safeParse({ ...validBase, run: { tool_stall_minutes: -1 } });
    expect(r.success).toBe(false);
  });

  it("rejects concurrency < 1", () => {
    const r = NoodleConfigSchema.safeParse({ ...validBase, queue: { concurrency: 0 } });
    expect(r.success).toBe(false);
  });

  it("rejects max_attempts < 1", () => {
    const r = NoodleConfigSchema.safeParse({ ...validBase, queue: { max_attempts: 0 } });
    expect(r.success).toBe(false);
  });
});
