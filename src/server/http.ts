import Fastify, { type FastifyInstance } from "fastify";
import { verifySignature, parseWebhookEvent, parseWebhookMetadata, matchTriggers } from "../github/webhook.js";
import { log } from "../util/log.js";
import type { TriggerConfig } from "../triggers/check.js";
import type { TriggerStore } from "./trigger-store.js";

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
   * target Noodle (ignored when unset — assignments then do nothing). Supplied
   * as a getter so changes to NOODLE_LOGIN / agent_name take effect without a
   * restart.
   */
  selfLogin?: () => string | undefined;
  /** Configurable agent display name (default "Noodle"). Used for slash-command trigger. Getter for live updates. */
  agentName?: () => string | undefined;
  /**
   * Opt-in wake filter for `issues.*` events (mention / keyword / always).
   * When omitted, `parseWebhookEvent` falls back to a safe default
   * (mention-only). Getter so edits to the triggers take effect without restart.
   */
  triggers?: () => TriggerConfig | undefined;
  /** Configured profile names — enables `#<profile>` tag wake/routing. Getter for live updates. */
  profileNames?: () => string[];
  /**
   * Active command triggers (from the command store). A `/<trigger>` in a new
   * comment wakes the agent. When omitted, only `/<agent-slug>` wakes — the
   * historical behaviour. Supplied as a getter so the webhook always sees the
   * current set after edits (no server restart needed).
   */
  commandTriggers?: () => string[];
  /** Trigger store for event-driven trigger matching. */
  triggerStore?: TriggerStore;
  /** Enqueue a trigger-originated job. */
  enqueueTrigger?(opts: {
    repo: string;
    triggerId: number;
    installationId?: number;
    profile?: string | null;
  }): Promise<void> | void;
  /** Get the default profile name. */
  defaultProfile?: () => string | undefined;
}

export function createWebhookApp(getSecret: () => string, deps: WebhookHandlerDeps): FastifyInstance {
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

    const secret = getSecret();
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!secret) {
      // No webhook secret configured — skip verification. The warning is
      // logged once at startup (serve.ts); don't spam per-request.
    } else if (!verifySignature(raw, sig, secret)) {
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
      deps.selfLogin?.(),
      deps.agentName?.(),
      deps.triggers?.(),
      deps.profileNames?.() ?? [],
      deps.commandTriggers?.() ?? [],
    );
    if (!intent) {
      // Acknowledge but ignore — not an event Noodle acts on.
      // Still check for trigger matches (triggers can fire on any event type).
    }

    // Always check for trigger matches — triggers can match events that
    // parseWebhookEvent ignores (e.g. pull_request lifecycle, push).
    let triggerMatched = false;
    if (deps.triggerStore && deps.enqueueTrigger) {
      const metadata = parseWebhookMetadata(event ?? "", payload);
      if (metadata) {
        try {
          const repoTriggers = deps.triggerStore.listByRepo(metadata.repo);
          const matched = matchTriggers(metadata, repoTriggers);
          for (const m of matched) {
            const trigger = repoTriggers.find((t) => t.id === m.id);
            if (!trigger) continue;
            await deps.enqueueTrigger({
              repo: metadata.repo,
              triggerId: trigger.id,
              installationId: metadata.installationId,
              profile: trigger.profile ?? deps.defaultProfile?.() ?? null,
            });
            deps.triggerStore.markTriggered(trigger.id);
            triggerMatched = true;
            log.info({ event, repo: metadata.repo, triggerId: trigger.id }, "trigger enqueued");
          }
        } catch (e) {
          log.error({ err: e, event }, "trigger matching failed");
        }
      }
    }

    if (!intent && !triggerMatched) {
      return reply.code(202).send({ ok: true, ignored: true });
    }

    try {
      if (intent) {
        await deps.enqueue(intent);
        log.info({ event, repo: intent.repo, issue: intent.issueNumber }, "webhook enqueued");
      }
      return reply.code(202).send({ ok: true, enqueued: true });
    } catch (e) {
      log.error({ err: e, event }, "webhook enqueue failed");
      return reply.code(500).send({ error: "enqueue failed" });
    }
  });

  return app;
}
