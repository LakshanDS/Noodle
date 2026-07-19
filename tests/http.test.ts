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
