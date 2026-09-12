import { log } from "../util/log.js";
import type { Model, Api, Context } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * The generic final LLM pass for post-run output shaping — issue/PR titles,
 * comment/PR-body phrasing, and any future "ask the model one more time at the
 * end" step. Everything final-output-shaped funnels through `runFinalPass`.
 *
 * Why it looks like this (history): early versions hand-rolled an OpenAI Chat
 * Completions body and POSTed it to the relay at /v1/chat/completions — which
 * only worked when the profile's transport was itself openai-completions. Any
 * other protocol (anthropic-messages, mistral-conversations,
 * google-generative-ai) forwarded /v1/chat/completions to an upstream with no
 * such path → relay 404s, and a missing auth header → relay 401s. Both failure
 * classes are visible in the Jul 20-21 noodle.log.
 *
 * Fix: reuse the SAME model + transport the agent used at runtime. The resolved
 * `model` carries provider, baseUrl (relay-facing when use_relay), apiKey,
 * protocol, and compat — exactly the routing the agent had. `completeSimple`
 * (pi-ai's one-shot primitive, same call branch-summarization uses) builds the
 * body via the transport's SDK, so it is protocol-correct by construction.
 * Auth comes from `modelRegistry.getApiKeyAndHeaders(model)` — the same
 * resolution the agent's session used; the SDK attaches the
 * transport-appropriate header itself.
 *
 * Thinking is deliberately NOT enabled (no `reasoning` option): pi-ai's
 * transports then send no reasoning params at all, keeping the one-shot cheap
 * and its output deterministic. maxTokens is generous anyway — it's a cap, not
 * a target, and one shaping call at the end of a full agent run is noise.
 */

/** Inputs the final pass needs from the run that just finished. */
export interface FinalPassContext {
  /** The resolved pi-ai model the agent used (carries provider/baseUrl/protocol/compat). */
  model: Model<Api>;
  /** The registry the run built (resolves apiKey + headers for the model). */
  modelRegistry: ModelRegistry;
}

export interface FinalPassRequest {
  /** Log label identifying the shaping step (e.g. "issue title"). */
  label: string;
  system: string;
  input: string;
  maxTokens: number;
  temperature?: number;
  /** Abort cap so a slow upstream can't hang the run. */
  timeoutMs?: number;
}

/**
 * Make one transport-correct LLM call and return its text, or null on ANY
 * failure (auth unresolvable, relay down, model error, empty output, timeout).
 * Never throws — the caller always has a fallback.
 */
export async function runFinalPass(
  ctx: FinalPassContext,
  req: FinalPassRequest,
): Promise<string | null> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) {
    log.warn({ err: auth.error, pass: req.label }, "final LLM pass could not resolve auth; using fallback");
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 60_000);
  try {
    const context: Context = {
      systemPrompt: req.system,
      messages: [{ role: "user", content: req.input, timestamp: Date.now() }],
    };
    const response = await completeSimple(ctx.model, context, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: req.maxTokens,
      temperature: req.temperature ?? 0.2,
      signal: controller.signal,
    });
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "final pass call errored");
    }
    const text = assistantText(response).trim();
    if (!text) throw new Error("model returned empty output");
    log.debug({ pass: req.label, model: ctx.model.id }, "final LLM pass done");
    return text;
  } catch (e) {
    log.warn({ err: (e as Error).message, pass: req.label, model: ctx.model.id }, "final LLM pass failed; using fallback");
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Pull concatenated text out of a pi-ai AssistantMessage (ignoring thinking blocks). */
function assistantText(msg: { content?: Array<{ type?: string; text?: string }> }): string {
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b) => b?.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

// --- issue / PR titles ------------------------------------------------------

const TITLE_SYSTEM_PROMPT =
  "You write concise GitHub issue titles. Given an agent's findings, output ONE " +
  "title (a single line, 30-50 chars, no quotes, no trailing period, no prefix " +
  "like 'Bug:' or 'Issue:'). Summarise the core finding, not the task. Output " +
  "ONLY the title text — nothing else.";

/** How the tagged output titles render: `Noodle Issue - <short>` / `Noodle PR - <short>`. */
export type TitleKind = "issue" | "pr";

export interface TitleOptions {
  /** Which output the title is for — picks the tag line. Default "issue". */
  kind?: TitleKind;
  /** Agent slug for the tag line (e.g. "noodle" → "Noodle"). */
  agentName?: string;
}

/** Capitalised agent name for title tag lines. */
function titleTag(agentName?: string): string {
  const n = (agentName ?? "noodle").trim() || "noodle";
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/**
 * Generate the final output title: a 30-50 char core title from the agent's
 * findings via `runFinalPass`, wrapped in the tag line — `Noodle Issue - <short>`
 * for issues, `Noodle PR - <short>` for PRs. Falls back to the (untagged)
 * template title on any failure so a run is never blocked by title generation.
 */
export async function generateIssueTitle(
  agentMessage: string,
  task: string,
  ctx: FinalPassContext,
  opts?: TitleOptions,
): Promise<string> {
  // Trim the message — a long findings dump wastes tokens for a one-line title.
  const excerpt = agentMessage.slice(0, 4000);
  const input =
    `Task was: ${task.trim().slice(0, 200)}\n\nAgent findings:\n${excerpt}\n\n` +
    `Write ONE concise issue title (30-50 chars) summarising the core finding.` +
    (agentMessage.length > 4000 ? "\n(findings truncated)" : "");

  const title = await runFinalPass(ctx, {
    label: "issue title",
    system: TITLE_SYSTEM_PROMPT,
    input,
    maxTokens: 1024,
    temperature: 0.3,
    timeoutMs: 45_000,
  });
  // A failed call falls back to the bare template — it's operational text,
  // not a findings summary, so it stays untagged.
  if (!title) return templateTitle(task);
  const short = cleanTitle(title) || templateTitle(task);
  return opts?.kind === "pr"
    ? `${titleTag(opts?.agentName)} PR - ${short}`
    : `${titleTag(opts?.agentName)} Issue - ${short}`;
}

/**
 * Normalise the model's title output: strip <think> blocks, surrounding
 * quotes, leading "Title:"/"Bug:" prefixes; collapse whitespace; cap at 50
 * chars — at a clause boundary (`,` `—` `:` `;`) when one exists in the
 * window, else on a word boundary.
 */
function cleanTitle(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // Drop a leading label the model sometimes adds despite instructions.
  t = t.replace(/^(title|issue|bug|finding)\s*[:\-]\s*/i, "");
  // Strip wrapping quotes.
  t = t.replace(/^["'`]|["'`]$/g, "");
  t = t.replace(/\s+/g, " ").trim();
  const MAX = 50;
  if (t.length <= MAX) return t;
  const window = t.slice(0, MAX - 1);
  // Prefer the last clause break in the window; drop the dangling tail.
  const clauseCut = Math.max(window.lastIndexOf(","), window.lastIndexOf("—"), window.lastIndexOf(":"), window.lastIndexOf(";"));
  if (clauseCut > 20) return window.slice(0, clauseCut).replace(/[\s,;:—-]+$/, "").trim();
  // No clause break — cut on a word boundary.
  const lastSpace = window.lastIndexOf(" ");
  return (lastSpace > 25 ? window.slice(0, lastSpace) : window).trim() + "…";
}

/**
 * Fallback title (first line of the task, capped to the 50-char title budget)
 * used when the title call fails or the run errored (no findings to
 * summarise). Never throws.
 */
export function templateTitle(task: string): string {
  const firstLine = task.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  const head = firstLine ? (firstLine.length > 50 ? firstLine.slice(0, 47) + "…" : firstLine) : "scheduled sweep";
  return head;
}

// --- output phrasing --------------------------------------------------------

/**
 * System prompt for phrasing the agent's raw final message into the delivered
 * GitHub comment / PR body. Two constraints are critical: (1) PRESERVE EVERY
 * TECHNICAL DETAIL — only the presentation changes; (2) STRUCTURE for
 * skimmability — every distinct finding gets its own section so a reader
 * scanning the issue gets the picture without reading prose.
 */
const PHRASE_SYSTEM_PROMPT =
  "You format an AI coding agent's raw output into a clean, skimmable GitHub " +
  "issue comment / PR body. PRESERVE EVERY TECHNICAL DETAIL — do not summarise, " +
  "shorten, or drop any finding, code reference, file path, or decision. Only " +
  "restructure and clean the presentation.\n\n" +
  "Structure the message so a skim gives the full picture:\n" +
  "- Open with a '## Summary' section: 1-3 sentences stating what the run " +
  "found or did.\n" +
  "- Then ONE '## <short label>' section per distinct finding or topic the " +
  "agent reported, numbered when there are several ('## 1. <finding name>'). " +
  "Order by severity/importance when the agent signals it.\n" +
  "- Inside each section keep ALL of the agent's detail: what's wrong, where " +
  "(file + line), evidence, and suggested fix. Use short bold lead-ins " +
  "('**Where:**', '**Fix:**') when the prose implies them.\n" +
  "- Keep code, file paths, and commands in backticks / fenced blocks.\n" +
  "- If the agent reported nothing concrete, say so plainly in one short " +
  "section instead of inventing structure.\n\n" +
  "Cleaning rules: remove tool-call residue and status chatter (e.g. 'Let me " +
  "check...', 'Running grep...'), fix broken markdown headings and lists, " +
  "tighten redundant prose. Never add information the agent didn't give.\n\n" +
  "Output ONLY the formatted markdown — no preamble, no 'Here is the cleaned " +
  "version:', no explanation of what you changed.";

/**
 * Phrase the agent's raw final message into a clean GitHub comment / PR body
 * via `runFinalPass`. Falls back to the raw agent message on any failure —
 * the raw answer is always acceptable; phrasing is a polish step. Never throws.
 */
export async function phraseOutput(
  agentMessage: string,
  ctx: FinalPassContext,
): Promise<string> {
  const original = agentMessage.trim();
  if (!original) return original;

  // Generous budget — we're cleaning a full message, not summarising it.
  // Cap at 4x the input length (min 512) so the model has room to reformat
  // without truncating the content.
  const phrased = await runFinalPass(ctx, {
    label: "output phrasing",
    system: PHRASE_SYSTEM_PROMPT,
    input: original,
    maxTokens: Math.max(512, Math.min(8192, original.length * 4)),
    timeoutMs: 120_000,
  });
  return phrased ?? original;
}
