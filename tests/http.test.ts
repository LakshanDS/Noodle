import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import { createWebhookApp } from "../src/server/http.js";
import type { TriggerConfig } from "../src/triggers/check.js";

const SECRET = "whodunit";

/** Legacy triggers: fire on every issue (used by tests that don't care about the wake filter). */
const openAll: TriggerConfig = { trigger_on_mention: false, trigger_keywords: [], trigger_on_open: true };

/** Sign a JSON payload the way GitHub does. */
function sign(body: string, secret = SECRET): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

const issueOpenedPayload = (issueNumber = 7) =>
  JSON.stringify({
    action: "opened",
    installation: { id: 42 },
    repository: { full_name: "owner/name" },
    // Body @-mentions the agent so the opt-in wake filter lets it through.
    issue: { number: issueNumber, body: "@noodle please fix" },
  });

const apps = new Set<{ close: () => Promise<unknown> }>();
afterEach(async () => {
  for (const a of apps) await a.close().catch(() => {});
  apps.clear();
});

async function postWebhook(opts: {
  event?: string;
  body: string;
  sig?: string;
  selfLogin?: string;
  triggers?: TriggerConfig;
  profileNames?: string[];
  enqueue: (i: { kind: string; repo: string; issueNumber: number; installationId?: number }) => Promise<void> | void;
}) {
  const app = createWebhookApp(() => SECRET, {
    enqueue: opts.enqueue,
    selfLogin: () => opts.selfLogin,
    triggers: () => opts.triggers,
    profileNames: () => opts.profileNames ?? ["test-profile"],
  });
  apps.add(app);
  return app.inject({
    method: "POST",
    url: "/webhook",
    headers: {
      "content-type": "application/json",
      "x-github-event": opts.event ?? "issues",
      "x-hub-signature-256": opts.sig ?? sign(opts.body),
    },
    payload: opts.body,
  });
}

describe("webhook http endpoint", () => {
  it("accepts a signed issues.opened and enqueues it (202)", async () => {
    const enqueued: { kind: string; repo: string; issueNumber: number; installationId?: number }[] = [];
    const res = await postWebhook({
      body: issueOpenedPayload(),
      enqueue: async (i) => {
        enqueued.push(i);
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, enqueued: true });
    expect(enqueued).toEqual([
      { kind: "issue", repo: "owner/name", issueNumber: 7, installationId: 42 },
    ]);
  });

  it("rejects an unsigned request with 401", async () => {
    const res = await postWebhook({
      body: issueOpenedPayload(),
      sig: "sha256=deadbeef",
      enqueue: async () => {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("acks a ping event without enqueuing", async () => {
    const enqueued: unknown[] = [];
    const res = await postWebhook({
      event: "ping",
      body: JSON.stringify({ zen: "keep it simple" }),
      enqueue: async () => {
        enqueued.push(true);
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, event: "ping" });
    expect(enqueued).toHaveLength(0);
  });

  it("acks (202, ignored) an unrelated event without enqueuing", async () => {
    const enqueued: unknown[] = [];
    const res = await postWebhook({
      event: "issues",
      body: JSON.stringify({ action: "closed", repository: { full_name: "o/r" }, issue: { number: 1 } }),
      enqueue: async () => {
        enqueued.push(true);
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().ignored).toBe(true);
    expect(enqueued).toHaveLength(0);
  });

  it("enqueues when an issue is assigned to Noodle (selfLogin match)", async () => {
    const enqueued: { repo: string; issueNumber: number }[] = [];
    const body = JSON.stringify({
      action: "assigned",
      installation: { id: 42 },
      repository: { full_name: "owner/name" },
      issue: { number: 9 },
      assignee: { login: "noodle-bot" },
    });
    const res = await postWebhook({
      body,
      selfLogin: "noodle-bot",
      enqueue: async (i) => {
        enqueued.push({ repo: i.repo, issueNumber: i.issueNumber });
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, enqueued: true });
    expect(enqueued).toEqual([{ repo: "owner/name", issueNumber: 9 }]);
  });

  it("ignores an assignment to someone other than Noodle", async () => {
    const enqueued: unknown[] = [];
    const body = JSON.stringify({
      action: "assigned",
      installation: { id: 42 },
      repository: { full_name: "owner/name" },
      issue: { number: 9 },
      assignee: { login: "some-human" },
    });
    const res = await postWebhook({
      body,
      selfLogin: "noodle-bot",
      enqueue: async () => {
        enqueued.push(true);
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().ignored).toBe(true);
    expect(enqueued).toHaveLength(0);
  });

  it("returns 500 when the enqueue callback throws", async () => {
    const res = await postWebhook({
      body: issueOpenedPayload(),
      enqueue: async () => {
        throw new Error("queue broken");
      },
    });
    expect(res.statusCode).toBe(500);
  });

  it("responds ok on GET /health", async () => {
    const app = createWebhookApp(() => SECRET, { enqueue: async () => {} });
    apps.add(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("self check-run webhook suppression", () => {
  /** A trigger store with one trigger that fires on ANY check_run event. */
  const checkRunTriggerStore = {
    listByRepo: () => [{ id: 1, event_type: "check_run", event_action: null, branch_pattern: null }],
    markTriggered: () => {},
  };

  const checkRunPayload = (login: string) =>
    JSON.stringify({
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "owner/name" },
      sender: { login },
      check_run: { id: 555, name: "Noodle is cooking", status: "in_progress" },
    });

  it("does NOT fire a trigger for the bot's own check_run webhook", async () => {
    const enqueued: number[] = [];
    const app = createWebhookApp(() => SECRET, {
      enqueue: async () => {},
      selfLogin: () => "noodle[bot]",
      triggerStore: checkRunTriggerStore as any,
      enqueueTrigger: async (o) => {
        enqueued.push(o.triggerId);
      },
      defaultProfile: () => "p",
    });
    apps.add(app);
    const body = checkRunPayload("noodle[bot]");
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body), "x-github-event": "check_run" },
      payload: body,
    });
    // Acknowledged + ignored — the bot's own progress updates never chain-run.
    expect(res.statusCode).toBe(202);
    expect(res.json().ignored).toBe(true);
    expect(enqueued).toEqual([]);
  });

  it("still fires the trigger for a check_run webhook from someone else", async () => {
    const enqueued: number[] = [];
    const app = createWebhookApp(() => SECRET, {
      enqueue: async () => {},
      selfLogin: () => "noodle[bot]",
      triggerStore: checkRunTriggerStore as any,
      enqueueTrigger: async (o) => {
        enqueued.push(o.triggerId);
      },
      defaultProfile: () => "p",
    });
    apps.add(app);
    const body = checkRunPayload("some-other-app[bot]");
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body), "x-github-event": "check_run" },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(enqueued).toEqual([1]);
  });
});

describe("trigger PR-event passthrough + self comment suppression", () => {
  /** A trigger store with one trigger that fires on ANY issue_comment event. */
  const commentTriggerStore = {
    listByRepo: () => [{ id: 2, event_type: "issue_comment", event_action: null, branch_pattern: null }],
    markTriggered: () => {},
  };

  const commentPayload = (login: string) =>
    JSON.stringify({
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "owner/name" },
      sender: { login },
      issue: { number: 7 },
      comment: { body: "hello" },
    });

  it("does NOT fire a trigger for the bot's own issue_comment.created (PR-comment loop guard)", async () => {
    const enqueued: number[] = [];
    const app = createWebhookApp(() => SECRET, {
      enqueue: async () => {},
      selfLogin: () => "noodle[bot]",
      triggerStore: commentTriggerStore as any,
      enqueueTrigger: async (o) => {
        enqueued.push(o.triggerId);
      },
      defaultProfile: () => "p",
    });
    apps.add(app);
    const body = commentPayload("noodle[bot]");
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body), "x-github-event": "issue_comment" },
      payload: body,
    });
    // Trigger runs deliver their findings as PR comments — the bot's own
    // comment must never chain-fire a broad issue_comment trigger.
    expect(res.statusCode).toBe(202);
    expect(res.json().ignored).toBe(true);
    expect(enqueued).toEqual([]);
  });

  it("still fires an issue_comment trigger for a comment from someone else", async () => {
    const enqueued: number[] = [];
    const app = createWebhookApp(() => SECRET, {
      enqueue: async () => {},
      selfLogin: () => "noodle[bot]",
      triggerStore: commentTriggerStore as any,
      enqueueTrigger: async (o) => {
        enqueued.push(o.triggerId);
      },
      defaultProfile: () => "p",
    });
    apps.add(app);
    const body = commentPayload("a-human");
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body), "x-github-event": "issue_comment" },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(enqueued).toEqual([2]);
  });

  it("passes the event PR number + fired event through to enqueueTrigger", async () => {
    const prTriggerStore = {
      listByRepo: () => [{ id: 3, event_type: "pull_request", event_action: null, branch_pattern: null }],
      markTriggered: () => {},
    };
    const received: Array<Record<string, unknown>> = [];
    const app = createWebhookApp(() => SECRET, {
      enqueue: async () => {},
      selfLogin: () => "noodle[bot]",
      triggerStore: prTriggerStore as any,
      enqueueTrigger: async (o) => {
        received.push(o as unknown as Record<string, unknown>);
      },
      defaultProfile: () => "p",
    });
    apps.add(app);
    const body = JSON.stringify({
      action: "opened",
      installation: { id: 42 },
      repository: { full_name: "owner/name" },
      sender: { login: "a-human" },
      pull_request: { number: 42 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body), "x-github-event": "pull_request" },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(received).toEqual([
      {
        repo: "owner/name",
        triggerId: 3,
        installationId: 42,
        profile: "p",
        prNumber: 42,
        event: { type: "pull_request", action: "opened", issueNumber: null },
      },
    ]);
  });

  it("passes the fired issue number through to enqueueTrigger (no prNumber)", async () => {
    const issueTriggerStore = {
      listByRepo: () => [{ id: 4, event_type: "issues", event_action: "opened", branch_pattern: null }],
      markTriggered: () => {},
    };
    const received: Array<Record<string, unknown>> = [];
    const app = createWebhookApp(() => SECRET, {
      enqueue: async () => {},
      selfLogin: () => "noodle[bot]",
      triggerStore: issueTriggerStore as any,
      enqueueTrigger: async (o) => {
        received.push(o as unknown as Record<string, unknown>);
      },
      defaultProfile: () => "p",
    });
    apps.add(app);
    const body = JSON.stringify({
      action: "opened",
      installation: { id: 42 },
      repository: { full_name: "owner/name" },
      sender: { login: "a-human" },
      issue: { number: 195 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body), "x-github-event": "issues" },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(received).toEqual([
      {
        repo: "owner/name",
        triggerId: 4,
        installationId: 42,
        profile: "p",
        prNumber: undefined,
        event: { type: "issues", action: "opened", issueNumber: 195 },
      },
    ]);
  });
});
