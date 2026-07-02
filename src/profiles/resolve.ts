import type { NoodleConfig, RoutingRule } from "../config/schema.js";
import type { IssueInput, ResolvedProfile } from "./types.js";

/**
 * Decide which profile runs for an issue. Evaluation order (first match wins):
 *   1. `/word` slash command in issue body, then comments
 *   2. label rules
 *   3. keyword regex (matched against title + body)
 *   4. default_profile (per-repo override if present, else global)
 *
 * Pure function — no I/O, deterministic. Easy to unit-test.
 */
export function resolveProfile(
  config: NoodleConfig,
  issue: IssueInput,
  repo?: string,
): ResolvedProfile {
  const effectiveDefault = repo
    ? (config.repos[repo]?.default_profile ?? config.default_profile)
    : config.default_profile;

  const pick = (name: string): ResolvedProfile => {
    const p = config.profiles[name];
    if (!p) {
      // fall back rather than crash if a configured profile vanished
      const fallback = config.profiles[effectiveDefault];
      if (!fallback) throw new Error(`No profile "${name}" and no valid default "${effectiveDefault}"`);
      return { name: effectiveDefault, ...fallback };
    }
    return { name, ...p };
  };

  // 1. slash commands — scan body first, then comments in order.
  for (const rule of byKind(config.routing, "slash")) {
    if (matchesSlash(rule, issue.body) || issue.comments.some((c) => matchesSlash(rule, c))) {
      return pick(rule.profile);
    }
  }

  // 2. labels — exact, case-insensitive.
  const labels = new Set(issue.labels.map((l) => l.toLowerCase()));
  for (const rule of byKind(config.routing, "label")) {
    if (labels.has(rule.match.toLowerCase())) {
      return pick(rule.profile);
    }
  }

  // 3. keyword regex against title + body.
  const hay = `${issue.title}\n${issue.body}`;
  for (const rule of byKind(config.routing, "keyword")) {
    try {
      if (new RegExp(rule.match, "i").test(hay)) {
        return pick(rule.profile);
      }
    } catch {
      // bad regex in config is reported at config-load time; skip here.
    }
  }

  // 4. default.
  return pick(effectiveDefault);
}

function byKind(rules: RoutingRule[], kind: RoutingRule["kind"]): RoutingRule[] {
  return rules.filter((r) => r.kind === kind);
}

/** A slash rule matches if `/word` appears as a standalone token. */
function matchesSlash(rule: RoutingRule, text: string): boolean {
  if (!text) return false;
  // word-boundary-ish: preceded by start/whitespace, the literal command.
  const escaped = rule.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\s)${escaped}\\b`, "i");
  return re.test(text);
}
