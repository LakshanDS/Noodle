import type { CommandRow } from "../server/command-store.js";
import type { IssueInput } from "../profiles/types.js";

/**
 * Pick the command whose `/<trigger>` appears in the issue. Scans the issue
 * body first, then comments in order; the first matching command (in store
 * id order, so the built-in default loses only to a more specific command
 * that actually appears in the text) wins.
 *
 * Mirrors `resolveProfile`'s purity: no I/O, deterministic, easy to unit-test.
 * Only enabled commands are considered — the engine is expected to pre-filter
 * the `commands` list (or pass the full list; we guard here too).
 *
 * Returns null when nothing matches — the caller then falls back to the
 * built-in default command's framing (or today's `buildPrompt` behaviour).
 */
export function resolveCommand(
  commands: CommandRow[],
  issue: IssueInput,
): CommandRow | null {
  const ordered = commands.filter((c) => c.enabled === 1).sort((a, b) => a.id - b.id);
  if (ordered.length === 0) return null;

  const texts = [issue.body ?? "", ...(issue.comments ?? [])];
  for (const text of texts) {
    for (const cmd of ordered) {
      if (matchesTrigger(cmd.trigger, text)) return cmd;
    }
  }
  return null;
}

/**
 * A trigger matches if `/<trigger>` appears as a standalone token — preceded
 * by start or whitespace, followed by a word boundary. Same shape as the
 * existing `matchesSlash` in profile routing, kept in sync deliberately.
 */
function matchesTrigger(trigger: string, text: string): boolean {
  if (!text || !trigger) return false;
  const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\s)/${escaped}\\b`, "i");
  return re.test(text);
}
