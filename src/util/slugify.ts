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
