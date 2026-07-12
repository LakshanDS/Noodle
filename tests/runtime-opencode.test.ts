import { describe, it, expect, vi, beforeEach } from "vitest";
import { profileToOpenCodeConfig, openCodeEventToRuntimeEvent, statsFromLastInfo } from "../src/engine/runtimes/opencode.js";
import type { RuntimeBootOptions, RuntimeEvent } from "../src/engine/runtime.js";
import type { NoodleConfig } from "../src/config/schema.js";
import { NoodleConfigSchema } from "../src/config/schema.js";

/**
 * Tests for the OpenCode runtime adapter's pure functions:
 *   - `profileToOpenCodeConfig`: Noodle profile → OpenCode Config translation
 *   - `openCodeEventToRuntimeEvent`: OpenCode Event → RuntimeEvent translation
 *
 * The SDK-driven boot path (createOpencode, session.create, event.subscribe) is
 * an integration concern — it needs a real OpenCode install and isn't unit-tested
 * here. The pure mappers are the load-bearing logic and are fully testable.
 */

/** Build a ResolvedProfile from a minimal config for testing. */
function makeProfile(overrides: Record<string, unknown> = {}): RuntimeBootOptions["profile"] {
  const config = NoodleConfigSchema.parse({
    agent_name: "TestBot",
    default_profile: "p",
    profiles: { p: { provider: "openai", model: "gpt-4o-mini", ...overrides } },
    routing: [],
  }) as NoodleConfig;
  return { name: "p", ...config.profiles.p };
}

describe("profileToOpenCodeConfig", () => {
  it("sets the model to provider/model", () => {
    const profile = makeProfile({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
    const config = profileToOpenCodeConfig(profile);
    expect(config.model).toBe("anthropic/claude-sonnet-4-20250514");
  });

  it("sets autonomous permissions (allow all) so runs never prompt", () => {
    const profile = makeProfile();
    const config = profileToOpenCodeConfig(profile);
    expect(config.permission).toEqual({
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      external_directory: "allow",
      doom_loop: "allow",
    });
  });

  it("registers a custom provider when base_url + api are set", () => {
    const profile = makeProfile({
      provider: "ollama",
      model: "llama3",
      base_url: "http://localhost:11434/v1",
      api: "openai-completions",
      context_window: 8192,
    });
    const config = profileToOpenCodeConfig(profile);
    expect(config.provider).toBeDefined();
    expect(config.provider!.ollama).toBeDefined();
    expect(config.provider!.ollama.api).toBe("openai");
    expect(config.provider!.ollama.options?.baseURL).toBe("http://localhost:11434/v1");
    expect(config.provider!.ollama.models?.llama3.limit?.context).toBe(8192);
  });

  it("maps wire-protocol api names to OpenCode's shorter format", () => {
    const cases: Record<string, string> = {
      "openai-completions": "openai",
      "openai-responses": "openai",
      "anthropic-messages": "anthropic",
      "google-generative-ai": "google",
      "mistral-conversations": "mistral",
      "bedrock-converse-stream": "bedrock",
    };
    for (const [input, expected] of Object.entries(cases)) {
      const profile = makeProfile({ provider: "x", model: "m", base_url: "http://x", api: input });
      const config = profileToOpenCodeConfig(profile);
      expect(config.provider!.x.api).toBe(expected);
    }
  });

  it("wires stdio MCP servers as local command entries", () => {
    const profile = makeProfile({ mcp_servers: ["filesystem"] });
    const resolved = {
      filesystem: { type: "stdio" as const, command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], env: { ROOT: "/tmp" } },
    };
    const config = profileToOpenCodeConfig(profile, resolved);
    expect(config.mcp).toBeDefined();
    expect(config.mcp!.filesystem).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
      environment: { ROOT: "/tmp" },
    });
  });

  it("wires remote MCP servers (sse/http) as remote URL entries", () => {
    const profile = makeProfile({ mcp_servers: ["remote"] });
    const resolved = {
      remote: { type: "sse" as const, url: "https://mcp.example.com/sse", args: [] },
    };
    const config = profileToOpenCodeConfig(profile, resolved);
    expect(config.mcp!.remote).toEqual({ type: "remote", url: "https://mcp.example.com/sse" });
  });

  it("omits the mcp block when no servers are configured", () => {
    const profile = makeProfile();
    const config = profileToOpenCodeConfig(profile);
    expect(config.mcp).toBeUndefined();
  });

  it("omits the mcp block when profile has names but no resolved definitions", () => {
    const profile = makeProfile({ mcp_servers: ["missing"] });
    const config = profileToOpenCodeConfig(profile, {});
    expect(config.mcp).toBeUndefined();
  });
});

describe("openCodeEventToRuntimeEvent", () => {
  it("maps session.status busy → agent_start", () => {
    expect(openCodeEventToRuntimeEvent({ type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } } as never))
      .toEqual<RuntimeEvent>({ type: "agent_start" });
  });

  it("maps session.status idle → agent_end", () => {
    expect(openCodeEventToRuntimeEvent({ type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } } as never))
      .toEqual<RuntimeEvent>({ type: "agent_end" });
  });

  it("maps session.status retry → retry", () => {
    expect(openCodeEventToRuntimeEvent({ type: "session.status", properties: { sessionID: "s1", status: { type: "retry", attempt: 2, message: "429", next: 1000 } } } as never))
      .toEqual<RuntimeEvent>({ type: "retry", attempt: 2, maxAttempts: 0, error: "429" });
  });

  it("maps session.idle → agent_end", () => {
    expect(openCodeEventToRuntimeEvent({ type: "session.idle", properties: { sessionID: "s1" } } as never))
      .toEqual<RuntimeEvent>({ type: "agent_end" });
  });

  it("maps session.compacted → compaction start", () => {
    expect(openCodeEventToRuntimeEvent({ type: "session.compacted", properties: { sessionID: "s1" } } as never))
      .toEqual<RuntimeEvent>({ type: "compaction", phase: "start" });
  });

  it("maps tool part running → tool_start", () => {
    expect(openCodeEventToRuntimeEvent({
      type: "message.part.updated",
      properties: { part: { type: "tool", tool: "bash", state: { status: "running", input: { command: "npm test" } } } },
    } as never)).toEqual<RuntimeEvent>({
      type: "tool_start",
      tool: "bash",
      args: { command: "npm test" },
    });
  });

  it("maps tool part completed → tool_end", () => {
    expect(openCodeEventToRuntimeEvent({
      type: "message.part.updated",
      properties: { part: { type: "tool", tool: "grep", state: { status: "completed", output: "found 3 matches" } } },
    } as never)).toEqual<RuntimeEvent>({
      type: "tool_end",
      tool: "grep",
      isError: false,
      output: "found 3 matches",
    });
  });

  it("maps tool part error → tool_end with isError", () => {
    expect(openCodeEventToRuntimeEvent({
      type: "message.part.updated",
      properties: { part: { type: "tool", tool: "bash", state: { status: "error", output: "exit code 1" } } },
    } as never)).toEqual<RuntimeEvent>({
      type: "tool_end",
      tool: "bash",
      isError: true,
      output: "exit code 1",
    });
  });

  it("maps non-tool part updates (text/reasoning) → activity", () => {
    expect(openCodeEventToRuntimeEvent({
      type: "message.part.updated",
      properties: { part: { type: "text", text: "partial..." } },
    } as never)).toEqual<RuntimeEvent>({ type: "activity" });
  });

  it("maps assistant message.updated → message_end (empty text — parts fetched separately)", () => {
    expect(openCodeEventToRuntimeEvent({
      type: "message.updated",
      properties: { info: { role: "assistant" } },
    } as never)).toEqual<RuntimeEvent>({ type: "message_end", role: "assistant", text: "" });
  });

  it("drops non-assistant message.updated → activity", () => {
    expect(openCodeEventToRuntimeEvent({
      type: "message.updated",
      properties: { info: { role: "user" } },
    } as never)).toEqual<RuntimeEvent>({ type: "activity" });
  });

  it("maps unknown event types → activity (stall-watcher poke)", () => {
    expect(openCodeEventToRuntimeEvent({ type: "file.edited", properties: { file: "src/x.ts" } } as never))
      .toEqual<RuntimeEvent>({ type: "activity" });
    expect(openCodeEventToRuntimeEvent({ type: "todo.updated", properties: { sessionID: "s1", todos: [] } } as never))
      .toEqual<RuntimeEvent>({ type: "activity" });
  });
});

describe("statsFromLastInfo", () => {
  it("returns undefined when no info is available (before first prompt)", () => {
    expect(statsFromLastInfo(undefined)).toBeUndefined();
  });

  it("returns undefined when info has no tokens", () => {
    expect(statsFromLastInfo({ cost: 0.5 })).toBeUndefined();
  });

  it("maps input + reasoning → input, output → output, cache read/write separate", () => {
    const stats = statsFromLastInfo({
      cost: 0.42,
      tokens: {
        input: 1000,
        output: 500,
        reasoning: 200, // summed into input
        cache: { read: 300, write: 100 },
      },
    });
    expect(stats).toBeDefined();
    expect(stats!.tokens).toEqual({
      input: 1200,   // 1000 + 200 reasoning
      output: 500,
      cacheRead: 300,
      cacheWrite: 100,
      total: 2100,   // 1200 + 500 + 300 + 100
    });
    expect(stats!.cost).toBe(0.42);
  });

  it("handles missing cache fields (no cache support)", () => {
    const stats = statsFromLastInfo({
      tokens: { input: 100, output: 50 },
    });
    expect(stats!.tokens).toEqual({
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      total: 150,
    });
    expect(stats!.cost).toBeUndefined();
  });

  it("handles zero-token runs", () => {
    const stats = statsFromLastInfo({
      cost: 0,
      tokens: { input: 0, output: 0 },
    });
    expect(stats!.tokens!.total).toBe(0);
    expect(stats!.cost).toBe(0);
  });
});
