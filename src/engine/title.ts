import { log } from "../util/log.js";
import type { NoodleConfig, Profile } from "../config/schema.js";

/**
 * Generate a concise GitHub issue title from the agent's findings via a single
 * model call to the relay. The relay is already running in serve mode and routes
 * by model name → profile → API key + rate limit, so we just POST an
 * OpenAI-style chat completion with a short system prompt. Falls back to a
 * template title on any failure (relay down, model error, empty result) so a
 * cron run is never blocked by title generation.
 *
 * Uses the cron run's resolved profile (the model that just ran the sweep) so
 * there's no extra config — the same model summarises its own findings.
 */

const SYSTEM_PROMPT =
  "You write concise GitHub issue titles. Given an agent's findings, output ONE " +
  "title (a single line, max ~80 chars, no quotes, no trailing period, no prefix " +
  "like 'Bug:' or 'Issue:'). Summarise the core finding, not the task. Output " +
  "ONLY the title text — nothing else.";

export async function generateIssueTitle(
  agentMessage: string,
  task: string,
  config: NoodleConfig,
  profile: Profile,
  relayPort?: number,
): Promise<string> {
  const port = relayPort ?? config.relay?.port ?? 4445;
  const url = `http://localhost:${port}/v1/chat/completions`;

  // Trim the message — a long findings dump wastes tokens for a one-line title.
  const excerpt = agentMessage.slice(0, 4000);
  const userContent =
    `Task was: ${task.trim().slice(0, 200)}\n\nAgent findings:\n${excerpt}\n\n` +
    `Write ONE concise issue title (max ~80 chars) summarising the core finding.` +
    (agentMessage.length > 4000 ? "\n(findings truncated)" : "");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: profile.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        // A title is a few tokens — cap tightly so the model doesn't ramble.
        max_completion_tokens: 60,
        temperature: 0.3,
        stream: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`relay ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const title = cleanTitle(raw);
    if (!title) throw new Error("model returned empty title");
    log.debug({ title, model: profile.model }, "generated issue title");
    return title;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "issue title generation failed; falling back to template");
    return templateTitle(task);
  } finally {
    clearTimeout(timeout);
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
 * a single model call to the relay. Sibling to `generateIssueTitle` — same
 * relay-based pattern, but a much larger token budget (the full answer, not a
 * one-line title) and a system prompt that CLEANS WITHOUT SUMMARISING.
 *
 * Falls back to the raw agent message on any failure (relay down, model error,
 * empty result) so a run is never blocked by phrasing. This is the safety net:
 * the raw answer is always acceptable; phrasing is a polish step.
 *
 * Uses the run's resolved profile (the model that just ran) so there's no extra
 * config — the same model cleans its own output.
 *
 * Returns the phrased message, or the original `agentMessage` unchanged on any
 * failure. Never throws.
 */
export async function phraseOutput(
  agentMessage: string,
  config: NoodleConfig,
  profile: Profile,
  relayPort?: number,
): Promise<string> {
  const original = agentMessage.trim();
  if (!original) return original;

  const port = relayPort ?? config.relay?.port ?? 4445;
  const url = `http://localhost:${port}/v1/chat/completions`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: profile.model,
        messages: [
          { role: "system", content: PHRASE_SYSTEM_PROMPT },
          { role: "user", content: original },
        ],
        // Generous budget — we're cleaning a full message, not summarising it.
        // Cap at 4x the input length (min 512) so the model has room to
        // reformat without truncating the content.
        max_completion_tokens: Math.max(512, Math.min(8192, original.length * 4)),
        temperature: 0.2,
        stream: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`relay ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const phrased = (data.choices?.[0]?.message?.content ?? "").trim();
    if (!phrased) throw new Error("model returned empty phrasing");
    log.debug({ model: profile.model, origLen: original.length, phrasedLen: phrased.length }, "phrased agent output");
    return phrased;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "output phrasing failed; posting raw agent message");
    return original;
  } finally {
    clearTimeout(timeout);
  }
}
