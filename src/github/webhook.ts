import crypto from "node:crypto";
import { slugify } from "../util/slugify.js";

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
 * - `issues` with action opened | reopened | labeled
 * - `issues` with action assigned — but only when the issue was assigned to
 *   Noodle itself (`selfLogin` matches the new assignee's login). Assignment
 *   to a human teammate is ignored so Noodle doesn't run on every reshuffle.
 * - `issue_comment` with action created, when the comment body starts with `/noodle`
 *
 * `label`-on-`labeled` is handled by `resolveProfile` later (it reads labels
 * from the issue, not the webhook), so we don't filter by which label was added
 * here — just confirm a label event happened.
 *
 * `selfLogin` is Noodle's own login (e.g. the bot user). Required to scope the
 * `assigned` trigger; when omitted, `assigned` events are ignored.
 */
export function parseWebhookEvent(
  event: string,
  payload: unknown,
  selfLogin?: string,
  agentName = "Noodle",
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
    // Slash-command rerun: only react to comments starting with /<agent>.
    const body = (p.comment?.body ?? "").trim();
    const cmd = slugify(agentName);
    if (!new RegExp(`^\\/${cmd}\\b`, "i").test(body)) return null;
    return { kind: "comment", repo, issueNumber, installationId };
  }

  return null;
}
