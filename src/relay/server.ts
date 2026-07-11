import Fastify, { type FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { log } from "../util/log.js";
import { RateLimiter, type ProfileConfig } from "./rate-limiter.js";
import { forwardRequest, forwardRequestStream } from "./forwarder.js";
import type { NoodleConfig } from "../config/schema.js";

/**
 * API relay server. Sits between agents and the real AI provider, enforcing
 * per-profile RPM limits centrally.
 *
 * Endpoints:
 *   POST /v1/chat/completions — forward to the provider after rate-limit check
 *   GET  /health              — health check
 *   GET  /stats               — rate limiter stats (for debugging)
 *
 * Agents point their base_url to this relay (e.g. http://localhost:4445/v1).
 * The relay extracts the model from the request body, looks up the matching
 * profile in the config, applies that profile's rate limit, and forwards the
 * request to the real API with the correct API key.
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

  // Build the profile map from config.
  const profiles = buildProfileMap(config);
  const rateLimiter = new RateLimiter();

  // Use original URLs for forwarding if provided, otherwise resolve from config.
  const providerUrls = opts.originalUrls ?? resolveProviderUrls(config);

  // --- Routes ---

  app.get("/health", async () => ({ status: "ok", profiles: Array.from(profiles.keys()) }));

  app.get("/stats", async () => ({
    buckets: rateLimiter.getStats(),
  }));

  // Raw body parser — we need the original JSON to forward.
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

    // 1. Rate-limit check.
    let apiKeyEnv: string;
    try {
      apiKeyEnv = await rateLimiter.acquireSlot(profiles, model);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    // 2. Resolve API key from env.
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      log.error({ model, apiKeyEnv }, "relay: API key env var not set");
      return reply.code(500).send({ error: `API key not configured (${apiKeyEnv})` });
    }

    // 3. Find the base URL for this model's provider.
    const baseUrl = findProviderUrl(config, model, providerUrls);
    if (!baseUrl) {
      return reply.code(400).send({ error: `No base_url configured for model "${model}"` });
    }

    const isStreaming = body.stream === true;

    // 4. Forward to the real API.
    try {
      const forwardUrl = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
      log.info({ model, baseUrl, url: forwardUrl, stream: isStreaming, bodyKeys: Object.keys(body), messages: Array.isArray(body.messages) ? body.messages.length : 0 }, "relay: forwarding request");

      if (isStreaming) {
        // Streaming: pipe the SSE response directly to the client.
        const result = await forwardRequestStream(baseUrl, apiKey, body);
        reply.raw.writeHead(result.status, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        const nodeStream = Readable.fromWeb(result.stream as any);
        nodeStream.pipe(reply.raw);
        reply.hijack();
        return;
      }

      // Non-streaming: parse JSON response.
      const result = await forwardRequest(baseUrl, apiKey, body);
      if (result.status >= 400) {
        log.warn({ model, status: result.status, body: result.body }, "relay: upstream error");
      }
      return reply.code(result.status).send(result.body);
    } catch (e) {
      log.error({ err: (e as Error).message, model }, "relay: forward failed");
      return reply.code(502).send({ error: `Upstream error: ${(e as Error).message}` });
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

/**
 * Build a map of model → profile config from the Noodle config.
 */
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

/**
 * Resolve provider base URLs from config profiles.
 */
function resolveProviderUrls(config: NoodleConfig): Map<string, string> {
  const urls = new Map<string, string>();
  for (const profile of Object.values(config.profiles)) {
    if (profile.base_url) {
      urls.set(profile.model, profile.base_url);
    }
  }
  return urls;
}

/**
 * Find the base URL for a given model.
 */
function findProviderUrl(
  config: NoodleConfig,
  model: string,
  providerUrls: Map<string, string>,
): string | null {
  // First check if the model has a direct base_url in config.
  const direct = providerUrls.get(model);
  if (direct) return direct;

  // Fall back to the provider name lookup.
  for (const profile of Object.values(config.profiles)) {
    if (profile.model === model && profile.base_url) {
      return profile.base_url;
    }
  }

  return null;
}
