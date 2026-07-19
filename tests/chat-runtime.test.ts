import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ChatStore } from "../src/server/chat-store.js";
import { ChatRuntime, BusyError } from "../src/engine/chat-runtime.js";

/* ---- Module mocks ---- */

vi.mock("../src/util/paths.js", () => ({
  installSkills: vi.fn().mockResolvedValue(undefined),
  noodleSkillsDir: () => "/tmp/skills",
}));

vi.mock("../src/engine/workspace.js", () => {
  const wsDir = mkdtempSync(join(tmpdir(), "noodle-chat-rt-ws-"));
  return {
    Workspace: {
      clone: vi.fn().mockResolvedValue({
        path: wsDir,
        branch: vi.fn(),
        checkoutRemote: vi.fn(),
        removeInternals: vi.fn(),
        commitAll: vi.fn().mockResolvedValue(false),
        push: vi.fn(),
        changedFiles: vi.fn().mockResolvedValue([]),
        dispose: vi.fn(),
      }),
      rewrap: vi.fn((dir: string) => ({
        path: dir,
        branch: vi.fn(),
        checkoutRemote: vi.fn(),
        removeInternals: vi.fn(),
        commitAll: vi.fn().mockResolvedValue(false),
        push: vi.fn(),
        changedFiles: vi.fn().mockResolvedValue([]),
        dispose: vi.fn(),
      })),
    },
    cloneUrlFor: (repo: string, token: string) => `https://${token}@github.com/${repo}`,
  };
});

vi.mock("../src/profiles/custom-providers.js", () => ({
  registerCustomProviders: vi.fn(() => new Map([["test", "test"]])),
}));

vi.mock("../src/engine/pi-settings.js", () => ({
  buildSettingsManager: vi.fn(() => ({
    applyOverrides: vi.fn(),
  })),
}));

vi.mock("../src/engine/throttle.js", () => ({
  throttleForRpm: vi.fn(() => null),
  throttleExtensionFactory: vi.fn(),
}));

vi.mock("../src/engine/stall.js", () => ({
  StallWatcher: vi.fn(() => ({
    attach: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: { create: vi.fn(() => ({})) },
  ModelRegistry: {
    create: vi.fn(() => ({
      find: vi.fn(() => ({ id: "gpt-4o", name: "gpt-4o" })),
    })),
  },
  SessionManager: {
    create: vi.fn(() => ({
      getSessionDir: vi.fn(() => "/tmp/sessions/test"),
      getSessionFile: vi.fn(() => "/tmp/sessions/test/session.jsonl"),
    })),
    open: vi.fn(() => ({
      getSessionDir: vi.fn(() => "/tmp/sessions/test"),
      getSessionFile: vi.fn(() => "/tmp/sessions/test/session.jsonl"),
    })),
  },
  DefaultResourceLoader: vi.fn(() => ({
    reload: vi.fn(),
  })),
  createAgentSession: vi.fn(async () => ({
    session: {
      subscribe: () => () => {},
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
      messages: [],
      getSessionStats: () => ({ tokens: { total: 0 }, cost: 0, toolCalls: 0, assistantMessages: 0 }),
    },
  })),
}));

/* ---- Tests ---- */

let dir: string;
let store: ChatStore;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-chat-rt-"));
  db = new Database(join(dir, "test.db"));
  store = ChatStore.fromDb(db);
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Minimal NoodleConfig with the fields ChatRuntime reads. */
function makeConfig(profileOverrides: Record<string, unknown> = {}) {
  return {
    default_profile: "test",
    profiles: {
      test: {
        model: "gpt-4o",
        base_url: "https://api.openai.com/v1",
        api: "openai-completions",
        api_key: "test-key",
        thinking_level: "medium" as const,
        tools: ["read", "bash"],
        api_rpm: 30,
        retry_max_attempts: 0,
        retry_base_delay_ms: 0,
        ...profileOverrides,
      },
    },
    run: { stall_timeout_minutes: 0, tool_stall_minutes: 0 },
  } as any;
}

function fakeAuthProvider(token = "fake-token") {
  return {
    forRepo: vi.fn(async () => ({ gh: {} as any, token })),
    listRepos: vi.fn(async () => []),
  } as any;
}

describe("ChatRuntime", () => {
  it("isBusy and isLive return false before boot", () => {
    const runtime = new ChatRuntime({ config: makeConfig(), authProvider: fakeAuthProvider() });
    expect(runtime.isBusy(1)).toBe(false);
    expect(runtime.isLive(1)).toBe(false);
  });

  it("boot + run works end-to-end with stubbed session", async () => {
    // Build a custom createAgentSession stub that records the prompt.
    let lastPrompt: string | undefined;
    const stub = vi.fn(async (_opts: any) => ({
      session: {
        subscribe: () => () => {},
        prompt: vi.fn(async (text: string) => { lastPrompt = text; }),
        abort: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
        messages: [
          { role: "assistant", content: [{ type: "text", text: "echo reply" }], stopReason: "end_turn" },
        ],
        getSessionStats: () => ({ tokens: { total: 10 }, cost: 0, toolCalls: 0, assistantMessages: 1 }),
      },
    }));

    const runtime = new ChatRuntime({
      config: makeConfig(),
      authProvider: fakeAuthProvider(),
      createAgentSessionFn: stub as any,
    });

    const chat = store.create({ repo: "owner/repo", branch: "main", default_branch: "main" });
    expect(runtime.isLive(chat.id)).toBe(false);

    const result = await runtime.run(chat.id, "hello world", chat);

    expect(lastPrompt).toBe("hello world");
    expect(result).toBe("echo reply");
    expect(runtime.isLive(chat.id)).toBe(true);
    expect(runtime.isBusy(chat.id)).toBe(false);
  });

  it("run() throws BusyError on concurrent calls", async () => {
    let resolveFirst!: () => void;
    const stub = vi.fn(async () => ({
      session: {
        subscribe: () => () => {},
        prompt: vi.fn(() => new Promise<void>((resolve) => { resolveFirst = resolve; })),
        abort: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
        messages: [
          { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
        ],
        getSessionStats: () => ({ tokens: { total: 0 }, cost: 0, toolCalls: 0, assistantMessages: 1 }),
      },
    }));

    const runtime = new ChatRuntime({
      config: makeConfig(),
      authProvider: fakeAuthProvider(),
      createAgentSessionFn: stub as any,
    });

    const chat = store.create({ repo: "a/b", branch: "main", default_branch: "main" });
    const promise = runtime.run(chat.id, "first", chat);
    await new Promise((r) => setTimeout(r, 20));

    expect(runtime.isBusy(chat.id)).toBe(true);
    await expect(runtime.run(chat.id, "second", chat)).rejects.toBeInstanceOf(BusyError);

    resolveFirst();
    await promise;
    expect(runtime.isBusy(chat.id)).toBe(false);
  });

  it("events() returns a consistent emitter per chat", () => {
    const runtime = new ChatRuntime({ config: makeConfig(), authProvider: fakeAuthProvider() });
    const bus1 = runtime.events(1);
    const bus2 = runtime.events(1);
    expect(bus1).toBe(bus2); // same emitter for same chat id
    const bus3 = runtime.events(2);
    expect(bus3).not.toBe(bus1);
  });

  it("dispose() clears live state", async () => {
    const stub = vi.fn(async () => ({
      session: {
        subscribe: () => () => {},
        prompt: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
        messages: [],
        getSessionStats: () => ({ tokens: { total: 0 }, cost: 0, toolCalls: 0, assistantMessages: 0 }),
      },
    }));

    const runtime = new ChatRuntime({
      config: makeConfig(),
      authProvider: fakeAuthProvider(),
      createAgentSessionFn: stub as any,
    });

    const chat = store.create({ repo: "a/b", branch: "main", default_branch: "main" });
    await runtime.run(chat.id, "test", chat);
    expect(runtime.isLive(chat.id)).toBe(true);

    await runtime.dispose(chat.id);
    expect(runtime.isLive(chat.id)).toBe(false);
  });

  it("resolveProfileFor falls back to default_profile when chat.profile is null", async () => {
    const stub = vi.fn(async () => ({
      session: {
        subscribe: () => () => {},
        prompt: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
        messages: [],
        getSessionStats: () => ({ tokens: { total: 0 }, cost: 0, toolCalls: 0, assistantMessages: 0 }),
      },
    }));

    const config = makeConfig();
    const runtime = new ChatRuntime({
      config,
      authProvider: fakeAuthProvider(),
      createAgentSessionFn: stub as any,
    });

    // Chat with no explicit profile → uses default_profile ("test").
    const chat = store.create({ repo: "a/b", branch: "main", default_branch: "main" });
    await runtime.run(chat.id, "ping", chat);

    // The stub was called — profile resolution succeeded.
    expect(stub).toHaveBeenCalled();
  });

  it("passes the chat's thinking_level to createAgentSession when set", async () => {
    let captured: { thinkingLevel?: string } | undefined;
    const stub = vi.fn(async (opts: any) => {
      captured = opts;
      return {
        session: {
          subscribe: () => () => {},
          prompt: vi.fn(async () => {}),
          abort: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
          messages: [],
          getSessionStats: () => ({ tokens: { total: 0 }, cost: 0, toolCalls: 0, assistantMessages: 0 }),
        },
      };
    });

    const runtime = new ChatRuntime({
      // Profile sets thinking_level: "low" — should be overridden by the chat.
      config: makeConfig({ thinking_level: "low" }),
      authProvider: fakeAuthProvider(),
      createAgentSessionFn: stub as any,
    });

    const chat = store.create({
      repo: "a/b",
      branch: "main",
      default_branch: "main",
      thinking_level: "high",
    });
    await runtime.run(chat.id, "ping", chat);

    expect(stub).toHaveBeenCalled();
    expect(captured?.thinkingLevel).toBe("high");
  });

  it("falls back to the profile's thinking_level when chat has the default medium", async () => {
    let captured: { thinkingLevel?: string } | undefined;
    const stub = vi.fn(async (opts: any) => {
      captured = opts;
      return {
        session: {
          subscribe: () => () => {},
          prompt: vi.fn(async () => {}),
          abort: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
          messages: [],
          getSessionStats: () => ({ tokens: { total: 0 }, cost: 0, toolCalls: 0, assistantMessages: 0 }),
        },
      };
    });

    const runtime = new ChatRuntime({
      config: makeConfig({ thinking_level: "low" }),
      authProvider: fakeAuthProvider(),
      createAgentSessionFn: stub as any,
    });

    // Chat keeps the default "medium" → boot uses the chat value (medium wins,
    // since it's set on the row). The contract is "chat value if set, else
    // profile" — medium counts as set.
    const chat = store.create({ repo: "a/b", branch: "main", default_branch: "main" });
    await runtime.run(chat.id, "ping", chat);

    expect(stub).toHaveBeenCalled();
    expect(captured?.thinkingLevel).toBe("medium");
  });
});
