/**
 * Template tag expansion for the configurable system prompt.
 *
 * The operator writes a system prompt in the Settings page using {tag} syntax.
 * At run time, `expandTags` replaces each tag with live data:
 *
 *   {system}       — full system info block (CPU, RAM, platform, tier, guidance)
 *   {system.cpu}   — "CPU cores: N"
 *   {system.ram}   — "Memory: N MB total, N MB free (limit: N MB)"
 *   {system.os}    — platform string (e.g. "linux x64")
 *   {system.tier}  — "constrained" or "capable"
 *   {pr}           — all open PRs (one per line)
 *   {pr.0}         — first open PR (0-indexed)
 *   {issue}        — all open issues (one per line)
 *   {issue.0}      — first open issue (0-indexed)
 *
 * Unknown tags and tags that can't be resolved (API failure, index out of
 * range) expand to an empty string — the run never crashes because of a typo
 * or a transient GitHub API error.
 */

import type { GitHubClient, IssueData, PullRequestData } from "../github/client.js";
import { buildSysInfoGuidance, type SysFacts } from "../util/sysinfo.js";

export interface TagContext {
  sysFacts: SysFacts;
  gh: GitHubClient;
  repo: string;
}

/**
 * Scan `text` for {tag} patterns and replace each with its live-data expansion.
 * Returns the fully expanded string. PR/issue lists are fetched once per call
 * (cached) so {pr} + {pr.0} don't trigger two API round-trips.
 */
export async function expandTags(text: string, ctx: TagContext): Promise<string> {
  // Lazy caches — only populated when a {pr...} or {issue...} tag is encountered.
  let prCache: PullRequestData[] | null = null;
  let issueCache: IssueData[] | null = null;

  async function getPRs(): Promise<PullRequestData[]> {
    if (prCache !== null) return prCache;
    try {
      prCache = await ctx.gh.listOpenPRs(ctx.repo);
    } catch {
      prCache = [];
    }
    return prCache;
  }

  async function getIssues(): Promise<IssueData[]> {
    if (issueCache !== null) return issueCache;
    try {
      issueCache = await ctx.gh.listOpenIssues(ctx.repo);
    } catch {
      issueCache = [];
    }
    return issueCache;
  }

  // Match {word.word} or {word} or {word.number} patterns.
  // We process sequentially because PR/issue expansion is async.
  const tagPattern = /\{([a-z]+)(?:\.([a-z0-9]+))?\}/gi;
  const matches: { tag: string; sub: string | undefined; index: number; full: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagPattern.exec(text)) !== null) {
    matches.push({ tag: m[1].toLowerCase(), sub: m[2]?.toLowerCase(), index: m.index, full: m[0] });
  }

  // Resolve each match to its replacement string.
  const replacements: { index: number; full: string; value: string }[] = [];
  for (const match of matches) {
    const value = await resolveTag(match.tag, match.sub, ctx, getPRs, getIssues);
    replacements.push({ index: match.index, full: match.full, value });
  }

  // Apply replacements right-to-left so indices stay valid.
  let result = text;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    result = result.slice(0, r.index) + r.value + result.slice(r.index + r.full.length);
  }

  return result;
}

/** Resolve a single tag to its string expansion. */
async function resolveTag(
  tag: string,
  sub: string | undefined,
  ctx: TagContext,
  getPRs: () => Promise<PullRequestData[]>,
  getIssues: () => Promise<IssueData[]>,
): Promise<string> {
  switch (tag) {
    case "system":
      return resolveSystemTag(sub, ctx.sysFacts);

    case "pr":
      return resolveListTag(sub, getPRs, formatPR);

    case "issue":
      return resolveListTag(sub, getIssues, formatIssue);

    default:
      // Unknown tag — leave it as-is (don't eat user text silently).
      return `{${tag}${sub ? `.${sub}` : ""}}`;
  }
}

/** Resolve {system} and its sub-tags. */
function resolveSystemTag(sub: string | undefined, facts: SysFacts): string {
  if (!sub) {
    return buildSysInfoGuidance(facts);
  }
  switch (sub) {
    case "cpu":
      return `CPU cores: ${facts.cpus || "unknown"}`;
    case "ram": {
      const parts = [`Memory: ${facts.totalMemoryMb} MB total, ${facts.freeMemoryMb} MB free`];
      if (facts.memoryLimitMb) parts.push(`(limit: ${facts.memoryLimitMb} MB)`);
      return parts.join(" ");
    }
    case "os":
      return facts.platform;
    case "tier":
      return facts.tier;
    default:
      return `{system.${sub}}`;
  }
}

/**
 * Resolve {pr} / {pr.N} / {issue} / {issue.N} tags.
 * Without a sub-tag: return all items, one per line.
 * With a numeric sub-tag: return the item at that 0-indexed position (or empty if out of range).
 */
async function resolveListTag<T>(
  sub: string | undefined,
  fetcher: () => Promise<T[]>,
  formatter: (item: T) => string,
): Promise<string> {
  const items = await fetcher();
  if (!sub) {
    return items.length > 0 ? items.map(formatter).join("\n") : "_(none)_";
  }
  const idx = parseInt(sub, 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= items.length) return "";
  return formatter(items[idx]);
}

/** Format a PR for inline display in the system prompt. */
function formatPR(pr: PullRequestData): string {
  return `#${pr.number} ${pr.title} (${pr.head_branch} → ${pr.base_branch}) — ${pr.html_url}`;
}

/** Format an issue for inline display in the system prompt. */
function formatIssue(issue: IssueData): string {
  const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
  return `#${issue.number} ${issue.title}${labels} — ${issue.html_url}`;
}
