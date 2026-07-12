import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifySignature, parseWebhookEvent } from "../src/github/webhook.js";
import type { TriggerConfig } from "../src/triggers/check.js";

const SECRET = "supersecret";

/** Sign a body the way GitHub does, for test fixtures. */
function sign(body: string, secret = SECRET): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/** Opt-in triggers: mention-only (the new default). */
const optIn: TriggerConfig = { trigger_on_mention: true, trigger_keywords: [], trigger_on_open: false };
/** Legacy triggers: fire on every issue regardless of body. */
const openAll: TriggerConfig = { trigger_on_mention: false, trigger_keywords: [], trigger_on_open: true };

/** Payload whose body @-mentions the agent — passes the opt-in wake filter. */
const basePayload = {
  action: "opened",
  installation: { id: 42 },
  repository: { full_name: "owner/name" },
  issue: { number: 7, title: "boom", body: "@noodle it broke", labels: [] },
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

  // --- opt-in wake filter (issues.* body gate) ---------------------------
  it("ignores a bare issue body under opt-in (no wake signal)", () => {
    const payload = { ...basePayload, issue: { number: 7, body: "it just broke", labels: [] } };
    expect(parseWebhookEvent("issues", payload, undefined, "Noodle", optIn)).toBeNull();
  });

  it("fires on a @mention in the body under opt-in", () => {
    const payload = { ...basePayload, issue: { number: 7, body: "@noodle please fix", labels: [] } };
    expect(parseWebhookEvent("issues", payload, undefined, "Noodle", optIn)?.kind).toBe("issue");
  });

  it("fires on a trigger_keyword in the body under opt-in", () => {
    const payload = { ...basePayload, issue: { number: 7, body: "this is agent-fix work", labels: [] } };
    const kw: TriggerConfig = { trigger_on_mention: true, trigger_keywords: ["agent-fix"], trigger_on_open: false };
    expect(parseWebhookEvent("issues", payload, undefined, "Noodle", kw)?.kind).toBe("issue");
  });

  it("fires on a #profile tag in the body under opt-in", () => {
    const payload = { ...basePayload, issue: { number: 7, body: "#claude fix the build", labels: [] } };
    expect(parseWebhookEvent("issues", payload, undefined, "Noodle", optIn, ["claude"])?.kind).toBe("issue");
  });

  it("fires on every issue under trigger_on_open (legacy mode)", () => {
    const payload = { ...basePayload, issue: { number: 7, body: "it just broke", labels: [] } };
    expect(parseWebhookEvent("issues", payload, undefined, "Noodle", openAll)?.kind).toBe("issue");
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

  it("wakes on a @noodle mention in a comment", () => {
    const payload = {
      action: "created",
      repository: { full_name: "owner/name" },
      issue: { number: 7 },
      comment: { body: "@noodle can you look at this?" },
    };
    expect(parseWebhookEvent("issue_comment", payload)?.kind).toBe("comment");
  });

  it("wakes on a #profile tag in a comment", () => {
    const payload = {
      action: "created",
      repository: { full_name: "owner/name" },
      issue: { number: 7 },
      comment: { body: "#claude rerun with claude" },
    };
    const intent = parseWebhookEvent("issue_comment", payload, undefined, "Noodle", optIn, ["claude"]);
    expect(intent?.kind).toBe("comment");
    expect(intent?.profileHint).toBe("claude");
  });

  it("carries the #profile hint on an issues.opened event", () => {
    const payload = {
      ...basePayload,
      action: "opened",
      issue: { number: 9, body: "#nim take this", labels: [] },
    };
    const intent = parseWebhookEvent("issues", payload, undefined, "Noodle", optIn, ["nim"]);
    expect(intent?.kind).toBe("issue");
    expect(intent?.profileHint).toBe("nim");
  });

  it("ignores a #profile tag that names no configured profile", () => {
    const payload = {
      action: "created",
      repository: { full_name: "owner/name" },
      issue: { number: 7 },
      comment: { body: "#unknown fix this" },
    };
    expect(parseWebhookEvent("issue_comment", payload, undefined, "Noodle", optIn, ["claude"])).toBeNull();
  });

  it("ignores comments that don't wake the agent", () => {
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

  it("wakes on any active command trigger (not just the agent slug)", () => {
    const payload = {
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "owner/name" },
      issue: { number: 7 },
      comment: { body: "/review please look at this" },
    };
    // No commandTriggers → /review does NOT wake (back-compat).
    expect(parseWebhookEvent("issue_comment", payload, undefined, "Noodle", optIn)).toBeNull();
    // With "review" as an active command trigger → wakes.
    expect(
      parseWebhookEvent("issue_comment", payload, undefined, "Noodle", optIn, [], ["review"]),
    ).toEqual({
      kind: "comment",
      repo: "owner/name",
      issueNumber: 7,
      installationId: 42,
    });
  });

  it("still wakes on /noodle even when commandTriggers is empty (slug backstop)", () => {
    const payload = {
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "owner/name" },
      issue: { number: 7 },
      comment: { body: "/noodle fix this" },
    };
    expect(parseWebhookEvent("issue_comment", payload, undefined, "Noodle", optIn)).toEqual({
      kind: "comment",
      repo: "owner/name",
      issueNumber: 7,
      installationId: 42,
    });
  });
});
