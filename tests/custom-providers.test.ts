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

  it("registers a custom provider with pricing from the profile config", () => {
    // input_token_price / output_token_price flow into pi's model cost object
    // so the run footer reports real cost for OpenAI-compatible endpoints.
    process.env.DEEPSEEK_KEY = "sk-test";
    try {
      const config = NoodleConfigSchema.parse({
        ...base,
        profiles: {
          deepseek: {
            provider: "deepseek",
            api: "openai-completions",
            base_url: "https://api.deepseek.com/v1",
            model: "deepseek-chat",
            api_key_env: "DEEPSEEK_KEY",
            input_token_price: 0.14,
            output_token_price: 0.28,
          },
        },
      });
      const reg = freshRegistry();
      registerCustomProviders(config, reg);
      const m = reg.find("deepseek", "deepseek-chat");
      expect(m.cost.input).toBe(0.14);
      expect(m.cost.output).toBe(0.28);
    } finally {
      delete process.env.DEEPSEEK_KEY;
    }
  });

  it("defaults pricing to 0 when not set (local models)", () => {
    const config = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        ollama: {
          provider: "ollama",
          api: "openai-completions",
          base_url: "http://localhost:11434/v1",
          model: "llama3",
        },
      },
    });
    const reg = freshRegistry();
    registerCustomProviders(config, reg);
    const m = reg.find("ollama", "llama3");
    expect(m.cost.input).toBe(0);
    expect(m.cost.output).toBe(0);
    expect(m.cost.cacheRead).toBe(0);
    expect(m.cost.cacheWrite).toBe(0);
  });

  it("registers custom endpoints with reasoning disabled by default", () => {
    // pi-ai gates all thinking-format handling on model.reasoning === true.
    // Custom endpoints default to false so thinking_level is a safe no-op
    // unless the profile explicitly opts in.
    const config = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        vllm: {
          provider: "vllm",
          api: "openai-completions",
          base_url: "http://x/v1",
          model: "llama3",
        },
      },
    });
    const reg = freshRegistry();
    registerCustomProviders(config, reg);
    expect(reg.find("vllm", "llama3").reasoning).toBe(false);
  });

  it("registers custom endpoints with reasoning enabled when set in config", () => {
    // A reasoning-capable model behind an OpenAI-compatible endpoint (e.g.
    // DeepSeek-R1, Qwen3-Thinking) opts in via `reasoning: true` so the
    // thinking_level is forwarded to the API.
    process.env.R_KEY = "sk-test";
    try {
      const config = NoodleConfigSchema.parse({
        ...base,
        profiles: {
          deepseek: {
            provider: "deepseek",
            api: "openai-completions",
            base_url: "https://api.deepseek.com/v1",
            model: "deepseek-reasoner",
            api_key_env: "R_KEY",
            reasoning: true,
          },
        },
      });
      const reg = freshRegistry();
      registerCustomProviders(config, reg);
      expect(reg.find("deepseek", "deepseek-reasoner").reasoning).toBe(true);
    } finally {
      delete process.env.R_KEY;
    }
  });

  it("registers cache pricing for an Anthropic-protocol proxy", () => {
    // A self-hosted Anthropic-format gateway that supports prompt caching:
    // all four price fields flow through to pi's model cost object.
    process.env.ACME2_KEY = "sk-test";
    try {
      const config = NoodleConfigSchema.parse({
        ...base,
        profiles: {
          proxy: {
            provider: "acme2",
            api: "anthropic-messages",
            base_url: "https://llm.internal.acme.corp",
            model: "our-finetune-v2",
            api_key_env: "ACME2_KEY",
            input_token_price: 3.0,
            output_token_price: 15.0,
            cache_read_price: 0.3,
            cache_write_price: 3.75,
          },
        },
      });
      const reg = freshRegistry();
      registerCustomProviders(config, reg);
      const m = reg.find("acme2", "our-finetune-v2");
      expect(m.cost.input).toBe(3.0);
      expect(m.cost.output).toBe(15.0);
      expect(m.cost.cacheRead).toBe(0.3);
      expect(m.cost.cacheWrite).toBe(3.75);
    } finally {
      delete process.env.ACME2_KEY;
    }
  });
});

describe("profile pricing config", () => {
  it("parses input_token_price / output_token_price", () => {
    const c = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        p: {
          provider: "vllm",
          api: "openai-completions",
          base_url: "http://x/v1",
          model: "m",
          input_token_price: 1.0,
          output_token_price: 10.0,
        },
      },
    });
    expect(c.profiles.p.input_token_price).toBe(1.0);
    expect(c.profiles.p.output_token_price).toBe(10.0);
  });

  it("parses cache_read_price / cache_write_price", () => {
    const c = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        p: {
          provider: "acme",
          api: "anthropic-messages",
          base_url: "https://llm.acme.corp",
          model: "m",
          input_token_price: 3.0,
          output_token_price: 15.0,
          cache_read_price: 0.3,
          cache_write_price: 3.75,
        },
      },
    });
    expect(c.profiles.p.cache_read_price).toBe(0.3);
    expect(c.profiles.p.cache_write_price).toBe(3.75);
  });

  it("defaults all prices to 0 when omitted", () => {
    const c = NoodleConfigSchema.parse({
      ...base,
      profiles: { p: { provider: "vllm", api: "openai-completions", base_url: "http://x/v1", model: "m" } },
    });
    expect(c.profiles.p.input_token_price).toBe(0);
    expect(c.profiles.p.output_token_price).toBe(0);
    expect(c.profiles.p.cache_read_price).toBe(0);
    expect(c.profiles.p.cache_write_price).toBe(0);
  });

  it("rejects negative prices", () => {
    const r = NoodleConfigSchema.safeParse({
      ...base,
      profiles: { p: { provider: "vllm", api: "openai-completions", base_url: "http://x/v1", model: "m", input_token_price: -1 } },
    });
    expect(r.success).toBe(false);
  });
});
