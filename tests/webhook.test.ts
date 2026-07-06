import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifySignature, parseWebhookEvent } from "../src/github/webhook.js";

const SECRET = "supersecret";

/** Sign a body the way GitHub does, for test fixtures. */
function sign(body: string, secret = SECRET): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

const basePayload = {
  action: "opened",
  installation: { id: 42 },
  repository: { full_name: "owner/name" },
  // Body deliberately @-mentions the agent so the opt-in trigger filter
  // (see `parseWebhookEvent`) doesn't drop this payload. Tests that exercise
  // the trigger filter explicitly use payloads without a mention.
  issue: { number: 7, title: "boom", body: "it broke -- @noodle can you look?", labels: [] },
};

describe("verifySignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify(basePayload);
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a body signed with the wrong secret", () => {
    const body = JSON.stringify(basePayload);
    expect(verifySignature(body, sign(body, "wrong"), SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify(basePayload);
    const sig = sign(body);
    expect(verifySignature(body + "tampered", sig, SECRET)).toBe(false);
  });

  it("rejects a missing or malformed signature header", () => {
    const body = JSON.stringify(basePayload);
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, "sha1=abc", SECRET)).toBe(false);
  });
});

describe("parseWebhookEvent", () => {
  it("parses issues.opened", () => {
    expect(parseWebhookEvent("issues", basePayload)).toEqual({
      kind: "issue",
      repo: "owner/name",
      issueNumber: 7,
      installationId: 42,
    });
  });

  it("parses issues.reopened", () => {
    expect(parseWebhookEvent("issues", { ...basePayload, action: "reopened" })?.kind).toBe("issue");
  });

  it("parses issues.labeled", () => {
    expect(parseWebhookEvent("issues", { ...basePayload, action: "labeled" })?.kind).toBe("issue");
  });

  it("ignores closed/edited/other issue actions", () => {
    expect(parseWebhookEvent("issues", { ...basePayload, action: "closed" })).toBeNull();
    expect(parseWebhookEvent("issues", { ...basePayload, action: "edited" })).toBeNull();
  });

  it("drops issues.opened when the body carries no @-mention (opt-in default)", () => {
    // New default: agent only wakes on mention / keyword / slash. A bare
    // "it broke" should NOT fire. (No mention, no slash, no configured
    // keywords, no `trigger_on_open`.)
    const payload = {
      ...basePayload,
      issue: { number: 8, body: "plain bug report, no mention" },
    };
    expect(parseWebhookEvent("issues", payload)).toBeNull();
  });

  it("fires when trigger_on_open is configured (legacy always-fire mode)", () => {
    // Power users who don't want the opt-in filter can flip the escape hatch.
    const payload = {
      ...basePayload,
      issue: { number: 9, body: "plain issue, no mention" },
    };
    expect(
      parseWebhookEvent("issues", payload, undefined, "Noodle", {
        trigger_on_mention: false,
        trigger_keywords: [],
        trigger_on_open: true,
      })?.kind,
    ).toBe("issue");
  });

  it("fires when a configured trigger_keyword is present in the body", () => {
    const payload = {
      ...basePayload,
      issue: { number: 10, body: "agent-fix: please look at this" },
    };
    expect(
      parseWebhookEvent("issues", payload, undefined, "Noodle", {
        trigger_on_mention: true,
        trigger_keywords: ["agent-fix"],
        trigger_on_open: false,
      })?.kind,
    ).toBe("issue");
  });

  it("ignores keyword match when trigger_keywords is empty (default)", () => {
    const payload = {
      ...basePayload,
      issue: { number: 11, body: "agent-fix" },
    };
    expect(parseWebhookEvent("issues", payload)).toBeNull();
  });

  it("fires on issues.assigned when assigned to Noodle (selfLogin match, case-insensitive)", () => {
    const payload = { ...basePayload, action: "assigned", assignee: { login: "noodle-bot" } };
    expect(parseWebhookEvent("issues", payload, "noodle-bot")?.kind).toBe("issue");
    // login comparison is case-insensitive
    expect(parseWebhookEvent("issues", payload, "NOODLE-BOT")?.kind).toBe("issue");
  });

  it("ignores issues.assigned when assigned to someone else", () => {
    const payload = { ...basePayload, action: "assigned", assignee: { login: "some-human" } };
    expect(parseWebhookEvent("issues", payload, "noodle-bot")).toBeNull();
  });

  it("ignores issues.assigned when selfLogin is not provided", () => {
    const payload = { ...basePayload, action: "assigned", assignee: { login: "noodle-bot" } };
    expect(parseWebhookEvent("issues", payload)).toBeNull();
    expect(parseWebhookEvent("issues", payload, undefined)).toBeNull();
  });

  it("ignores issues.assigned when assignee login is missing", () => {
    const payload = { ...basePayload, action: "assigned", assignee: null };
    expect(parseWebhookEvent("issues", payload, "noodle-bot")).toBeNull();
  });

  it("parses issue_comment.created starting with /noodle", () => {
    const payload = {
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "owner/name" },
      issue: { number: 7 },
      comment: { body: "/noodle please fix this" },
    };
    expect(parseWebhookEvent("issue_comment", payload)).toEqual({
      kind: "comment",
      repo: "owner/name",
      issueNumber: 7,
      installationId: 42,
    });
  });

  it("ignores comments that don't start with /noodle", () => {
    const payload = {
      action: "created",
      repository: { full_name: "owner/name" },
      issue: { number: 7 },
      comment: { body: "just chatting here" },
    };
    expect(parseWebhookEvent("issue_comment", payload)).toBeNull();
  });

  it("ignores issue_comment on a pull request", () => {
    const payload = {
      action: "created",
      repository: { full_name: "owner/name" },
      issue: { number: 7, pull_request: {} },
      comment: { body: "/noodle go" },
    };
    expect(parseWebhookEvent("issue_comment", payload)).toBeNull();
  });

  it("fires on issue_comment.created when comment @-mentions the agent", () => {
    // `@noodle can you look?` is now an explicit wake signal too — the
    // user might invite the agent in a regular comment instead of using
    // the slash command.
    const payload = {
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "owner/name" },
      issue: { number: 7 },
      comment: { body: "@noodle can you look at this?" },
    };
    expect(parseWebhookEvent("issue_comment", payload)).toEqual({
      kind: "comment",
      repo: "owner/name",
      issueNumber: 7,
      installationId: 42,
    });
  });

  it("returns null for ping and unrelated events", () => {
    expect(parseWebhookEvent("ping", { zen: "hello" })).toBeNull();
    expect(parseWebhookEvent("push", { ...basePayload })).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseWebhookEvent("issues", { action: "opened", repository: {} })).toBeNull();
    expect(
      parseWebhookEvent("issues", { action: "opened", repository: { full_name: "owner/name" } }),
    ).toBeNull();
  });

  it("parses custom agent name slash command", () => {
    const payload = {
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "owner/name" },
      issue: { number: 7 },
      comment: { body: "/mybot please fix this" },
    };
    expect(parseWebhookEvent("issue_comment", payload, undefined, "MyBot")).toEqual({
      kind: "comment",
      repo: "owner/name",
      issueNumber: 7,
      installationId: 42,
    });
  });

  it("ignores /noodle when agent name is customised", () => {
    const payload = {
      action: "created",
      repository: { full_name: "owner/name" },
      issue: { number: 7 },
      comment: { body: "/noodle go" },
    };
    expect(parseWebhookEvent("issue_comment", payload, undefined, "MyBot")).toBeNull();
  });
});
