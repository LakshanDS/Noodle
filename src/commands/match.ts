/**
 * Shared slash-trigger matching for the command wake model.
 *
 * Both webhook parsing (`src/github/webhook.ts`) and the trigger gate
 * (`src/triggers/check.ts`) need to answer "does this text contain `/<x>`
 * for any active command trigger `x`?". Centralising the matcher keeps the
 * two wake paths in sync — and in sync with `resolveCommand`, which uses the
 * same boundary shape.
 *
 * Boundary note: we use `(?![\w-])` (not followed by a word char or hyphen)
 * rather than `\b`. With `\b`, `/noodle` would match inside `/noodle-fix`
 * because `\b` treats the hyphen as a boundary — so the built-in `/noodle`
 * would shadow `/noodle-fix` and `/noodle-review`. `(?![\w-])` rejects that,
 * so `/noodle` only matches a standalone `/noodle` token.
 */

/** Escape a string for safe use inside a RegExp atom. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Trailing boundary: not followed by a word char or hyphen. */
const TRIGGER_TAIL = "(?![\\w-])";

/**
 * Remove fenced (``` … ``` and ~~~ … ~~~) and inline (`…`) code spans so a
 * `/trigger` that appears only inside a code example doesn't wake the agent.
 * Replaces each block with a space so word boundaries on either side are
 * preserved (e.g. "text `/noodle` more" → "text   more", not "textmore").
 *
 *   stripCodeBlocks("see `/noodle` in code")  → "see  in code"
 *   stripCodeBlocks("```\n/noodle\n```")      → " "
 */
export function stripCodeBlocks(text: string): string {
  if (!text) return text;
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

/**
 * Does `text` contain a `/<trigger>` standalone token for any of `triggers`?
 * Matches at start-of-text or after whitespace, with a trailing boundary that
 * rejects word chars and hyphens, case-insensitive.
 *
 *   matchesCommandTrigger("/noodle fix it", ["noodle"])      → true
 *   matchesCommandTrigger("hello /question", ["question"])   → true
 *   matchesCommandTrigger("/noodles", ["noodle"])            → false (boundary)
 *   matchesCommandTrigger("/noodle-fix", ["noodle"])         → false (hyphen is NOT a boundary)
 *   matchesCommandTrigger("", ["noodle"])                    → false
 */
export function matchesCommandTrigger(text: string, triggers: string[]): boolean {
  if (!text || triggers.length === 0) return false;
  const stripped = stripCodeBlocks(text);
  // Sort longest-first so a more specific trigger is preferred when one is a
  // prefix of another (e.g. test /noodle-fix before /noodle). For the boolean
  // wake check this is harmless, but it keeps the alternation deterministic.
  const atoms = triggers
    .filter((t) => t && t.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((t) => `/${reEscape(t)}`);
  if (atoms.length === 0) return false;
  const re = new RegExp(`(?:^|\\s)(?:${atoms.join("|")})${TRIGGER_TAIL}`, "i");
  return re.test(stripped);
}

/**
 * Anchored-at-start variant for the webhook `issue_comment.created` path,
 * which historically only wakes on a `/<agent>` at the very start of the
 * comment. Kept for the webhook's back-compat fallback; both call sites now
 * use the looser `matchesCommandTrigger`.
 */
export function leadsWithCommandTrigger(text: string, triggers: string[]): boolean {
  if (!text || triggers.length === 0) return false;
  const stripped = stripCodeBlocks(text);
  const atoms = triggers
    .filter((t) => t && t.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((t) => `/${reEscape(t)}`);
  if (atoms.length === 0) return false;
  const re = new RegExp(`^(?:${atoms.join("|")})${TRIGGER_TAIL}`, "i");
  return re.test(stripped);
}
