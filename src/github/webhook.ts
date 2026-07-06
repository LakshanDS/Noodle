import crypto from "node:crypto";
import { slugify } from "../util/slugify.js";
import { mentionsAgent, shouldTrigger, type TriggerConfig } from "../triggers/check.js";

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
 *   body PASSES the configured `triggers` filter (see `config.triggers`).
 *   This is the new opt-in behavior: by default Noodle only wakes when the
 *   issue @-mentions the agent or contains a configured keyword. Set
 *   `triggers.trigger_on_open: true` to restore the pre-opt-in "fire on every
 *   issue" behavior. Slash commands and assignment-to-agent are exempt — see
 *   below.
 * - `issues` with action assigned — but only when the issue was assigned to
 *   Noodle itself (`selfLogin` matches the new assignee's login). Assignment
 *   to a human teammate is ignored so Noodle doesn't run on every reshuffle.
 *   This is unconditional (no body filter); being assigned IS the wake.
 * - `issue_comment` with action created, when the comment body starts with
 *   `/<agent>` (slash) OR @-mentions the agent. Slash / mention in comments
 *   are always wake signals regardless of `triggers`.
 *
 * `label`-on-`labeled` is handled by `resolveProfile` later (it reads labels
 *   from the issue, not the webhook), so we don't filter by which label was added
 *   here — just confirm a label event happened AND the issue still passes the
 *   trigger filter.
 *
 * `selfLogin` is Noodle's own login (e.g. the bot user). Required to scope the
 *   `assigned` trigger; when omitted, `assigned` events are ignored.
 */
export function parseWebhookEvent(
  event: string,
  payload: unknown,
  selfLogin?: string,
  agentName = "Noodle",
  triggers?: TriggerConfig,
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
  };

  if (!p.repository?.full_name || !p.issue?.number) return null;
  // Skip events on pull requests — Phase 2 is issue-driven.
  if (p.issue.pull_request) return null;

  const repo = p.repository.full_name;
  const issueNumber = p.issue.number;
  const installationId = p.installation?.id;

  if (event === "issues") {
    if (p.action === "opened" || p.action === "reopened" || p.action === "labeled") {
      // Opt-in trigger filter: ignore `issues.*` events whose body carries no
      // wake signal. The webhook payload carries the issue body (not the
      // comment thread — that comes via a separate fetch), so the gate runs
      // on body alone here; `issue_comment.created` (slash / @mention) is
      // handled by its own dedicated branch below, which catches cases where
      // a user wakes Noodle on an existing issue via comment.
      //
      // When the caller passes no triggers config (e.g. a caller that
      // hasn't yet pulled one off `config.triggers`), fall back to the
      // new default: opt-in (mention-only). The bot doesn't fire on
      // untagged issues under that fallback. To restore the legacy
      // "fire-on-everything" behavior at the webhook layer, pass
      // `{ trigger_on_mention: false, trigger_keywords: [], trigger_on_open: true }`.
      const cfg: TriggerConfig = triggers ?? {
        trigger_on_mention: true,
        trigger_keywords: [],
        trigger_on_open: false,
      };
      const body = (p.issue.body ?? "") as string;
      if (!shouldTrigger({ agentName, body, comments: [], triggers: cfg })) {
        return null;
      }
      return { kind: "issue", repo, issueNumber, installationId };
    }
    // Only trigger on assignment when Noodle itself is the new assignee.
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
    // Slash-command rerun OR @mention: only react to comments that
    // explicitly wake the agent. Slash prefix (`/noodle please fix`) is the
    // classic command; @-mention (`@noodle can you look?`) is a natural
    // alternative. Other triggers (`trigger_keywords`, `trigger_on_open`)
    // are body-level concerns — the scheduler decides them when it scans
    // the full thread; the webhook just needs to wake for explicit nudges
    // here.
    const body = (p.comment?.body ?? "").trim();
    if (!body) return null;
    const cmd = slugify(agentName);
    const isSlash = new RegExp(`^\\/${cmd}\\b`, "i").test(body);
    const isMention = mentionsAgent(body, agentName);
    if (!isSlash && !isMention) return null;
    return { kind: "comment", repo, issueNumber, installationId };
  }

  return null;
}
