import crypto from "node:crypto";
import { slugify } from "../util/slugify.js";
import { extractProfileTag, mentionsAgent, shouldTrigger, type TriggerConfig } from "../triggers/check.js";

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
 * is not one Noodle should act on (ping, unrelated actions, PR events, etc.).
 *
 * Recognized events:
 * - `issues` with action opened | reopened | labeled — only when the issue
 *   body PASSES the configured `triggers` wake filter (default: opt-in, so the
 *   body must @-mention the agent or carry a keyword / slash / #profile tag).
 *   Set `triggers.trigger_on_open: true` to restore "fire on every issue".
 * - `issues` with action assigned — but only when the issue was assigned to
 *   Noodle itself (`selfLogin` matches the new assignee's login). Assignment
 *   is unconditional wake; it does NOT go through the trigger filter. Assignment
 *   to a human teammate is ignored so Noodle doesn't run on every reshuffle.
 * - `issue_comment` with action created, when the comment body explicitly
 *   wakes the agent: `/<agent>` slash command, `@<agent>` mention, or a
 *   `#<configured-profile>` tag.
 *
 * `label`-on-`labeled` is handled by `resolveProfile` later (it reads labels
 * from the issue, not the webhook), so we don't filter by which label was added
 * here — but the labeled event still must pass the wake filter to fire.
 *
 * `selfLogin` is Noodle's own login (e.g. the bot user). Required to scope the
 * `assigned` trigger; when omitted, `assigned` events are ignored.
 */
export function parseWebhookEvent(
  event: string,
  payload: unknown,
  selfLogin?: string,
  agentName = "Noodle",
  triggers?: TriggerConfig,
  profileNames: string[] = [],
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
  // Skip events on pull requests — Phase 2 is issue-driven.
  if (p.issue.pull_request) return null;

  // Skip events triggered by the bot itself (e.g. label swaps, comments)
  // to prevent re-entrant triggers after a run completes.
  if (selfLogin && p.sender?.login?.toLowerCase() === selfLogin.toLowerCase()) {
    return null;
  }

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
    if (p.action === "opened" || p.action === "reopened" || p.action === "labeled") {
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
    // A new comment wakes the agent when it explicitly invites it:
    //   - `/<agent>` slash command (e.g. /noodle fix this), OR
    //   - `@<agent>` mention (e.g. @noodle can you look?), OR
    //   - `#<profile>` tag (e.g. #claude rerun with claude)
    // trigger_keywords / trigger_on_open are body-level concerns handled by
    // the scheduler scan; the webhook only needs to react to explicit nudges.
    const body = (p.comment?.body ?? "").trim();
    if (!body) return null;
    const slug = slugify(agentName);
    const isSlash = new RegExp(`^\\/${slug}\\b`, "i").test(body);
    const isMention = mentionsAgent(body, agentName);
    const hasProfileTag = profileNames.some(
      (name) => name && new RegExp(`(?:^|\\s)#${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(body),
    );
    if (!isSlash && !isMention && !hasProfileTag) return null;
    return { kind: "comment", repo, issueNumber, installationId, profileHint: extractProfileTag(body, profileNames) ?? undefined };
  }

  return null;
}
