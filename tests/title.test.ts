import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { templateTitle, phraseOutput, generateIssueTitle } from "../src/engine/title.js";
import { NoodleConfigSchema, type Profile } from "../src/config/schema.js";

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
  profiles: { p: { provider: "openai", model: "gpt-4o-mini", base_url: "https://api.openai.com/v1", api: "openai-completions", api_key: "sk-test" } },
  routing: [],
});
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
      profile,
    );
    expect(result).toBe("## Cleaned\n\nThe fix is in `src/x.ts`.");
  });

  it("falls back to the raw agent message when the relay is down (non-ok)", async () => {
    const raw = "The fix is in src/x.ts.";
    globalThis.fetch = mockFetchResponse("", false, 503) as never;
    const result = await phraseOutput(raw, profile);
    expect(result).toBe(raw);
  });

  it("falls back to the raw agent message when the relay returns empty", async () => {
    const raw = "The fix is in src/x.ts.";
    globalThis.fetch = mockFetchResponse("   ") as never;
    const result = await phraseOutput(raw, profile);
    expect(result).toBe(raw);
  });

  it("falls back when fetch throws (relay unreachable)", async () => {
    const raw = "The fix is in src/x.ts.";
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as never;
    const result = await phraseOutput(raw, profile);
    expect(result).toBe(raw);
  });

  it("returns the input unchanged when the agent message is empty", async () => {
    globalThis.fetch = mockFetchResponse("should not be called") as never;
    const result = await phraseOutput("   ", profile);
    expect(result).toBe("");
  });

  // --- auth header (regression for relay 401 "Authorization Not Found") ---
  //
  // The relay is a transparent dumb pipe: it forwards the caller's headers
  // verbatim and never synthesizes auth. phraseOutput / generateIssueTitle
  // bypass the SDK and fetch the relay directly, so they MUST attach the
  // Bearer header themselves from profile.api_key — else the relay forwards
  // an unauthenticated request and the upstream returns 401.
  it("attaches Authorization: Bearer from profile.api_key on phrasing calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "cleaned" } }] }),
      text: async () => "",
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;
    await phraseOutput("raw agent message", profile);
    const [, init] = fetchMock.mock.calls[0];
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${profile.api_key}`);
  });

  it("omits Authorization when the profile has no api_key (no-auth endpoint)", async () => {
    const noKeyProfile: Profile = { ...profile, api_key: "" };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "cleaned" } }] }),
      text: async () => "",
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;
    await phraseOutput("raw agent message", noKeyProfile);
    const [, init] = fetchMock.mock.calls[0];
    expect((init!.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("generateIssueTitle", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it("attaches Authorization: Bearer from profile.api_key on title calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "Some finding" } }] }),
      text: async () => "",
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;
    await generateIssueTitle("findings text", "the task", profile);
    const [, init] = fetchMock.mock.calls[0];
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${profile.api_key}`);
  });
});
