import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { templateTitle } from "../src/engine/title.js";
import type { Model, Api } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

// --- mocks ----------------------------------------------------------------
//
// phraseOutput / generateIssueTitle now call pi-ai's completeSimple with the
// run's resolved model + registry (inheriting the agent's profile/key/base_url/
// protocol), instead of hand-rolling a fetch to the relay. So the tests mock
// completeSimple directly — both the success shape (text content) and the
// failure modes (throw / empty / error stopReason) that must fall back.
//
// Auth resolution goes through modelRegistry.getApiKeyAndHeaders(model); we stub
// the registry to return ok+test key so the calls reach completeSimple.

const TEST_API_KEY = "sk-test-key";

/** A minimal Model shape — only id/provider/api/baseUrl are read by title.ts. */
function mockModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test-model",
    provider: "test-provider",
    api: "openai-completions",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
    ...overrides,
  } as unknown as Model<Api>;
}

function mockRegistry(): ModelRegistry {
  return {
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: TEST_API_KEY }),
  } as unknown as ModelRegistry;
}

/** Mock the completeSimple export from pi-ai/compat. */
vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
  return {
    ...actual,
    completeSimple: vi.fn(),
  };
});

// Import AFTER the mock is registered so title.ts picks up the mocked binding.
const { phraseOutput, generateIssueTitle } = await import("../src/engine/title.js");
const { completeSimple } = await import("@earendil-works/pi-ai/compat");
const mockedCompleteSimple = vi.mocked(completeSimple);

/** Build a fake AssistantMessage carrying the given text. */
function fakeAssistant(text: string, stopReason: "stop" | "error" = "stop", errorMessage?: string) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {},
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

describe("templateTitle (fallback)", () => {
  it("uses the first non-empty line of the task, capped to 80 chars", () => {
    expect(templateTitle("Find bugs and open issues.")).toBe("Find bugs and open issues.");
  });

  it("skips leading blank lines", () => {
    expect(templateTitle("\n\n  \nFind bugs.")).toBe("Find bugs.");
  });

  it("truncates a long first line with an ellipsis on a word boundary", () => {
    const long = "Check if the logs still use cron=true when logging to the console during scheduled runs are running";
    const title = templateTitle(long);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back to a generic title when the task is blank", () => {
    expect(templateTitle("   ")).toBe("scheduled sweep");
    expect(templateTitle("")).toBe("scheduled sweep");
  });
});

describe("phraseOutput", () => {
  beforeEach(() => mockedCompleteSimple.mockReset());
  afterEach(() => vi.useRealTimers());

  const ctx = { model: mockModel(), modelRegistry: mockRegistry() };

  it("returns the model's cleaned message on success", async () => {
    mockedCompleteSimple.mockResolvedValue(fakeAssistant("## Cleaned\n\nThe fix is in `src/x.ts`.") as never);
    const result = await phraseOutput("Let me check... The fix is in src/x.ts.", ctx);
    expect(result).toBe("## Cleaned\n\nThe fix is in `src/x.ts`.");
  });

  it("falls back to the raw agent message when the model returns empty", async () => {
    const raw = "The fix is in src/x.ts.";
    mockedCompleteSimple.mockResolvedValue(fakeAssistant("   ") as never);
    const result = await phraseOutput(raw, ctx);
    expect(result).toBe(raw);
  });

  it("falls back to the raw agent message when completeSimple throws", async () => {
    const raw = "The fix is in src/x.ts.";
    mockedCompleteSimple.mockRejectedValueOnce(new Error("ECONNREFUSED") as never);
    const result = await phraseOutput(raw, ctx);
    expect(result).toBe(raw);
  });

  it("falls back when the model returns an error stopReason", async () => {
    const raw = "The fix is in src/x.ts.";
    mockedCompleteSimple.mockResolvedValue(fakeAssistant("", "error", "upstream 500") as never);
    const result = await phraseOutput(raw, ctx);
    expect(result).toBe(raw);
  });

  it("returns the input unchanged when the agent message is empty", async () => {
    mockedCompleteSimple.mockResolvedValue(fakeAssistant("should not be called") as never);
    const result = await phraseOutput("   ", ctx);
    expect(result).toBe("");
    expect(mockedCompleteSimple).not.toHaveBeenCalled();
  });

  it("falls back when auth resolution fails", async () => {
    const raw = "The fix is in src/x.ts.";
    const badCtx = {
      model: mockModel(),
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) } as never,
    };
    const result = await phraseOutput(raw, badCtx);
    expect(result).toBe(raw);
    expect(mockedCompleteSimple).not.toHaveBeenCalled();
  });
});

describe("generateIssueTitle", () => {
  beforeEach(() => mockedCompleteSimple.mockReset());
  afterEach(() => vi.useRealTimers());

  const ctx = { model: mockModel(), modelRegistry: mockRegistry() };

  it("returns the cleaned title on success", async () => {
    mockedCompleteSimple.mockResolvedValue(fakeAssistant("DB connection pool leak on response destroy") as never);
    const title = await generateIssueTitle("findings...", "the task", ctx);
    expect(title).toBe("DB connection pool leak on response destroy");
  });

  it("strips a leading 'Bug:' prefix the model sometimes adds", async () => {
    mockedCompleteSimple.mockResolvedValue(fakeAssistant("Bug: pool leak under disconnects") as never);
    const title = await generateIssueTitle("findings...", "the task", ctx);
    expect(title).toBe("pool leak under disconnects");
  });

  it("falls back to template when the model returns empty", async () => {
    mockedCompleteSimple.mockResolvedValue(fakeAssistant("   ") as never);
    const title = await generateIssueTitle("findings...", "Find bugs and open issues.", ctx);
    expect(title).toBe("Find bugs and open issues.");
  });

  it("falls back to template when completeSimple throws", async () => {
    mockedCompleteSimple.mockRejectedValueOnce(new Error("upstream 503") as never);
    const title = await generateIssueTitle("findings...", "Find bugs.", ctx);
    expect(title).toBe("Find bugs.");
  });

  it("falls back to template when auth resolution fails", async () => {
    const badCtx = {
      model: mockModel(),
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) } as never,
    };
    const title = await generateIssueTitle("findings...", "Find bugs.", badCtx);
    expect(title).toBe("Find bugs.");
  });
});
