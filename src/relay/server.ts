import Fastify, { type FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { log } from "../util/log.js";
import { acquireSlot, type ProfileConfig } from "./rate-limiter.js";
import { forwardRequest, forwardRequestStream } from "./forwarder.js";
import { originOf, relayForwardUrl, resolveModel } from "../util/slugify.js";
import type { NoodleConfig } from "../config/schema.js";

/**
 * API relay server. An invisible dumb pipe between agents and the real AI
 * provider — see "API relay (rate-limiting proxy)" in AGENTS.md.
 *
 * The relay is transparent to the agent: the agent points its base_url at
 * http://localhost:4445/v1 and believes that IS the provider. It builds a
 * request correct for the profile's `api` protocol and POSTs it. The relay:
 *   1. Looks up the model → profile, resolves the API key + real upstream URL.
 *   2. Sleeps however much of the RPM interval remains since the last request
 *      for that model (e.g. 30 RPM → 2s spacing). This is the ONLY timing
 *      mechanism — by spacing every request we never exceed the limit.
 *   3. Forwards the request VERBATIM and pipes the response straight back.
 *
 * The relay MUST NOT mutate the request body. No role rewriting, no field
 * stripping, no protocol awareness. The request is correct the moment the
 * agent builds it (correctness lives in the agent layer via the profile's `api`
 * field and compat settings — see src/profiles/custom-providers.ts). The relay
 * is a wire with a timer on it.
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

  // Accept any POST. Each transport SDK concatenates its hardcoded path onto the
  // base_url it was told (the relay-facing URL, which mirrors the upstream's
  // path shape), so whatever path arrives here is already correct for that
  // transport's protocol. We forward by pure origin swap: replace the relay
  // origin with the upstream origin, keep the path + headers + body verbatim.
  app.post("/*", async (req, reply) => {
    const raw = req.body as string;
    let body: Record<string, unknown> = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: "invalid json" });
      }
    }

    // Resolve model from body (OpenAI/Mistral/Anthropic) OR URL path (Google,
    // which embeds the model in /v1beta/models/<model>:...). Needed only for
    // rate-limiting + origin lookup — NOT for auth (the SDK's own headers carry
    // that) or path (the SDK already computed it).
    const model = resolveModel(body, req.url);
    if (!model) {
      return reply.code(400).send({ error: "could not resolve model from body or path" });
    }

    // 1. Rate-limit: rebuild profile map from live config so newly toggled
    //    use_relay profiles are picked up without a restart. acquireSlot sleeps
    //    for the per-model RPM interval; its returned api_key is IGNORED — the
    //    SDK already sent the correct auth header for its transport (Bearer for
    //    OpenAI/Mistral, x-goog-api-key for Google, x-api-key for Anthropic).
    const profiles = buildProfileMap(config);
    try {
      await acquireSlot(profiles, model);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    // 2. Resolve upstream ORIGIN — check originalUrls map first (live
    //    reference), then fall back to config.profiles. originalUrls stores the
    //    upstream ORIGIN (scheme://host) only. The path prefix (e.g.
    //    /api/anthropic for a proxy) is NOT stored here — it comes from req.url
    //    itself, because the agent was told a relay-facing URL with the same
    //    prefix (relayBaseUrl) and the SDK appended its version path on top.
    //    Forward = pure origin swap: upstream origin + req.url.
    const upstreamOrigin = originalUrls?.get(model) ?? findProviderUrl(config, model);
    if (!upstreamOrigin) {
      return reply.code(400).send({ error: `No base_url configured for model "${model}"` });
    }

    // Streaming if the body says so (OpenAI/Mistral) OR the Google path
    // indicates a streaming method (:streamGenerateContent).
    const isStreaming = body.stream === true || /:stream(Generate)?/i.test(req.url);
    // Pure origin swap: upstream origin + incoming path. The path already
    // carries the full correct path (proxy prefix + version + endpoint) because
    // the agent was told a relay-facing URL mirroring the upstream's path shape,
    // and the SDK appended its protocol-specific path on top.
    const forwardUrl = relayForwardUrl(upstreamOrigin, req.url);

    // Forward the SDK's original headers verbatim, minus hop-by-hop headers
    // that fetch recomputes (host, content-length, connection). This preserves
    // each transport's auth header (Bearer / x-goog-api-key / x-api-key) without
    // the relay needing to know which one applies.
    const forwardHeaders = sanitizeForwardHeaders(req.headers);

    // 3. Forward verbatim and pipe the response back. Headers + body are the
    //    SDK's originals — the agent already built them correctly for the
    //    profile's api protocol, including auth.
    try {
      if (isStreaming) {
        const result = await forwardRequestStream(forwardUrl, forwardHeaders, raw);
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

      const result = await forwardRequest(forwardUrl, forwardHeaders, raw);
      if (result.status >= 400) {
        // Errors carry forwardUrl on purpose — it's the single fastest signal
        // for "the relay built the wrong upstream path". Per-request success
        // traffic stays out of the log to keep the file sparse.
        log.warn(
          { model, status: result.status, forwardUrl, bodyExcerpt: typeof result.body === "string" ? result.body.slice(0, 200) : "" },
          "relay: upstream error",
        );
      }
      return reply.code(result.status).send(result.body);
    } catch (e) {
      const msg = (e as Error).message;
      log.error({ err: msg, model, forwardUrl }, "relay: forward failed");
      return reply.code(502).send({ error: `Upstream error: ${msg}` });
    }
  });

  return app;
}

// --- Helpers ---

/**
 * Hop-by-hop / fetch-managed headers that must NOT be forwarded verbatim:
 * `host` (fetch sets it from the URL), `content-length` (fetch recomputes from
 * the body), `connection` (hop-by-hop). Everything else — including each
 * transport's auth header (Bearer, x-goog-api-key, x-api-key) — passes through
 * untouched so the relay stays a transparent proxy.
 */
const STRIPPED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

/** Copy req.headers minus the stripped hop-by-hop set. Lowercases keys. */
function sanitizeForwardHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (STRIPPED_HEADERS.has(key.toLowerCase())) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

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

/**
 * Find the upstream ORIGIN for a given model from live config.profiles.
 * Fallback only — the originalUrls map is preferred (and correct). Returns the
 * origin (scheme://host) so the relay can forward by pure origin-swap.
 *
 * NOTE: when use_relay is on, the profile's base_url has been rewritten to the
 * relay-facing URL (localhost:4445/...), so this returns localhost — only
 * correct as a fallback when originalUrls is empty. Callers should always
 * populate originalUrls at boot (serve.ts) and on profile CRUD (ui-routes.ts).
 */
function findProviderUrl(config: NoodleConfig, model: string): string | null {
  for (const profile of Object.values(config.profiles)) {
    if (profile.use_relay && profile.model === model && profile.base_url) {
      return originOf(profile.base_url);
    }
  }
  return null;
}
