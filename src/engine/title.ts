import { log } from "../util/log.js";
import type { Model, Api, Context } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * One-shot LLM completion for the post-run output shaping (title generation +
 * output phrasing). These used to hand-roll an OpenAI Chat Completions body and
 * POST it to the relay at /v1/chat/completions — which only worked when the
 * agent's profile was itself an OpenAI-compatible endpoint. For any other
 * protocol (anthropic-messages → /v1/messages, mistral-conversations,
 * google-generative-ai) the relay forwarded /v1/chat/completions to an upstream
 * that has no such path → 404 / hang → the 60s client abort on phrasing and
 * empty results on title.
 *
 * Fix: reuse the SAME model + transport the agent used at runtime. The resolved
 * `model` object already carries provider, baseUrl (relay-facing when
 * use_relay), apiKey, protocol, and compat — exactly the routing the agent had.
 * We call `completeSimple` (pi-ai's own one-shot primitive — the same call
 * branch-summarization and compaction use) so the body is built by the
 * transport's SDK, protocol-correct by construction. No hand-rolled body, no
 * /v1/chat/completions assumption, no relay protocol mismatch.
 *
 * Auth: the apiKey/headers come from `modelRegistry.getApiKeyAndHeaders(model)`
 * — the same resolution the agent's session used. For custom providers
 * registered via the registry, that returns the profile's api_key; the SDK
 * attaches the transport-appropriate header (Bearer / x-api-key / x-goog-api-key)
 * itself. We pass `apiKey` + `headers` through, identical to branch-summarization.
 */

/** Shared abort signal with a generous cap so a slow upstream can't hang the run. */
function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timeout) };
}

/** Pull concatenated text out of a pi-ai AssistantMessage (ignoring thinking blocks). */
function assistantText(msg: { content?: Array<{ type?: string; text?: string }> }): string {
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b) => b?.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

/**
 * Generate a concise GitHub issue title from the agent's findings via a single
 * model call using the run's resolved model + transport. Falls back to a
 * template title on any failure (relay down, model error, empty result) so a
 * cron run is never blocked by title generation.
 *
 * Uses the run's resolved profile (the model that just ran the sweep) so
 * there's no extra config — the same model summarises its own findings, over
 * the same transport the agent used.
 */

const SYSTEM_PROMPT =
  "You write concise GitHub issue titles. Given an agent's findings, output ONE " +
  "title (a single line, max ~80 chars, no quotes, no trailing period, no prefix " +
  "like 'Bug:' or 'Issue:'). Summarise the core finding, not the task. Output " +
  "ONLY the title text — nothing else.";

/** Inputs the post-run LLM calls need from the run that just finished. */
export interface RunLlmContext {
  /** The resolved pi-ai model the agent used (carries provider/baseUrl/protocol/compat). */
  model: Model<Api>;
  /** The registry the run built (resolves apiKey + headers for the model). */
  modelRegistry: ModelRegistry;
}

export async function generateIssueTitle(
  agentMessage: string,
  task: string,
  ctx: RunLlmContext,
): Promise<string> {
  // Resolve auth once — the registry caches this.
  let apiKey: string | undefined;
  let headers: Record<string, string> | undefined;
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (auth.ok) {
      apiKey = auth.apiKey;
      headers = auth.headers;
    } else {
      throw new Error(auth.error);
    }
  } catch (e) {
    log.warn({ err: (e as Error).message }, "issue title generation failed; falling back to template");
    return templateTitle(task);
  }

  // Trim the message — a long findings dump wastes tokens for a one-line title.
  const excerpt = agentMessage.slice(0, 4000);
  const userContent =
    `Task was: ${task.trim().slice(0, 200)}\n\nAgent findings:\n${excerpt}\n\n` +
    `Write ONE concise issue title (max ~80 chars) summarising the core finding.` +
    (agentMessage.length > 4000 ? "\n(findings truncated)" : "");

  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
  };

  const { signal, cancel } = withTimeout(45_000);
  try {
    const response = await completeSimple(ctx.model, context, {
      apiKey,
      headers,
      // A title is a few tokens — cap tightly so the model doesn't ramble.
      maxTokens: 60,
      temperature: 0.3,
      signal,
    });
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "title call errored");
    }
    const raw = assistantText(response);
    const title = cleanTitle(raw);
    if (!title) throw new Error("model returned empty title");
    log.debug({ title, model: ctx.model.id }, "generated issue title");
    return title;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "issue title generation failed; falling back to template");
    return templateTitle(task);
  } finally {
    cancel();
  }
}

/**
 * Normalise the model's title output: strip surrounding quotes, collapse
 * whitespace, trim any leading prefix like "Title:" or "Bug:", cap at 80 chars
 * on a word boundary so it fits cleanly in a triage list.
 */
function cleanTitle(raw: string): string {
  let t = raw.trim();
  // Drop a leading label the model sometimes adds despite instructions.
  t = t.replace(/^(title|issue|bug|finding)\s*[:\-]\s*/i, "");
  // Strip wrapping quotes.
  t = t.replace(/^["'`]|["'`]$/g, "");
  t = t.replace(/\s+/g, " ").trim();
  // Cap at 80 chars on a word boundary.
  if (t.length > 80) {
    const cut = t.slice(0, 77);
    const lastSpace = cut.lastIndexOf(" ");
    t = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + "…";
  }
  return t;
}

/**
 * Fallback title (first line of the task, capped) used when the model call
 * fails or the run errored (no findings to summarise). Never throws.
 * Exported for the cron run's errored path.
 */
export function templateTitle(task: string): string {
  const firstLine = task.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  const head = firstLine ? (firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine) : "scheduled sweep";
  return head;
}

// --- output phrasing -------------------------------------------------------

/**
 * System prompt for phrasing the agent's raw final message into a clean GitHub
 * comment / commit body. The constraint is critical: CLEAN THE FORMATTING, DO
 * NOT SUMMARISE. Every technical detail, finding, and decision the agent made
 * must survive — only the presentation changes (strip tool-call residue, fix
 * headings, tighten prose, drop meta-chatter like "I'll now examine...").
 */
const PHRASE_SYSTEM_PROMPT =
  "You format an AI coding agent's raw output into a clean GitHub issue comment / " +
  "PR body. PRESERVE EVERY TECHNICAL DETAIL — do not summarise, shorten, or drop " +
  "any finding, code reference, file path, or decision. Only clean the presentation: " +
  "remove tool-call residue and status chatter (e.g. 'Let me check...', 'Running grep...'), " +
  "fix markdown headings and lists, tighten redundant prose, and ensure it reads as a " +
  "coherent message from the agent. Output ONLY the cleaned message in markdown — no " +
  "preamble, no 'Here is the cleaned version:', no explanation of what you changed.";

/**
 * Phrase the agent's raw final message into a clean GitHub comment / PR body via
 * a single model call using the run's resolved model + transport. Sibling to
 * `generateIssueTitle` — same model + registry pattern, but a much larger token
 * budget (the full answer, not a one-line title) and a system prompt that
 * CLEANS WITHOUT SUMMARISING.
 *
 * Falls back to the raw agent message on any failure (relay down, model error,
 * empty result) so a run is never blocked by phrasing. This is the safety net:
 * the raw answer is always acceptable; phrasing is a polish step.
 *
 * Uses the run's resolved profile (the model that just ran) so there's no extra
 * config — the same model cleans its own output, over the same transport.
 *
 * Returns the phrased message, or the original `agentMessage` unchanged on any
 * failure. Never throws.
 */
export async function phraseOutput(
  agentMessage: string,
  ctx: RunLlmContext,
): Promise<string> {
  const original = agentMessage.trim();
  if (!original) return original;

  // Resolve auth once — the registry caches this.
  let apiKey: string | undefined;
  let headers: Record<string, string> | undefined;
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (auth.ok) {
      apiKey = auth.apiKey;
      headers = auth.headers;
    } else {
      throw new Error(auth.error);
    }
  } catch (e) {
    log.warn({ err: (e as Error).message }, "output phrasing failed; posting raw agent message");
    return original;
  }

  const context: Context = {
    systemPrompt: PHRASE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: original, timestamp: Date.now() }],
  };

  // Generous budget — we're cleaning a full message, not summarising it.
  // Cap at 4x the input length (min 512) so the model has room to reformat
  // without truncating the content.
  const maxTokens = Math.max(512, Math.min(8192, original.length * 4));
  const { signal, cancel } = withTimeout(120_000);
  try {
    const response = await completeSimple(ctx.model, context, {
      apiKey,
      headers,
      maxTokens,
      temperature: 0.2,
      signal,
    });
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "phrasing call errored");
    }
    const phrased = assistantText(response).trim();
    if (!phrased) throw new Error("model returned empty phrasing");
    log.debug({ model: ctx.model.id, origLen: original.length, phrasedLen: phrased.length }, "phrased agent output");
    return phrased;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "output phrasing failed; posting raw agent message");
    return original;
  } finally {
    cancel();
  }
}
