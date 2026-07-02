import { describe, it, expect } from "vitest";
import { NoodleConfigSchema, crossValidate } from "../src/config/schema.js";
import { registerCustomProviders, isCustomEndpoint } from "../src/profiles/custom-providers.js";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

const base = {
  default_profile: "p",
  profiles: { p: { provider: "openai", model: "gpt-4o-mini" } },
  routing: [],
};

describe("custom endpoint config validation", () => {
  it("parses a custom-endpoint profile with api + base_url", () => {
    const c = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        vllm: {
          provider: "vllm",
          api: "openai-completions",
          base_url: "http://localhost:8000/v1",
          model: "llama",
          api_key_env: "VLLM_KEY",
          context_window: 131072,
        },
      },
    });
    const p = c.profiles.vllm;
    expect(p.api).toBe("openai-completions");
    expect(p.base_url).toBe("http://localhost:8000/v1");
    expect(p.context_window).toBe(131072);
  });

  it("rejects base_url without api", () => {
    const c = NoodleConfigSchema.parse({
      ...base,
      profiles: { x: { provider: "x", model: "m", base_url: "http://y/v1" } },
    });
    expect(crossValidate(c).join("\n")).toMatch(/api.*required when.*base_url/);
  });

  it("rejects api without base_url", () => {
    const c = NoodleConfigSchema.parse({
      ...base,
      profiles: { x: { provider: "x", model: "m", api: "openai-completions" } },
    });
    expect(crossValidate(c).join("\n")).toMatch(/base_url.*required when.*api/);
  });

  it("rejects an unknown api protocol", () => {
    const r = NoodleConfigSchema.safeParse({
      ...base,
      profiles: { x: { provider: "x", model: "m", api: "made-up-protocol" } },
    });
    expect(r.success).toBe(false);
  });
});

describe("registerCustomProviders", () => {
  function freshRegistry() {
    return ModelRegistry.create(AuthStorage.create());
  }

  it("registers an OpenAI-compatible custom provider so find() resolves", () => {
    const config = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        vllm: {
          provider: "vllm",
          api: "openai-completions",
          base_url: "http://localhost:8000/v1",
          model: "llama-3.1",
          context_window: 131072,
        },
      },
    });
    const reg = freshRegistry();
    registerCustomProviders(config, reg);
    const m = reg.find("vllm", "llama-3.1");
    expect(m.id).toBe("llama-3.1");
    expect(m.api).toBe("openai-completions");
    expect(m.baseUrl).toBe("http://localhost:8000/v1");
  });

  it("registers an Anthropic-compatible custom provider", () => {
    const config = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        proxy: {
          provider: "acme",
          api: "anthropic-messages",
          base_url: "https://llm.acme.corp",
          model: "claude-proxy",
          api_key_env: "ACME_KEY",
        },
      },
    });
    process.env.ACME_KEY = "sk-test";
    const reg = freshRegistry();
    registerCustomProviders(config, reg);
    const m = reg.find("acme", "claude-proxy");
    expect(m.api).toBe("anthropic-messages");
    delete process.env.ACME_KEY;
  });

  it("skips built-in providers (only registers custom ones)", () => {
    const config = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        builtin: { provider: "openai", model: "gpt-4o-mini" }, // no base_url/api
        custom: {
          provider: "vllm",
          api: "openai-completions",
          base_url: "http://x/v1",
          model: "m",
        },
      },
    });
    const reg = freshRegistry();
    // should not throw for the built-in profile, and should register the custom one
    expect(() => registerCustomProviders(config, reg)).not.toThrow();
    expect(() => reg.find("vllm", "m")).not.toThrow();
  });

  it("isCustomEndpoint detects custom profiles", () => {
    const c = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        custom: { provider: "x", api: "openai-completions", base_url: "http://y", model: "m" },
        builtin: { provider: "openai", model: "gpt-4o" },
      },
    });
    expect(isCustomEndpoint(c.profiles.custom)).toBe(true);
    expect(isCustomEndpoint(c.profiles.builtin)).toBe(false);
  });
});
