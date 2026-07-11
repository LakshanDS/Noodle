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

  const profiles = buildProfileMap(config);
  const providerUrls = opts.originalUrls ?? resolveProviderUrls(config);

  // --- Routes ---

  app.get("/health", async () => ({ status: "ok", profiles: Array.from(profiles.keys()) }));

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

    // 1. Rate-limit: sleep the fixed RPM interval (60000/rpm ms) so we never
    //    exceed the provider's limit. Throws if the model isn't configured.
    let apiKeyEnv: string;
    try {
      apiKeyEnv = await acquireSlot(profiles, model);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    // 2. Resolve API key + base URL.
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      log.error({ model, apiKeyEnv }, "relay: API key env var not set");
      return reply.code(500).send({ error: `API key not configured (${apiKeyEnv})` });
    }
    const baseUrl = findProviderUrl(config, model, providerUrls);
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

/**
 * Start the relay server. Called from the CLI or from serve.ts.
 */
export async function startRelay(config: NoodleConfig, opts: RelayOptions = {}): Promise<void> {
  const relayConfig = (config as Record<string, unknown>).relay as { port?: number; host?: string } | undefined;
  const port = opts.port ?? relayConfig?.port ?? 4445;
  const host = opts.host ?? relayConfig?.host ?? "0.0.0.0";

  const app = createRelayServer(config);

  await app.listen({ port, host });
  log.info({ port, host }, "relay server listening");

  // Graceful shutdown.
  const shutdown = async (signal: string) => {
    log.info({ signal }, "relay shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// --- Helpers ---

/** Build a map of model → profile config from the Noodle config. */
function buildProfileMap(config: NoodleConfig): Map<string, ProfileConfig> {
  const map = new Map<string, ProfileConfig>();
  for (const [name, profile] of Object.entries(config.profiles)) {
    map.set(profile.model, {
      model: profile.model,
      api_key_env: profile.api_key_env ?? "",
      api_rpm: profile.api_rpm,
    });
    log.debug({ profile: name, model: profile.model, rpm: profile.api_rpm }, "relay: registered profile");
  }
  return map;
}

/** Resolve provider base URLs from config profiles. */
function resolveProviderUrls(config: NoodleConfig): Map<string, string> {
  const urls = new Map<string, string>();
  for (const profile of Object.values(config.profiles)) {
    if (profile.base_url) {
      urls.set(profile.model, profile.base_url);
    }
  }
  return urls;
}

/** Find the base URL for a given model. */
function findProviderUrl(
  config: NoodleConfig,
  model: string,
  providerUrls: Map<string, string>,
): string | null {
  const direct = providerUrls.get(model);
  if (direct) return direct;

  for (const profile of Object.values(config.profiles)) {
    if (profile.model === model && profile.base_url) {
      return profile.base_url;
    }
  }
  return null;
}
