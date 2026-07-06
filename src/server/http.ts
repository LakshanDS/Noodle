import Fastify, { type FastifyInstance } from "fastify";
import { verifySignature, parseWebhookEvent } from "../github/webhook.js";
import { log } from "../util/log.js";
import type { TriggerConfig } from "../triggers/check.js";

/**
 * fastify webhook receiver. POST /webhook:
 *   - verify HMAC (X-Hub-Signature-256) over the RAW body
 *   - parse the event into a normalized intent (or null if ignorable)
 *   - enqueue the job (never block on the agent) → respond 202
 *
 * The raw body is captured via a custom content-type parser so we have the
 * exact bytes for the HMAC check; the handler JSON.parses it for routing.
 */

export interface WebhookHandlerDeps {
  /** Enqueue a parsed intent. The http layer never runs the agent. */
  enqueue(intent: {
    repo: string;
    issueNumber: number;
    installationId?: number;
    profileHint?: string;
  }): Promise<void> | void;
  /**
   * Noodle's own login, used to scope `assigned` events to assignments that
   * target Noodle (ignored when unset — assignments then do nothing).
   */
  selfLogin?: string;
  /** Configurable agent display name (default "Noodle"). Used for slash-command trigger. */
  agentName?: string;
  /**
   * Opt-in wake filter for `issues.*` events (mention / keyword / always).
   * When omitted, `parseWebhookEvent` falls back to a safe default
   * (mention-only). Production callers should pass the config's triggers
   * block so the user-configured trigger set is honored.
   */
  triggers?: TriggerConfig;
  /** Configured profile names — enables `#<profile>` tag wake/routing. */
  profileNames?: string[];
}

export function createWebhookApp(secret: string, deps: WebhookHandlerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // Capture the raw body for HMAC verification instead of letting fastify
  // parse (and discard) it. We JSON.parse in the handler.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body.toString());
    },
  );

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/webhook", async (req, reply) => {
    const raw = req.body as string;
    const event = req.headers["x-github-event"] as string | undefined;

    // ping events are GitHub's webhook handshake — always ack them.
    if (event === "ping") {
      return reply.code(200).send({ ok: true, event: "ping" });
    }

    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifySignature(raw, sig, secret)) {
      log.warn({ event, ip: req.ip }, "webhook signature verification failed");
      return reply.code(401).send({ error: "invalid signature" });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return reply.code(400).send({ error: "invalid json" });
    }

    const intent = parseWebhookEvent(
      event ?? "",
      payload,
      deps.selfLogin,
      deps.agentName,
      deps.triggers,
      deps.profileNames ?? [],
    );
    if (!intent) {
      // Acknowledge but ignore — not an event Noodle acts on.
      return reply.code(202).send({ ok: true, ignored: true });
    }

    try {
      await deps.enqueue(intent);
      log.info({ event, repo: intent.repo, issue: intent.issueNumber }, "webhook enqueued");
      return reply.code(202).send({ ok: true, enqueued: true });
    } catch (e) {
      log.error({ err: e, event }, "webhook enqueue failed");
      return reply.code(500).send({ error: "enqueue failed" });
    }
  });

  return app;
}
