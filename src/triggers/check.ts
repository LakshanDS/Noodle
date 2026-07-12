import { slugify } from "../util/slugify.js";
import { matchesCommandTrigger } from "../commands/match.js";

/**
 * How the agent wakes up on an issue, read from `config.triggers`:
 *
 *   - `trigger_on_mention` — fire when body/comments @-mention the agent
 *   - `trigger_keywords`   — substrings (case-insensitive) that also fire
 *   - `trigger_on_open`    — fire on any open/reopen/label, ignoring filters
 *
 * Slash commands (`/<agent>` in a new comment) and `assigned to the agent`
 * are ALWAYS triggers — they live in their own event handlers and are not
 * gated by this config. A `#<profile-name>` tag is also an always-on trigger
 * (it both wakes AND selects a profile).
 */
export interface TriggerConfig {
  trigger_on_mention: boolean;
  trigger_keywords: string[];
  trigger_on_open: boolean;
}

/** Escape a string for safe use inside a RegExp atom. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Did this text explicitly @-mention the agent? Matches `@Noodle`, `@noodle`,
 * `@noodle-agent`, `@noodle_agent`, `@noodle[bot]`, case-insensitive; word
 * boundary on the slug so `@noodles` doesn't match `@noodle`. The lookbehind
 * `(?<![\w@])` rejects embedded mentions like `email@noodle` — there must be
 * start, whitespace, or a non-word char immediately before the `@`.
 *
 * "Agent Name" matches via the exact name too (e.g. @Noodle) so a typed-out
 * name in prose ("@Noodle can you fix this?") still wakes the agent.
 */
export function mentionsAgent(text: string, agentName: string): boolean {
  if (!text) return false;
  const names: string[] = [];
  const direct = agentName.trim();
  if (direct) names.push(direct);
  const slug = slugify(agentName);
  if (slug) names.push(slug);
  // Bot-login variants for the agent's own GitHub login (e.g. "noodle-agent").
  if (slug) names.push(`${slug}-agent`, `${slug}_agent`, `${slug}-bot`, `${slug}_bot`);
  if (names.length === 0) return false;

  const pat = names.filter((n) => n.length > 0).map((n) => `@${reEscape(n)}`).join("|");
  const re = new RegExp(`(?<![\\w@])(?:${pat})\\b`, "i");
  return re.test(text);
}

/**
 * Find a `#<profile>` tag in the text that names a *configured* profile. The
 * match is anchored to a real profile name (so `#123` issue refs and `# heading`
 * markdown never collide), case-insensitive, with a leading start/whitespace
 * boundary so `code#foo` doesn't trip it. Returns the first matching profile
 * name (in configured order), or null when none match.
 *
 *   extractProfileTag("#claude fix this", ["claude","nim"]) → "claude"
 *   extractProfileTag("#123",                ["claude"])     → null
 *   extractProfileTag("see #123",            ["claude"])     → null
 */
export function extractProfileTag(text: string, profileNames: string[]): string | null {
  if (!text || profileNames.length === 0) return null;
  for (const name of profileNames) {
    if (!name) continue;
    // `#name` preceded by start or whitespace. Trailing `\b` so `#claudex`
    // doesn't match `claude`.
    const re = new RegExp(`(?:^|\\s)#${reEscape(name)}\\b`, "i");
    if (re.test(text)) return name;
  }
  return null;
}

export interface TriggerResult {
  /** Whether the configured wake signal accepts this thread. */
  wake: boolean;
  /** A `#<profile>` tag found in body or a comment, when present. */
  profile: string | null;
}

/**
 * Did the issue thread (body + comments) carry any wake signal per the
 * configured `triggers`, and did it carry a `#<profile>` selection?
 *
 * `wake` is true when any of:
 *   - `trigger_on_open` is set (always-fire mode), OR
 *   - `trigger_on_mention` is set and body/comments @-mention the agent, OR
 *   - a `trigger_keyword` appears in body or a comment, OR
 *   - a `/<agent>` slash command appears, OR
 *   - a `#<configured-profile>` tag appears (always a wake — naming a profile
 *     is explicit intent).
 *
 * `profile` is the configured profile named by a `#tag`, scanned in body then
 * comments in order; null when no tag matches a configured profile.
 *
 * Pure — no I/O. Used by webhook gating, the scheduler scan filter, and
 * defense-in-depth inside `engine/run.ts`.
 */
export function shouldTrigger(opts: {
  body: string;
  comments: string[];
  agentName: string;
  triggers: TriggerConfig;
  profileNames?: string[];
  /**
   * Active command triggers (from the command store). Any `/<trigger>` in the
   * thread is an always-on wake. When omitted, falls back to just `/<agent-slug>`.
   */
  commandTriggers?: string[];
}): TriggerResult {
  const { body, comments, agentName, triggers } = opts;
  const profileNames = opts.profileNames ?? [];

  // `#<profile>` selection — independent of the wake gates below. Checked
  // across body then comments; first configured profile wins.
  let profile: string | null = null;
  const thread = [body, ...comments].filter((s) => typeof s === "string" && s.length > 0);
  for (const t of thread) {
    profile = extractProfileTag(t, profileNames);
    if (profile) break;
  }

  let wake = false;
  if (triggers.trigger_on_open) {
    wake = true;
  } else {
    if (triggers.trigger_on_mention) {
      wake ||= thread.some((t) => mentionsAgent(t, agentName));
    }
    if (!wake && triggers.trigger_keywords.length > 0) {
      for (const t of thread) {
        wake ||= triggers.trigger_keywords.some((kw) =>
          kw && t.toLowerCase().includes(kw.toLowerCase()),
        );
        if (wake) break;
      }
    }
    if (!wake) {
      // A `/<command>` slash command for any active command is always a wake
      // (explicit intent), ungated by trigger_on_mention / trigger_keywords.
      // Falls back to just `/<agent-slug>` when no command triggers supplied.
      const slug = slugify(agentName);
      const cmdTriggers = opts.commandTriggers && opts.commandTriggers.length > 0
        ? opts.commandTriggers
        : slug
          ? [slug]
          : [];
      if (slug && !cmdTriggers.includes(slug)) cmdTriggers.push(slug);
      if (cmdTriggers.length > 0) {
        wake ||= thread.some((t) => matchesCommandTrigger(t, cmdTriggers));
      }
    }
  }

  // A `#<profile>` tag is itself a wake signal regardless of the gates.
  if (!wake && profile) wake = true;

  return { wake, profile };
}
