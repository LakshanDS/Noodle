import { describe, it, expect } from "vitest";
import {
  mentionsAgent,
  extractProfileTag,
  shouldTrigger,
  type TriggerConfig,
} from "../src/triggers/check.js";

const optIn: TriggerConfig = { trigger_on_mention: true, trigger_keywords: [], trigger_on_open: false };
const openAll: TriggerConfig = { trigger_on_mention: false, trigger_keywords: [], trigger_on_open: true };

describe("mentionsAgent", () => {
  it("matches the bare agent name", () => {
    expect(mentionsAgent("@noodle fix this", "Noodle")).toBe(true);
    expect(mentionsAgent("@Noodle", "Noodle")).toBe(true);
  });

  it("matches bot-login variants (slug-agent, slug_bot)", () => {
    expect(mentionsAgent("@noodle-agent hey", "Noodle")).toBe(true);
    expect(mentionsAgent("@noodle_agent hey", "Noodle")).toBe(true);
    expect(mentionsAgent("@noodle[bot] hey", "Noodle")).toBe(true);
  });

  it("does NOT match embedded mentions (email@noodle)", () => {
    expect(mentionsAgent("email@noodle.example.com", "Noodle")).toBe(false);
  });

  it("does NOT match a pluralized name (@noodles)", () => {
    expect(mentionsAgent("@noodles are great", "Noodle")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(mentionsAgent("hey @NOODLE-AGENT", "Noodle")).toBe(true);
  });

  it("returns false on empty text", () => {
    expect(mentionsAgent("", "Noodle")).toBe(false);
  });
});

describe("extractProfileTag", () => {
  const profiles = ["claude", "nim", "cheap"];

  it("matches a configured #profile at start of line", () => {
    expect(extractProfileTag("#claude fix this", profiles)).toBe("claude");
  });

  it("matches a #profile after whitespace", () => {
    expect(extractProfileTag("please #nim take a look", profiles)).toBe("nim");
  });

  it("is case-insensitive on the profile name", () => {
    expect(extractProfileTag("#Claude please", profiles)).toBe("claude");
  });

  it("does NOT match #123 issue references", () => {
    expect(extractProfileTag("see #123 for context", profiles)).toBeNull();
  });

  it("does NOT match a non-configured #word", () => {
    expect(extractProfileTag("#unknown thing", profiles)).toBeNull();
  });

  it("does NOT match code#foo (no whitespace boundary)", () => {
    expect(extractProfileTag("code#claude", profiles)).toBeNull();
  });

  it("returns the first configured profile when several appear", () => {
    // Configured order is [claude, nim, cheap]; claude appears first in config
    // and is the one scanned first, but the text has nim first — we return the
    // first match found scanning text left-to-right per profile-name loop.
    // Implementation scans profile-by-profile, so claude (checked first in the
    // profile list) wins even if nim appears earlier in text.
    expect(extractProfileTag("use #nim then #claude", profiles)).toBe("claude");
  });

  it("returns null with no profiles configured", () => {
    expect(extractProfileTag("#claude fix", [])).toBeNull();
  });
});

describe("shouldTrigger", () => {
  it("does not wake on a bare issue body (opt-in default)", () => {
    const r = shouldTrigger({
      body: "Something is broken in the login flow.",
      comments: [],
      agentName: "Noodle",
      triggers: optIn,
    });
    expect(r.wake).toBe(false);
    expect(r.profile).toBeNull();
  });

  it("wakes on @mention", () => {
    const r = shouldTrigger({
      body: "@noodle can you look at this?",
      comments: [],
      agentName: "Noodle",
      triggers: optIn,
    });
    expect(r.wake).toBe(true);
  });

  it("wakes on /<agent> slash command", () => {
    const r = shouldTrigger({
      body: "/noodle please fix",
      comments: [],
      agentName: "Noodle",
      triggers: optIn,
    });
    expect(r.wake).toBe(true);
  });

  it("wakes on a configured trigger keyword", () => {
    const r = shouldTrigger({
      body: "this is agent-fix territory",
      comments: [],
      agentName: "Noodle",
      triggers: { trigger_on_mention: true, trigger_keywords: ["agent-fix"], trigger_on_open: false },
    });
    expect(r.wake).toBe(true);
  });

  it("wakes on trigger_on_open regardless of body", () => {
    const r = shouldTrigger({
      body: "just a plain issue",
      comments: [],
      agentName: "Noodle",
      triggers: openAll,
    });
    expect(r.wake).toBe(true);
  });

  it("wakes on a #profile tag even when mention is off", () => {
    const r = shouldTrigger({
      body: "#claude fix the build",
      comments: [],
      agentName: "Noodle",
      triggers: { trigger_on_mention: false, trigger_keywords: [], trigger_on_open: false },
      profileNames: ["claude"],
    });
    expect(r.wake).toBe(true);
    expect(r.profile).toBe("claude");
  });

  it("extracts a #profile from a comment, not just the body", () => {
    const r = shouldTrigger({
      body: "the build is red",
      comments: ["#nim rerun with nim"],
      agentName: "Noodle",
      triggers: optIn,
      profileNames: ["nim"],
    });
    expect(r.wake).toBe(true);
    expect(r.profile).toBe("nim");
  });

  it("does not set profile when the #tag names no configured profile", () => {
    const r = shouldTrigger({
      body: "#unknown fix this",
      comments: [],
      agentName: "Noodle",
      triggers: optIn,
      profileNames: ["claude"],
    });
    // #unknown is not a configured profile → not a wake, no profile selected.
    expect(r.wake).toBe(false);
    expect(r.profile).toBeNull();
  });

  it("wakes on a mention in a comment", () => {
    const r = shouldTrigger({
      body: "plain body",
      comments: ["@noodle-agent take this one"],
      agentName: "Noodle",
      triggers: optIn,
    });
    expect(r.wake).toBe(true);
  });
});
