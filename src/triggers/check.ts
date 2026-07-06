import { slugify } from "../util/slugify.js";

/**
 * How the agent wakes up on an issue, read from `config.triggers`:
 *
 *   - `trigger_on_mention` — fire when body/comments @-mention the agent
 *   - `trigger_keywords`   — substrings (case-insensitive) that also fire
 *   - `trigger_on_open`    — fire on any open/reopen/label, ignoring filters
 *
 * Slash commands (`/<agent>` in a new comment) and `assigned to the agent`
 * are ALWAYS triggers — they live in their own event handlers and are not
 * gated by this config.
 */
export interface TriggerConfig {
  trigger_on_mention: boolean;
  trigger_keywords: string[];
  trigger_on_open: boolean;
}

/**
 * Substring match for a configured trigger keyword — case-insensitive.
 *
 * A `null`/empty `triggers` (e.g. internal callers that don't have a config
 * yet, or an explicit "fire on everything" mode) returns true via
 * `trigger_on_open` filter fallthrough; see `shouldTrigger`.
 */
function matchesKeyword(haystack: string, keyword: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(keyword.toLowerCase());
}

/**
 * Did this text explicitly @-mention the agent? Matches `@Noodle`, `@noodle`,
 * `@noodle-agent`, `@noodle_agent`, `@noodle[bot]`, and `@<Agent Name>` as
 * well. Case-insensitive; word-boundary-aware on the slug so `@noodles`
 * doesn't match `@noodle`.
 *
 * "Agent Name" matches via the exact name too (e.g. @Noodle) so a typed-out
 * name in prose ("@Noodle can you fix this?") still wakes the agent.
 *
 * Matched REGEX: `/(?:^|\s)@(?:<name>|<slug>|<slug>[-_ ]agent|...)\b/i`.
 * Kept short — agent names are short and we don't want to pay for a regex
 * compile per call; the strings are precomputed.
 */
export function mentionsAgent(text: string, agentName: string): boolean {
  if (!text) return false;
  const names: string[] = [];
  const direct = agentName.trim();
  if (direct) names.push(direct);
  // Also match the slug (e.g. "Noodle" → @noodle, @noodle-agent, @noodle_agent).
  const slug = slugify(agentName);
  if (slug) names.push(slug);
  // Bot-login variants for the agent's own GitHub login (e.g. "noodle-agent").
  if (slug) names.push(`${slug}-agent`, `${slug}_agent`, `${slug}-bot`, `${slug}_bot`);

  if (names.length === 0) return false;
  // Escape regex metachars in each candidate name, then OR them inside an
  // atom; require a leading start-or-whitespace so embedded substrings
  // (e.g. "email@Noodle") don't trip it. Trailing `\b` keeps us off the
  // tail end of unrelated words.
  const pat = names
    .filter((n) => n.length > 0)
    .map((n) => `@${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    .join("|");
  // (?<![\w@]) — left boundary that doesn't allow another word char or @
  // immediately before, so "email@Noodle" doesn't match but " @Noodle" does.
  // (?:pat) — the candidate set above. \b — right boundary.
  const re = new RegExp(`(?<![\\w@])(?:${pat})\\b`, "i");
  return re.test(text);
}

/**
 * Did the issue thread (body + comments) carry any wake signal per the
 * configured `triggers`?
 *
 * Returns true when:
 *   - `trigger_on_open` is set (always-fire mode; opt-out for power users), OR
 *   - the @-mention filter is set and at least one of body/comments mentions
 *     the agent, OR
 *   - at least one of `trigger_keywords` appears in body or a comment, OR
 *   - at least one of body/comments contains `/<agent-slug>` (the same slash
 *     command honored by the webhook layer). This is always a wake signal
 *     regardless of `trigger_on_mention` / `trigger_keywords` — slash
 *     commands are explicit intent and aren't gated.
 *
 * Returns false when NONE of the above match — the issue should NOT wake the
 * agent under the standard strategy.
 *
 * Pure — no I/O. Used by:
 *   - `github/webhook.ts` (webhook gating on the issues.* payload)
 *   - `server/scheduler.ts` (cron scan filter)
 *   - `engine/run.ts`    (defense in depth — even if the upstream gate let
 *                         it through, we re-check the full thread here so
 *                         stale webhooks / same-PR re-runs don't drift past
 *                         the policy).
 */
export function shouldTrigger(opts: {
  body: string;
  comments: string[];
  agentName: string;
  triggers: TriggerConfig;
}): boolean {
  const { body, comments, agentName, triggers } = opts;

  if (triggers.trigger_on_open) return true;

  const haystack = [body, ...comments].filter((s) => typeof s === "string" && s.length > 0);
  if (haystack.length === 0) return false;

  if (triggers.trigger_on_mention) {
    for (const t of haystack) {
      if (mentionsAgent(t, agentName)) return true;
    }
  }

  if (triggers.trigger_keywords.length > 0) {
    for (const t of haystack) {
      // Skip blanks defensively — matchesKeyword already handles them.
      for (const kw of triggers.trigger_keywords) {
        if (matchesKeyword(t, kw)) return true;
      }
    }
  }

  // Slash command is an always-on trigger (independent of the above gates)
  // — same logic the webhook layer uses to scope `issue_comment.created`.
  // Matches `/noodle`, `/Noodle`, `/noodle please`, but not `/noodles`.
  const slug = slugify(agentName);
  if (slug) {
    const slashRe = new RegExp(`(?:^|\\s)\\/${slug}\\b`, "i");
    for (const t of haystack) {
      if (slashRe.test(t)) return true;
    }
  }

  return false;
}
