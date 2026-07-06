import { describe, it, expect } from "vitest";
import {
  mentionsAgent,
  shouldTrigger,
  type TriggerConfig,
} from "../src/triggers/check.js";

const strict: TriggerConfig = {
  trigger_on_mention: true,
  trigger_keywords: [],
  trigger_on_open: false,
};
const keyword: TriggerConfig = {
  trigger_on_mention: true,
  trigger_keywords: ["agent-fix"],
  trigger_on_open: false,
};
const legacy: TriggerConfig = {
  trigger_on_mention: false,
  trigger_keywords: [],
  trigger_on_open: true,
};

describe("mentionsAgent", () => {
  it("matches the agent name as-given", () => {
    expect(mentionsAgent("hi @Noodle can you look?", "Noodle")).toBe(true);
    expect(mentionsAgent("hi @noodle can you look?", "Noodle")).toBe(true);
  });

  it("matches the slugged form", () => {
    expect(mentionsAgent("ping @my-bot please", "My Bot")).toBe(true);
  });

  it("matches bot-login variants @noodle-agent / @noodle_agent", () => {
    expect(mentionsAgent("cc @noodle-agent", "Noodle")).toBe(true);
    expect(mentionsAgent("cc @noodle_agent", "Noodle")).toBe(true);
    expect(mentionsAgent("cc @Noodle-Agent", "Noodle")).toBe(true);
  });

  it("does NOT match when not an explicit @-mention", () => {
    expect(mentionsAgent("just a noodle soup recipe", "Noodle")).toBe(false);
    expect(mentionsAgent("noodles are tasty", "Noodle")).toBe(false);
  });

  it("does NOT match embedded @ signs mid-word (e.g. user@host)", () => {
    // user@host should not count as a mention of "host".
    expect(mentionsAgent("contact user@noodle.example.com", "Noodle")).toBe(false);
  });

  it("does NOT match when agentName is empty / blank", () => {
    expect(mentionsAgent("@noodle hey", "")).toBe(false);
    expect(mentionsAgent("@noodle hey", "   ")).toBe(false);
  });
});

describe("shouldTrigger", () => {
  it("returns false on an empty thread (no body, no comments)", () => {
    expect(
      shouldTrigger({ agentName: "Noodle", body: "", comments: [], triggers: strict }),
    ).toBe(false);
  });

  it("requires a mention under the strict default", () => {
    expect(
      shouldTrigger({
        agentName: "Noodle",
        body: "plain bug report",
        comments: ["any thread"],
        triggers: strict,
      }),
    ).toBe(false);
  });

  it("fires on @-mention in body", () => {
    expect(
      shouldTrigger({
        agentName: "Noodle",
        body: "hi @Noodle",
        comments: [],
        triggers: strict,
      }),
    ).toBe(true);
  });

  it("fires on @-mention in a comment", () => {
    expect(
      shouldTrigger({
        agentName: "Noodle",
        body: "no mention here",
        comments: ["@noodle-fix please look"],
        triggers: strict,
      }),
    ).toBe(true);
  });

  it("fires on a configured trigger_keyword in body", () => {
    expect(
      shouldTrigger({
        agentName: "Noodle",
        body: "agent-fix: please review",
        comments: [],
        triggers: keyword,
      }),
    ).toBe(true);
  });

  it("fires on a configured trigger_keyword in a comment", () => {
    expect(
      shouldTrigger({
        agentName: "Noodle",
        body: "no mention",
        comments: ["[agent-fix] flagged"],
        triggers: keyword,
      }),
    ).toBe(true);
  });

  it("fires on the slash command regardless of mention/keyword filters", () => {
    // Slash commands are always-on wake signals (matches `issue_comment`
    // webhook layer semantics).
    expect(
      shouldTrigger({
        agentName: "Noodle",
        body: "/noodle please fix",
        comments: [],
        triggers: {
          trigger_on_mention: false,
          trigger_keywords: [],
          trigger_on_open: false,
        },
      }),
    ).toBe(true);
    expect(
      shouldTrigger({
        agentName: "Noodle",
        body: "no slash here",
        comments: ["/noodle and clean up too"],
        triggers: {
          trigger_on_mention: false,
          trigger_keywords: [],
          trigger_on_open: false,
        },
      }),
    ).toBe(true);
  });

  it("slash command is word-boundary so /noodles does NOT match", () => {
    expect(
      shouldTrigger({
        agentName: "Noodle",
        body: "I love /noodles",
        comments: [],
        triggers: {
          trigger_on_mention: false,
          trigger_keywords: [],
          trigger_on_open: false,
        },
      }),
    ).toBe(false);
  });

  it("honors trigger_on_open legacy mode (fires on everything)", () => {
    expect(
      shouldTrigger({
        agentName: "Noodle",
        body: "plain",
        comments: [],
        triggers: legacy,
      }),
    ).toBe(true);
  });

  it("keyword comparison is case-insensitive", () => {
    expect(
      shouldTrigger({
        agentName: "Noodle",
        body: "AGENT-FIX: please check",
        comments: [],
        triggers: keyword,
      }),
    ).toBe(true);
  });
});
