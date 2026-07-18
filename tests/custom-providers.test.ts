import { describe, it, expect } from "vitest";
import { NoodleConfigSchema, crossValidate } from "../src/config/schema.js";
import { registerCustomProviders } from "../src/profiles/custom-providers.js";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

/** A minimal valid profile — base_url + api are required (every profile is a custom endpoint). */
function profile(model = "llama") {
  return {
    model,
    base_url: "http://localhost:8000/v1",
    api: "openai-completions" as const,
    api_key: "sk-test",
  };
}

const base = {
  default_profile: "p",
  profiles: { p: profile() },
  routing: [],
};

describe("custom endpoint config validation", () => {
  it("parses a custom-endpoint profile with api + base_url", () => {
    const c = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        vllm: {
          api: "openai-completions",
          base_url: "http://localhost:8000/v1",
          model: "llama",
          api_key: "sk-test",
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
    // base_url is a URL, api is required — Zod rejects missing api.
    const r = NoodleConfigSchema.safeParse({
      ...base,
      profiles: { x: { provider: "x", model: "m", base_url: "http://y/v1" } },
    });
    expect(r.success).toBe(false);
  });

  it("rejects api without base_url", () => {
    // base_url is required — Zod rejects it.
    const r = NoodleConfigSchema.safeParse({
      ...base,
      profiles: { x: { provider: "x", model: "m", api: "openai-completions" } },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown api protocol", () => {
    const r = NoodleConfigSchema.safeParse({
      ...base,
      profiles: { x: { provider: "x", model: "m", base_url: "http://y", api: "made-up-protocol" } },
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
          api: "openai-completions",
          base_url: "http://localhost:8000/v1",
          model: "llama-3.1",
          context_window: 131072,
          api_key: "sk-test",
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
          api: "anthropic-messages",
          base_url: "https://llm.acme.corp",
          model: "claude-proxy",
          api_key: "sk-test",
        },
      },
    });
    const reg = freshRegistry();
    registerCustomProviders(config, reg);
    const m = reg.find("proxy", "claude-proxy");
    expect(m.api).toBe("anthropic-messages");
  });

  it("registers a custom provider with pricing from the profile config", () => {
    const config = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        deepseek: {
          api: "openai-completions",
          base_url: "https://api.deepseek.com/v1",
          model: "deepseek-chat",
          api_key: "sk-test",
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
  });

  it("defaults pricing to 0 when not set (local models)", () => {
    const config = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        ollama: {
          api: "openai-completions",
          base_url: "http://localhost:11434/v1",
          model: "llama3",
          api_key: "",
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
    const config = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        vllm: {
          api: "openai-completions",
          base_url: "http://x/v1",
          model: "llama3",
          api_key: "sk-test",
        },
      },
    });
    const reg = freshRegistry();
    registerCustomProviders(config, reg);
    expect(reg.find("vllm", "llama3").reasoning).toBe(false);
  });

  it("registers custom endpoints with reasoning enabled when set in config", () => {
    const config = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        deepseek: {
          api: "openai-completions",
          base_url: "https://api.deepseek.com/v1",
          model: "deepseek-reasoner",
          api_key: "sk-test",
          reasoning: true,
        },
      },
    });
    const reg = freshRegistry();
    registerCustomProviders(config, reg);
    expect(reg.find("deepseek", "deepseek-reasoner").reasoning).toBe(true);
  });

  it("registers cache pricing for an Anthropic-protocol proxy", () => {
    const config = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        proxy: {
          api: "anthropic-messages",
          base_url: "https://llm.internal.acme.corp",
          model: "our-finetune-v2",
          api_key: "sk-test",
          input_token_price: 3.0,
          output_token_price: 15.0,
          cache_read_price: 0.3,
          cache_write_price: 3.75,
        },
      },
    });
    const reg = freshRegistry();
    registerCustomProviders(config, reg);
    const m = reg.find("proxy", "our-finetune-v2");
    expect(m.cost.input).toBe(3.0);
    expect(m.cost.output).toBe(15.0);
    expect(m.cost.cacheRead).toBe(0.3);
    expect(m.cost.cacheWrite).toBe(3.75);
  });
});

describe("profile pricing config", () => {
  it("parses input_token_price / output_token_price", () => {
    const c = NoodleConfigSchema.parse({
      ...base,
      profiles: {
        p: {
          api: "openai-completions",
          base_url: "http://x/v1",
          model: "m",
          api_key: "sk-test",
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
          api: "anthropic-messages",
          base_url: "https://llm.acme.corp",
          model: "m",
          api_key: "sk-test",
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
      profiles: { p: profile() },
    });
    expect(c.profiles.p.input_token_price).toBe(0);
    expect(c.profiles.p.output_token_price).toBe(0);
    expect(c.profiles.p.cache_read_price).toBe(0);
    expect(c.profiles.p.cache_write_price).toBe(0);
  });

  it("rejects negative prices", () => {
    const r = NoodleConfigSchema.safeParse({
      ...base,
      profiles: { p: { ...profile(), input_token_price: -1 } },
    });
    expect(r.success).toBe(false);
  });
});
