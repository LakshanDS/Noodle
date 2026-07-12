/**
 * Shared slash-trigger matching for the command wake model.
 *
 * Both webhook parsing (`src/github/webhook.ts`) and the trigger gate
 * (`src/triggers/check.ts`) need to answer "does this text contain `/<x>`
 * for any active command trigger `x`?". Centralising the matcher keeps the
 * two wake paths in sync — and in sync with `resolveCommand`, which uses the
 * same `(?:^|\s)/word\b` shape.
 */

/** Escape a string for safe use inside a RegExp atom. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `text` contain a `/<trigger>` standalone token for any of `triggers`?
 * Matches at start-of-text or after whitespace, with a trailing word boundary,
 * case-insensitive. Mirrors `resolveCommand` / `matchesSlash` deliberately.
 *
 *   matchesCommandTrigger("/noodle fix it", ["noodle"])      → true
 *   matchesCommandTrigger("hello /question", ["question"])   → true
 *   matchesCommandTrigger("/noodles", ["noodle"])            → false (boundary)
 *   matchesCommandTrigger("", ["noodle"])                    → false
 */
export function matchesCommandTrigger(text: string, triggers: string[]): boolean {
  if (!text || triggers.length === 0) return false;
  const atoms = triggers.filter((t) => t && t.length > 0).map((t) => `/${reEscape(t)}`);
  if (atoms.length === 0) return false;
  const re = new RegExp(`(?:^|\\s)(?:${atoms.join("|")})\\b`, "i");
  return re.test(text);
}

/**
 * Anchored-at-start variant for the webhook `issue_comment.created` path,
 * which historically only wakes on a `/<agent>` at the very start of the
 * comment (`^/<slug>\b`). We keep that anchor so a casual `/question`
 * buried mid-paragraph in a new comment still wakes (matching today's
 * `shouldTrigger` behaviour), but a trigger that is plainly a reply
 * ("sure, /noodle then") also qualifies because it leads the comment.
 *
 * In practice both call sites now use the looser `matchesCommandTrigger`;
 * this anchored form is exported for the webhook's back-compat fallback.
 */
export function leadsWithCommandTrigger(text: string, triggers: string[]): boolean {
  if (!text || triggers.length === 0) return false;
  const atoms = triggers.filter((t) => t && t.length > 0).map((t) => `/${reEscape(t)}`);
  if (atoms.length === 0) return false;
  const re = new RegExp(`^(?:${atoms.join("|")})\\b`, "i");
  return re.test(text);
}
