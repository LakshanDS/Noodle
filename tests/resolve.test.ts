import { describe, it, expect } from "vitest";
import { resolveProfile } from "../src/profiles/resolve.js";
import type { NoodleConfig } from "../src/config/schema.js";
import type { IssueInput } from "../src/profiles/types.js";

const cfg: NoodleConfig = {
  default_profile: "cheap",
  profiles: {
    claude: { provider: "anthropic", model: "sonnet", base_url: "https://api.anthropic.com", api: "anthropic-messages", api_key: "sk-1", thinking_level: "medium", tools: ["read"], input_token_price: 0, output_token_price: 0, cache_read_price: 0, cache_write_price: 0, reasoning: false, api_rpm: 30, retry_max_attempts: 5, retry_base_delay_ms: 3000 },
    cheap: { provider: "openrouter", model: "haiku", base_url: "https://openrouter.ai/v1", api: "openai-completions", api_key: "sk-2", thinking_level: "off", tools: ["read"], input_token_price: 0, output_token_price: 0, cache_read_price: 0, cache_write_price: 0, reasoning: false, api_rpm: 30, retry_max_attempts: 5, retry_base_delay_ms: 3000 },
  },
  routing: [
    { kind: "slash", match: "/claude", profile: "claude" },
    { kind: "label", match: "bug", profile: "cheap" },
    { kind: "keyword", match: "refactor|architecture", profile: "claude" },
  ],
  repos: {},
};

const issue = (o: Partial<IssueInput>): IssueInput => ({
  title: "", body: "", labels: [], comments: [], ...o,
});

describe("resolveProfile", () => {
  it("falls back to default when nothing matches", () => {
    expect(resolveProfile(cfg, issue({ title: "hi" })).name).toBe("cheap");
  });

  it("matches a slash command in the body", () => {
    expect(resolveProfile(cfg, issue({ body: "/claude please" })).name).toBe("claude");
  });

  it("matches a slash command in a comment", () => {
    expect(resolveProfile(cfg, issue({ comments: ["looks bad", "/claude"] })).name).toBe("claude");
  });

  it("does not match a slash command embedded in a word", () => {
    // "/claude" must be a standalone token
    expect(resolveProfile(cfg, issue({ body: "foo/claudeBar" })).name).toBe("cheap");
  });

  it("matches a label case-insensitively", () => {
    expect(resolveProfile(cfg, issue({ labels: ["BUG"] })).name).toBe("cheap");
  });

  it("matches a keyword regex", () => {
    expect(resolveProfile(cfg, issue({ title: "Architecture cleanup" })).name).toBe("claude");
  });

  it("slash beats label beats keyword (order)", () => {
    // has bug label (-> cheap) but /claude command (-> claude); slash wins
    expect(resolveProfile(cfg, issue({ body: "/claude", labels: ["bug"] })).name).toBe("claude");
  });

  it("respects per-repo default override", () => {
    const c: NoodleConfig = { ...cfg, repos: { "owner/name": { default_profile: "claude" } } };
    expect(resolveProfile(c, issue({ title: "plain" }), "owner/name").name).toBe("claude");
  });
});
