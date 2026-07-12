import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { templateTitle, phraseOutput } from "../src/engine/title.js";
import { NoodleConfigSchema, type NoodleConfig, type Profile } from "../src/config/schema.js";

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

// --- phraseOutput tests ----------------------------------------------------

const config = NoodleConfigSchema.parse({
  agent_name: "TestBot",
  default_profile: "p",
  profiles: { p: { provider: "openai", model: "gpt-4o-mini" } },
  routing: [],
}) as NoodleConfig;
const profile: Profile = config.profiles.p;

/** Minimal fetch mock returning a relay-style chat completion response. */
function mockFetchResponse(content: string, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "relay error body",
  });
}

describe("phraseOutput", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it("returns the relay's cleaned message on success", async () => {
    globalThis.fetch = mockFetchResponse("## Cleaned\n\nThe fix is in `src/x.ts`.") as never;
    const result = await phraseOutput(
      "Let me check... running grep... The fix is in src/x.ts.",
      config,
      profile,
    );
    expect(result).toBe("## Cleaned\n\nThe fix is in `src/x.ts`.");
  });

  it("falls back to the raw agent message when the relay is down (non-ok)", async () => {
    const raw = "The fix is in src/x.ts.";
    globalThis.fetch = mockFetchResponse("", false, 503) as never;
    const result = await phraseOutput(raw, config, profile);
    expect(result).toBe(raw);
  });

  it("falls back to the raw agent message when the relay returns empty", async () => {
    const raw = "The fix is in src/x.ts.";
    globalThis.fetch = mockFetchResponse("   ") as never;
    const result = await phraseOutput(raw, config, profile);
    expect(result).toBe(raw);
  });

  it("falls back when fetch throws (relay unreachable)", async () => {
    const raw = "The fix is in src/x.ts.";
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as never;
    const result = await phraseOutput(raw, config, profile);
    expect(result).toBe(raw);
  });

  it("returns the input unchanged when the agent message is empty", async () => {
    globalThis.fetch = mockFetchResponse("should not be called") as never;
    const result = await phraseOutput("   ", config, profile);
    expect(result).toBe("");
  });
});
