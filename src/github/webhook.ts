import crypto from "node:crypto";
import { slugify } from "../util/slugify.js";
import { extractProfileTag, mentionsAgent, shouldTrigger, type TriggerConfig } from "../triggers/check.js";
import { matchesCommandTrigger } from "../commands/match.js";

/**
 * Pure webhook helpers — HMAC signature verification and event parsing.
 * Kept side-effect-free so they unit-test without touching the network.
 *
 * GitHub signs every webhook with HMAC-SHA256 and sends the hex digest in the
 * `X-Hub-Signature-256` header as `sha256=<hex>`. We verify in constant time
 * to avoid timing attacks on the comparison.
 */

/** A normalized webhook intent Noodle can act on, or null if ignorable. */
export interface WebhookIntent {
  /** Which kind of trigger produced this. */
  kind: "issue" | "comment";
  /** "owner/name" of the repo the event came from. */
  repo: string;
  /** Issue number the event refers to. */
  issueNumber: number;
  /** App installation id, when present (App auth mode). */
  installationId?: number;
  /**
   * Profile hint from a `#<profile>` tag in the body/comment, when present.
   * Used as the enqueue-time profile for per-profile concurrency gating. The
   * authoritative profile is still resolved inside runJob (which sees the full
   * issue + comments), but the hint is enough for the gate.
   */
  profileHint?: string;
}

/** Strip an optional GitHub-App `[bot]` suffix and lowercase a login. */
function normalizeLogin(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\[bot\]$/i, "").trim();
}

/**
 * True when `senderLogin` is Noodle itself. Tolerant of the GitHub-App `[bot]`
 * suffix — `selfLogin` may be set with or without it, and GitHub always emits
 * `<app-slug>[bot]` as the sender for App-identity events. Comparison is
 * case-insensitive. Returns false when either side is missing/empty.
 */
export function isSelfSender(senderLogin?: string | null, selfLogin?: string): boolean {
  if (!senderLogin || !selfLogin) return false;
  const a = normalizeLogin(senderLogin);
  return a !== "" && a === normalizeLogin(selfLogin);
}

/**
 * Verify the `X-Hub-Signature-256` header against the raw request body.
 * `signature` is the header value (`sha256=<hex>`). Returns true on a match.
 */
export function verifySignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !signature.startsWith("sha256=")) return false;
  const expected = signature.slice("sha256=".length);
  const digest = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  // timingSafeEqual needs equal-length buffers; the hex digest length is fixed.
  if (digest.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(expected, "utf8"));
}

/**
 * Turn a GitHub webhook payload into a normalized intent, or null if the event
 * is not one Noodle should act on (ping, unrelated actions, PR lifecycle
 * events, etc.).
 *
 * Recognized events:
 * - `issues` with action opened | reopened | labeled — only when the issue
 *   body PASSES the configured `triggers` wake filter (default: opt-in, so the
 *   body must @-mention the agent or carry a keyword / slash / #profile tag).
 *   Set `triggers.trigger_on_open: true` to restore "fire on every issue".
 *   These events are issue-only: the same lifecycle on a PR is ignored.
 * - `issues` with action assigned — but only when the issue was assigned to
 *   Noodle itself (`selfLogin` matches the new assignee's login). Assignment
 *   is unconditional wake; it does NOT go through the trigger filter. Assignment
 *   to a human teammate is ignored so Noodle doesn't run on every reshuffle.
 * - `issue_comment` with action created, when the comment body explicitly
 *   wakes the agent: `/<agent>` slash command, `@<agent>` mention, or a
 *   `#<configured-profile>` tag. Fires for BOTH issue and PR comments — a
 *   `/<command>` on a PR wakes the agent, which clones the PR's branch and
 *   pushes back to the same PR (detected inside runJob via getIssue's
 *   `pull_request` flag).
 *
 * `label`-on-`labeled` is handled by `resolveProfile` later (it reads labels
 * from the issue, not the webhook), so we don't filter by which label was added
 * here — but the labeled event still must pass the wake filter to fire.
 *
 * `selfLogin` is Noodle's own login (e.g. the bot user). Required to scope the
 * `assigned` trigger; when omitted, `assigned` events are ignored. It is also
 * used to suppress re-entrant triggers: the bot's OWN comments and label swaps
 * never wake it again (the answer comment can't re-trigger via its own text).
 * Other self-originated events — `issues.opened`/`reopened`/`assigned` — are
 * NOT suppressed, because that is how cron/trigger runs open new issues that
 * legitimately chain into another agent run.
 */
export function parseWebhookEvent(
  event: string,
  payload: unknown,
  selfLogin?: string,
  agentName = "Noodle",
  triggers?: TriggerConfig,
  profileNames: string[] = [],
  /**
   * Active command triggers (from the command store). Any `/<trigger>` in a
   * comment wakes the agent. When omitted, falls back to just `/<agent-slug>`
   * so the built-in `/noodle` still works (back-compat for CLI/tests that
   * haven't wired the command store through).
   */
  commandTriggers: string[] = [],
): WebhookIntent | null {
  const p = payload as {
    action?: string;
    installation?: { id?: number };
    repository?: { full_name?: string };
    issue?: {
      number?: number;
      state?: string;
      pull_request?: unknown;
      body?: string | null;
    };
    assignee?: { login?: string } | null; // present on `assigned` events
    comment?: { body?: string | null };
    sender?: { login?: string | null } | null; // user/bot that triggered the event
  };

  if (!p.repository?.full_name || !p.issue?.number) return null;
  // `issue_comment` events fire for BOTH issues and PRs (GitHub routes PR
  // comments through the issue-comment surface). We treat them the same: a
  // `/<command>`, `@mention`, or `#<profile>` on a PR comment wakes the agent
  // — runJob detects PR mode from getIssue and clones the PR's branch.
  //
  // `issues.*` lifecycle events (opened/reopened/labeled/assigned) are still
  // issue-only: Noodle is issue-driven, so those events on a PR are ignored.
  const isPullRequest = !!p.issue.pull_request;

  const repo = p.repository.full_name;
  const issueNumber = p.issue.number;
  const installationId = p.installation?.id;

  // Default to opt-in (mention-only) when the caller passes no triggers config.
  // To restore "fire-on-everything", set triggers.trigger_on_open: true.
  const cfg: TriggerConfig = triggers ?? {
    trigger_on_mention: true,
    trigger_keywords: [],
    trigger_on_open: false,
  };

  if (event === "issues") {
    // `issues.*` lifecycle events are issue-only — Noodle is issue-driven and
    // doesn't trigger on PR opened/reopened/labeled/assigned. (PR wake-up
    // happens via issue_comment with a slash/mention, handled below.)
    if (isPullRequest) return null;
    if (p.action === "opened" || p.action === "reopened" || p.action === "labeled") {
      // Suppress the bot's OWN label swaps (e.g. "cooking" → "cooked" after a
      // run completes) so they don't re-fire under `trigger_on_open`.
      // `opened`/`reopened` are deliberately NOT suppressed — cron/trigger
      // runs open new issues to chain into another agent run, and that path
      // must keep working.
      if (p.action === "labeled" && isSelfSender(p.sender?.login, selfLogin)) {
        return null;
      }
      // Opt-in wake filter: the issue body must carry a wake signal (mention,
      // keyword, slash, or #profile). The webhook payload carries the body but
      // NOT the comment thread, so the gate runs on body alone here; a wake
      // posted as a comment on an existing issue is caught by the dedicated
      // `issue_comment.created` branch below.
      const body = (p.issue.body ?? "") as string;
      const { wake } = shouldTrigger({ agentName, body, comments: [], triggers: cfg, profileNames });
      if (!wake) return null;
      return { kind: "issue", repo, issueNumber, installationId, profileHint: extractProfileTag(body, profileNames) ?? undefined };
    }
    // Only trigger on assignment when Noodle itself is the new assignee.
    // Assignment is unconditional wake (being assigned IS the signal) — it
    // doesn't go through the trigger filter.
    if (p.action === "assigned" && selfLogin) {
      const newAssignee = p.assignee?.login?.toLowerCase();
      if (newAssignee && newAssignee === selfLogin.toLowerCase()) {
        return { kind: "issue", repo, issueNumber, installationId };
      }
    }
    return null;
  }

  if (event === "issue_comment") {
    if (p.action !== "created") return null;
    // Suppress the bot's OWN comments — the answer comment can contain
    // `@noodle` / `#profile` / `/command` in its text, and without this guard
    // it would re-trigger a run the moment it's posted. A bot comment is an
    // output, never a wake signal.
    if (isSelfSender(p.sender?.login, selfLogin)) {
      return null;
    }
    // A new comment wakes the agent when it explicitly invites it via three
    // independent channels:
    //   - `/<command>` — always on. Active command triggers (e.g. /noodle-fix,
    //     /review, custom). Gating is not needed: the user explicitly typed a
    //     command to invoke a specific workflow.
    //   - `@<agent>` mention (e.g. @noodle) — gated by the trigger_on_mention
    //     toggle in Settings (default on). Operators can disable @-mention wakes
    //     without affecting /command or #profile wakes.
    //   - `#<profile>` tag (e.g. #claude) — always on. The user explicitly
    //     selected a profile; gating would be surprising.
    // trigger_keywords / trigger_on_open are body-level concerns handled by
    // the scheduler scan; the webhook only needs to react to explicit nudges.
    const body = (p.comment?.body ?? "").trim();
    if (!body) return null;
    // Triggers to test = active command triggers, plus the agent slug as a
    // backstop so `/noodle` wakes even if the built-in command row is missing
    // or disabled.
    const slug = slugify(agentName);
    const cmdTriggers = commandTriggers.length > 0 ? commandTriggers : [slug].filter((s) => s);
    if (slug && !cmdTriggers.includes(slug)) cmdTriggers.push(slug);
    const isSlash = matchesCommandTrigger(body, cmdTriggers);
    // @mention is gated by the trigger_on_mention setting (default on). When
    // the setting is absent/undefined (CLI/test path), assume on — the schema
    // default is true.
    const isMention = triggers?.trigger_on_mention !== false && mentionsAgent(body, agentName);
    const hasProfileTag = profileNames.some(
      (name) => name && new RegExp(`(?:^|\\s)#${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(body),
    );
    if (!isSlash && !isMention && !hasProfileTag) return null;
    return { kind: "comment", repo, issueNumber, installationId, profileHint: extractProfileTag(body, profileNames) ?? undefined };
  }

  return null;
}

/**
 * Raw metadata extracted from a webhook payload for trigger matching.
 * Unlike WebhookIntent (which is filtered to Noodle-relevant events),
 * this captures the raw event type/action/repo so triggers can match
 * against any GitHub event.
 */
export interface WebhookMetadata {
  /** The GitHub event type (e.g. "issues", "pull_request", "push"). */
  eventType: string;
  /** The event action (e.g. "opened", "created"). Undefined for events without actions. */
  action?: string;
  /** "owner/name" of the repo. */
  repo: string;
  /** For push events, the branch ref (e.g. "refs/heads/main"). */
  branch?: string;
  /** Installation ID, when present (App auth mode). */
  installationId?: number;
  /** The full webhook payload for prompt context. */
  payload: unknown;
}

/**
 * Extract raw event metadata from a webhook payload for trigger matching.
 * This is a pure extraction function — no filtering logic. Returns null when
 * the payload lacks the minimum required fields (repository.full_name).
 */
export function parseWebhookMetadata(event: string, payload: unknown): WebhookMetadata | null {
  const p = payload as {
    action?: string;
    installation?: { id?: number };
    repository?: { full_name?: string };
    ref?: string;
  };

  if (!p.repository?.full_name) return null;

  return {
    eventType: event,
    action: p.action,
    repo: p.repository.full_name,
    branch: p.ref,
    installationId: p.installation?.id,
    payload,
  };
}

/**
 * Match a webhook event against stored trigger definitions. Returns the
 * triggers that should fire for this event.
 */
export function matchTriggers(
  metadata: WebhookMetadata,
  triggers: Array<{
    id: number;
    event_type: string;
    event_action: string | null;
    branch_pattern: string | null;
  }>,
): Array<{ id: number }> {
  const matched: Array<{ id: number }> = [];

  for (const trigger of triggers) {
    // Event type must match exactly.
    if (trigger.event_type !== metadata.eventType) continue;

    // If the trigger specifies an action, it must match.
    if (trigger.event_action && trigger.event_action !== metadata.action) continue;

    // If the trigger specifies a branch pattern (for push events), check it.
    if (trigger.branch_pattern && metadata.branch) {
      // Extract branch name from ref (e.g. "refs/heads/main" → "main").
      const branchName = metadata.branch.replace(/^refs\/heads\//, "");
      // Simple glob: "main" matches "main", "feature/*" matches "feature/foo".
      const pattern = trigger.branch_pattern;
      if (pattern.includes("*")) {
        const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
        if (!regex.test(branchName)) continue;
      } else if (branchName !== pattern) {
        continue;
      }
    }

    matched.push({ id: trigger.id });
  }

  return matched;
}
