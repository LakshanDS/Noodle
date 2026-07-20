/**
 * Lowercase, replace non-alphanumeric chars with hyphens, collapse runs,
 * and trim leading/trailing hyphens. Used for branch-name prefixes and
 * slash-command triggers derived from the configurable agent name.
 *
 *   slugify("Noodle")      → "noodle"
 *   slugify("My Bot")      → "my-bot"
 *   slugify("Agent_42!")   → "agent-42"
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Relay URL helpers. The relay (src/relay/server.ts) is an invisible dumb pipe:
 * the agent is told a relay-facing base_url and believes that IS the provider.
 * Each transport's SDK concatenates baseURL + a hardcoded path differently, so
 * the relay-facing base_url MUST mirror the upstream's path shape. Then the SDK
 * does its own math against the relay URL, produces a path correct for its
 * protocol, and the relay forwards that exact path to the upstream origin.
 *
 * Per-transport expectations (verified from each SDK's source):
 *   openai-completions  — OpenAI SDK,  path /chat/completions → needs /v1 in base
 *   openai-responses    — OpenAI SDK,  path /responses        → needs /v1 in base
 *   anthropic-messages  — Anthropic SDK, path /v1/messages    → bare host
 *   mistral-conversations — Mistral SDK, path /v1/chat/completions → bare host
 *   google-generative-ai — Google SDK, path varies           → bare host
 *
 * Solution: never mutate the upstream URL. Store it verbatim, derive the
 * relay-facing URL by swapping the origin only (scheme+host+port), and forward
 * by origin-swap too. Whatever path the SDK computes is preserved end-to-end.
 *
 * See "API relay (rate-limiting proxy)" in AGENTS.md.
 */

/**
 * The origin of a URL: scheme://host[:port], no path/query/fragment.
 *   originOf("https://api.mistral.ai/v1")  → "https://api.mistral.ai"
 *   originOf("http://localhost:8080/api")   → "http://localhost:8080"
 */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    // Not a valid absolute URL — return as-is so callers surface a clear error.
    return url;
  }
}

/**
 * The path portion of a URL, with a trailing slash normalised away.
 *   pathOf("https://api.mistral.ai/v1/")  → "/v1"
 *   pathOf("https://api.mistral.ai")      → ""
 *   pathOf("http://localhost:8080/api/v1") → "/api/v1"
 */
export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * Wire protocols whose SDK hardcodes the `/v1` version segment itself. For
 * these, the user-entered path MUST NOT include `/v1` (the SDK adds it), but
 * MAY include a proxy prefix (e.g. `/api/anthropic` for a gateway). We strip a
 * trailing `/v1` only — any other path prefix is preserved for proxy support.
 *
 *   mistral-conversations: Mistral SDK appends /v1/chat/completions
 *   anthropic-messages:    Anthropic SDK appends /v1/messages
 *
 * (Google is handled separately — see below. OpenAI-style transports are the
 * default path-mirror case: the SDK appends /chat/completions only, so the user
 * MUST include /v1 themselves.)
 */
const VERSION_IN_SDK_APIS = new Set([
  "mistral-conversations",
  "anthropic-messages",
]);

/**
 * Google is a special case: pi-ai's google-generative-ai transport sets
 * `httpOptions.apiVersion = ""` and expects `baseUrl` to ALREADY contain the
 * version path. So unlike Mistral/Anthropic (SDK hardcodes /v1) or OpenAI
 * (user includes /v1), Google needs /v1beta injected into the base regardless
 * of what the user entered. Most users enter the bare host
 * (https://generativelanguage.googleapis.com) per Google's docs, so we add it.
 */
const GOOGLE_API = "google-generative-ai";
const GOOGLE_VERSION = "/v1beta";

/**
 * Build the relay-facing base_url for a profile, transport-aware. The relay
 * base mirrors the user's URL onto localhost — including any path prefix — so
 * proxies/gateways work the same as direct providers.
 *
 * Three cases:
 *
 *   1. Google: pi-ai sets apiVersion="" expecting baseUrl to contain /v1beta.
 *      Preserve any user-entered proxy prefix, then ensure /v1beta is present.
 *
 *   2. Version-in-SDK (mistral/anthropic): their SDKs append /v1/... themselves,
 *      so strip a trailing /v1 if the user included it (common — it's in every
 *      provider's docs). Any other path prefix (e.g. /api/anthropic for a proxy)
 *      is preserved — the proxy needs it, the SDK appends /v1 on top.
 *
 *   3. OpenAI-style (path-based SDKs): mirror the upstream's path verbatim. The
 *      OpenAI SDK appends /chat/completions only, so the user must include /v1
 *      (or whatever prefix their proxy needs).
 *
 *   relayBaseUrl("https://api.openai.com/v1", origin, "openai-completions")
 *     → "http://localhost:4445/v1"
 *   relayBaseUrl("https://api.mistral.ai/v1", origin, "mistral-conversations")
 *     → "http://localhost:4445"          (trailing /v1 stripped — SDK adds it)
 *   relayBaseUrl("https://api.mistral.ai", origin, "mistral-conversations")
 *     → "http://localhost:4445"
 *   relayBaseUrl("https://proxy.com/api/anthropic", origin, "anthropic-messages")
 *     → "http://localhost:4445/api/anthropic"  (proxy prefix kept, no /v1 to strip)
 *   relayBaseUrl("https://generativelanguage.googleapis.com", origin, "google-generative-ai")
 *     → "http://localhost:4445/v1beta"
 */
export function relayBaseUrl(upstream: string, relayOrigin: string, api: string): string {
  const path = pathOf(upstream);

  if (api === GOOGLE_API) {
    // Preserve proxy prefix + ensure /v1beta. If the user's path already ends
    // in /v1beta, don't double it.
    if (path.endsWith(GOOGLE_VERSION)) return `${relayOrigin}${path}`;
    return `${relayOrigin}${path}${GOOGLE_VERSION}`;
  }

  if (VERSION_IN_SDK_APIS.has(api)) {
    // SDK appends /v1 itself. Strip a trailing /v1 the user may have included,
    // but KEEP any other path prefix (proxy gateways like /api/anthropic).
    const stripped = path.replace(/\/v1$/, "");
    return stripped ? `${relayOrigin}${stripped}` : relayOrigin;
  }

  // OpenAI-style: mirror the user's path verbatim.
  return path ? `${relayOrigin}${path}` : relayOrigin;
}

/**
 * Build the upstream-facing base URL the relay forwards to — the mirror image
 * of relayBaseUrl, but with the real upstream origin instead of the relay
 * origin. Stored in `originalUrls` so the relay can reconstruct the forward URL
 * by appending req.url to this base.
 *
 *   upstreamBase("https://api.openai.com/v1", "openai-completions")
 *     → "https://api.openai.com/v1"
 *   upstreamBase("https://proxy.com/api/anthropic", "anthropic-messages")
 *     → "https://proxy.com/api/anthropic"   (proxy prefix kept, /v1 stripped if present)
 *   upstreamBase("https://generativelanguage.googleapis.com", "google-generative-ai")
 *     → "https://generativelanguage.googleapis.com/v1beta"
 */
export function upstreamBase(upstream: string, api: string): string {
  return relayBaseUrl(upstream, originOf(upstream), api);
}

/**
 * Reconstruct the forward URL for an upstream base + an incoming request path.
 * Pure origin swap: replace scheme://host with the upstream origin, keep the
 * path exactly as the SDK computed it.
 *
 *   relayForwardUrl("https://api.mistral.ai", "/v1/chat/completions")
 *     → "https://api.mistral.ai/v1/chat/completions"
 *   relayForwardUrl("https://api.openai.com", "/v1/chat/completions")
 *     → "https://api.openai.com/v1/chat/completions"
 */
export function relayForwardUrl(upstreamOrigin: string, requestPath: string): string {
  return `${upstreamOrigin}${requestPath}`;
}

/**
 * Resolve the model id from a relayed request. Most transports (OpenAI, Mistral,
 * Anthropic) put `model` in the JSON body. Google's Generative AI SDK does NOT —
 * it embeds the model in the URL path (`/v1beta/models/<model>:streamGenerateContent`)
 * and sends no body.model field. This tries the body first, then extracts from
 * the Google-style path so the relay can rate-limit + route Google requests
 * without a protocol-specific handler.
 *
 *   resolveModel({ model: "gpt-4o" }, "/v1/chat/completions")        → "gpt-4o"
 *   resolveModel({}, "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse")
 *                                                                    → "gemini-2.5-flash"
 *   resolveModel({}, "/v1/chat/completions")                         → null
 */
export function resolveModel(body: Record<string, unknown>, requestPath: string): string | null {
  const bodyModel = body.model;
  if (typeof bodyModel === "string" && bodyModel) return bodyModel;
  // Google path shape: /v1beta/models/<model>:<method> or /v1beta/models/<model>
  const m = requestPath.match(/\/models\/([^/:?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
