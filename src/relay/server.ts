import Fastify, { type FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { log } from "../util/log.js";
import { acquireSlot, type ProfileConfig } from "./rate-limiter.js";
import { forwardRequest, forwardRequestStream } from "./forwarder.js";
import type { NoodleConfig } from "../config/schema.js";

/**
 * API relay server. A dumb rate-limiting proxy between agents and the real AI
 * provider.
 *
 * The flow is intentionally simple:
 *   1. Agent POSTs to /v1/chat/completions (pointed at the relay, not the provider).
 *   2. Relay looks up the model → profile, resolves the API key + real base URL.
 *   3. Relay sleeps however much of the RPM interval remains since the last
 *      request for that model (e.g. 30 RPM → 2s spacing). This is the ONLY
 *      timing mechanism — by spacing every request we never exceed the limit.
 *   4. Relay forwards the request verbatim and pipes the response straight back.
 *
 * No retries, no Retry-After, no 429 penalties. The provider never sends a 429
 * because we never exceed the RPM. If it does anyway (transient), the response
 * passes through and the agent's own retry logic (which re-enters the relay and
 * re-waits its interval) handles it.
 *
 * Endpoint:
 *   POST /v1/chat/completions — forward (streaming or non-streaming)
 *   GET  /health              — health check
 */

export interface RelayOptions {
  /** Port to listen on (default: 4445). */
  port?: number;
  /** Host to bind to (default: 0.0.0.0). */
  host?: string;
  /** Original base URLs before relay rewrite (for forwarding). */
  originalUrls?: Map<string, string>;
}

export function createRelayServer(config: NoodleConfig, opts: RelayOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  // Use the shared originalUrls map (live reference, not a snapshot) so
  // profiles toggled to use_relay after boot are immediately routable.
  const originalUrls = opts.originalUrls;

  // --- Routes ---

  app.get("/health", async () => {
    const profiles = buildProfileMap(config);
    return { status: "ok", profiles: Array.from(profiles.keys()) };
  });

  // Raw body parser — we forward the original JSON untouched.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body.toString());
    },
  );

  app.post("/v1/chat/completions", async (req, reply) => {
    const raw = req.body as string;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply.code(400).send({ error: "invalid json" });
    }

    const model = body.model;
    if (typeof model !== "string") {
      return reply.code(400).send({ error: "missing or invalid 'model' in request body" });
    }

    // 1. Rate-limit: rebuild profile map from live config so newly toggled
    //    use_relay profiles are picked up without a restart.
    const profiles = buildProfileMap(config);
    let apiKey: string;
    try {
      apiKey = await acquireSlot(profiles, model);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    // 2. Resolve base URL — check originalUrls map first (live reference),
    //    then fall back to config.profiles.
    const baseUrl = originalUrls?.get(model) ?? findProviderUrl(config, model);
    if (!baseUrl) {
      return reply.code(400).send({ error: `No base_url configured for model "${model}"` });
    }

    const isStreaming = body.stream === true;
    const forwardUrl = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

    // 3. Forward verbatim and pipe the response back.
    try {
      log.debug(
        { model, baseUrl, url: forwardUrl, stream: isStreaming, bodyKeys: Object.keys(body), messages: Array.isArray(body.messages) ? body.messages.length : 0 },
        "relay: forwarding request",
      );

      if (isStreaming) {
        const result = await forwardRequestStream(baseUrl, apiKey, body);
        reply.raw.writeHead(result.status, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const nodeStream = Readable.fromWeb(result.stream as never);
        nodeStream.pipe(reply.raw);
        reply.hijack();
        return;
      }

      const result = await forwardRequest(baseUrl, apiKey, body);
      if (result.status >= 400) {
        log.warn({ model, status: result.status }, "relay: upstream error");
      }
      return reply.code(result.status).send(result.body);
    } catch (e) {
      const msg = (e as Error).message;
      log.error({ err: msg, model }, "relay: forward failed");
      return reply.code(502).send({ error: `Upstream error: ${msg}` });
    }
  });

  return app;
}

// --- Helpers ---

/** Build a map of model → profile config from live config, filtered to relay-enabled profiles. */
function buildProfileMap(config: NoodleConfig): Map<string, ProfileConfig> {
  const map = new Map<string, ProfileConfig>();
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!profile.use_relay) continue;
    map.set(profile.model, {
      model: profile.model,
      api_key: profile.api_key ?? "",
      api_rpm: profile.api_rpm,
    });
    log.debug({ profile: name, model: profile.model, rpm: profile.api_rpm }, "relay: registered profile");
  }
  return map;
}

/** Find the base URL for a given model from live config.profiles. Fallback only — originalUrls map is preferred. */
function findProviderUrl(config: NoodleConfig, model: string): string | null {
  for (const profile of Object.values(config.profiles)) {
    if (profile.use_relay && profile.model === model && profile.base_url) {
      return profile.base_url;
    }
  }
  return null;
}
