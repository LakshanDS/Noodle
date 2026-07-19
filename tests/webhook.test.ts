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

  it("does NOT wake on @mention in a comment when trigger_on_mention is off", () => {
    const payload = {
      action: "created",
      repository: { full_name: "owner/name" },
      issue: { number: 7 },
      comment: { body: "@noodle can you look at this?" },
    };
    const noMention: TriggerConfig = { trigger_on_mention: false, trigger_keywords: [], trigger_on_open: false };
    expect(parseWebhookEvent("issue_comment", payload, undefined, "Noodle", noMention)).toBeNull();
  });

  it("still wakes on /command in a comment when trigger_on_mention is off", () => {
    const payload = {
      action: "created",
      repository: { full_name: "owner/name" },
      issue: { number: 7 },
      comment: { body: "/noodle-fix fix the login bug" },
    };
    const noMention: TriggerConfig = { trigger_on_mention: false, trigger_keywords: [], trigger_on_open: false };
    expect(parseWebhookEvent("issue_comment", payload, undefined, "Noodle", noMention, [], ["noodle-fix"])?.kind).toBe("comment");
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

  it("wakes on issue_comment on a pull request (slash command)", () => {
    // PR comments route through the issue_comment surface. A `/<command>` on a
    // PR wakes the agent — runJob detects PR mode and clones the PR's branch.
    const payload = {
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "owner/name" },
      issue: { number: 7, pull_request: {} },
      comment: { body: "/noodle change line 302 to rename the string" },
    };
    expect(parseWebhookEvent("issue_comment", payload, undefined, "Noodle")).toEqual({
      kind: "comment",
      repo: "owner/name",
      issueNumber: 7,
      installationId: 42,
    });
  });

  it("wakes on issue_comment on a pull request (mention)", () => {
    const payload = {
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "owner/name" },
      issue: { number: 7, pull_request: {} },
      comment: { body: "@noodle can you fix the tests?" },
    };
    expect(parseWebhookEvent("issue_comment", payload, undefined, "Noodle")).toEqual({
      kind: "comment",
      repo: "owner/name",
      issueNumber: 7,
      installationId: 42,
    });
  });

  it("ignores issue_comment on a pull request without a wake signal", () => {
    const payload = {
      action: "created",
      repository: { full_name: "owner/name" },
      issue: { number: 7, pull_request: {} },
      comment: { body: "just reviewing, looks good" },
    };
    expect(parseWebhookEvent("issue_comment", payload)).toBeNull();
  });

  it("ignores issues.* lifecycle events on a pull request", () => {
    // issue_comment wakes on PRs, but issues.opened/reopened/labeled/assigned
    // are issue-only — Noodle doesn't trigger on PR lifecycle events.
    for (const action of ["opened", "reopened", "labeled", "assigned"]) {
      const payload = {
        action,
        repository: { full_name: "owner/name" },
        issue: { number: 7, pull_request: {}, body: "@noodle please", labels: [] },
        assignee: { login: "noodle-agent" },
      };
      expect(parseWebhookEvent("issues", payload, "noodle-agent", "Noodle")).toBeNull();
    }
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

  // --- self-event suppression (re-entrant trigger guard) -----------------
  // The bot's OWN comments and label swaps must never wake it again — the
  // answer comment can carry @noodle / #profile / /command in its text, and
  // label swaps (cooking→cooked) shouldn't re-fire under trigger_on_open.
  // Other self-originated events (issues.opened/reopened) are NOT suppressed:
  // that's how cron/trigger runs open new issues that chain into another run.
  describe("self-event suppression", () => {
    it("suppresses the bot's own @mention comment", () => {
      const payload = {
        action: "created",
        installation: { id: 42 },
        repository: { full_name: "owner/name" },
        issue: { number: 7 },
        comment: { body: "@noodle can you also look at X?" },
        sender: { login: "noodle[bot]" },
      };
      // Without selfLogin the guard is inert (matches historical behaviour).
      expect(parseWebhookEvent("issue_comment", payload, undefined, "Noodle")).not.toBeNull();
      // With the App-mode selfLogin it's suppressed.
      expect(parseWebhookEvent("issue_comment", payload, "noodle[bot]", "Noodle")).toBeNull();
    });

    it("suppresses the bot's own /noodle command comment", () => {
      const payload = {
        action: "created",
        repository: { full_name: "owner/name" },
        issue: { number: 7 },
        comment: { body: "/noodle rerun this" },
        sender: { login: "noodle[bot]" },
      };
      expect(parseWebhookEvent("issue_comment", payload, "noodle[bot]", "Noodle")).toBeNull();
    });

    it("suppresses the bot's own #profile tag comment", () => {
      const payload = {
        action: "created",
        repository: { full_name: "owner/name" },
        issue: { number: 7 },
        comment: { body: "#claude rerun with claude" },
        sender: { login: "noodle[bot]" },
      };
      expect(
        parseWebhookEvent("issue_comment", payload, "noodle[bot]", "Noodle", optIn, ["claude"]),
      ).toBeNull();
    });

    it("suppresses the bot's own label swap under trigger_on_open", () => {
      const payload = {
        action: "labeled",
        installation: { id: 42 },
        repository: { full_name: "owner/name" },
        issue: { number: 7, body: "@noodle please", labels: [] },
        sender: { login: "noodle[bot]" },
      };
      // A human adding a label still wakes (under trigger_on_open).
      const human = { ...payload, sender: { login: "alice" } };
      expect(parseWebhookEvent("issues", human, "noodle[bot]", "Noodle", openAll)?.kind).toBe("issue");
      // The bot's own label swap does not.
      expect(parseWebhookEvent("issues", payload, "noodle[bot]", "Noodle", openAll)).toBeNull();
    });

    it("still wakes on a human comment (no regression)", () => {
      const payload = {
        action: "created",
        installation: { id: 42 },
        repository: { full_name: "owner/name" },
        issue: { number: 7 },
        comment: { body: "@noodle one more thing" },
        sender: { login: "alice" },
      };
      expect(parseWebhookEvent("issue_comment", payload, "noodle[bot]", "Noodle")).toEqual({
        kind: "comment",
        repo: "owner/name",
        issueNumber: 7,
        installationId: 42,
      });
    });

    it("does NOT suppress the bot's own issues.opened (cron/trigger chaining)", () => {
      // Cron/trigger runs open new issues to chain into another agent run —
      // that path must keep working even when the sender is the bot itself.
      const payload = {
        action: "opened",
        installation: { id: 42 },
        repository: { full_name: "owner/name" },
        issue: { number: 7, body: "@noodle found a bug", labels: [] },
        sender: { login: "noodle[bot]" },
      };
      expect(parseWebhookEvent("issues", payload, "noodle[bot]", "Noodle", optIn)?.kind).toBe("issue");
    });

    it("does NOT suppress the bot's own issues.reopened", () => {
      const payload = {
        action: "reopened",
        repository: { full_name: "owner/name" },
        issue: { number: 7, body: "@noodle retry", labels: [] },
        sender: { login: "noodle[bot]" },
      };
      expect(parseWebhookEvent("issues", payload, "noodle[bot]", "Noodle", optIn)?.kind).toBe("issue");
    });

    it("tolerates the [bot] suffix on either side (and is case-insensitive)", () => {
      // selfLogin without suffix, sender with suffix → suppressed.
      const payload = {
        action: "created",
        repository: { full_name: "owner/name" },
        issue: { number: 7 },
        comment: { body: "@noodle go" },
        sender: { login: "noodle[bot]" },
      };
      expect(parseWebhookEvent("issue_comment", payload, "noodle", "Noodle")).toBeNull();
      // selfLogin with suffix, sender without (unusual but tolerated) → suppressed.
      expect(
        parseWebhookEvent("issue_comment", { ...payload, sender: { login: "Noodle" } }, "noodle[bot]", "Noodle"),
      ).toBeNull();
    });

    it("fires on issues.assigned to the App bot in App mode (regression)", () => {
      // Previously broken: App-mode selfLogin was `noodle-agent`, so assigning
      // to the real `noodle[bot]` never matched. Now the derivation is correct.
      const payload = {
        ...basePayload,
        action: "assigned",
        assignee: { login: "noodle[bot]" },
        sender: { login: "someone" },
      };
      expect(parseWebhookEvent("issues", payload, "noodle[bot]")?.kind).toBe("issue");
    });
  });
});
