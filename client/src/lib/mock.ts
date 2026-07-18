/**
 * TEMPORARY in-memory store for the Chats feature. There is no `/api/chats`
 * backend yet — the Chats views (`ChatsView`, `ChatDetailView`) are an
 * intentional mock-backed stub, hidden from the main nav until a real chat
 * backend lands. Swap the `mockXxx` calls for real `getJson`/`sendJson` calls
 * and delete this file when that happens.
 *
 * (The Commands and Skills mock functions that used to live here were removed —
 * both have real DB-backed APIs now, wired in via `getJson`/`sendJson`.)
 */
import type { ParsedChatMessage } from "../api/types.js";

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export interface MockChat {
  id: string;
  title: string;
  /** Last message excerpt, shown in the list. */
  preview: string;
  /** SQLite-style naive UTC "YYYY-MM-DD HH:MM:SS", matching the rest of the app. */
  updated_at: string;
  /** Full conversation thread. */
  messages: ParsedChatMessage[];
}

/** Shorthand to build a chat turn. */
function m(role: "user" | "assistant", text: string): ParsedChatMessage {
  return { role, text };
}

const chats: MockChat[] = [
  {
    id: "c1",
    title: "Fix auth token refresh",
    preview: "I'll check the token refresh logic in the OAuth client…",
    updated_at: "2026-07-11 08:42:00",
    messages: [
      m("user", "The GitHub token seems to expire mid-run. Can you find why?"),
      m("assistant", "I'll check the token refresh logic in the OAuth client.\n\nLooking at `src/server/github.ts`, the refresh path only runs **on startup**, not before each request. So a long-running session hits a stale token."),
      m("user", "Got it. Can you patch it?"),
      m("assistant", "Done. The fix wraps each API call in a token-validity check and refreshes on demand. See PR #48."),
    ],
  },
  {
    id: "c2",
    title: "Refactor API client",
    preview: "Which endpoints are duplicated across views?",
    updated_at: "2026-07-11 07:15:00",
    messages: [
      m("user", "Which endpoints are duplicated across views?"),
      m("assistant", "There are three repeated call sites for `/api/runs` — in `RunsView`, `RunDetailView`, and `SchedulersView`. They should funnel through a single `fetchRuns()` helper in `api/client.ts`."),
    ],
  },
  {
    id: "c3",
    title: "Add webhook tests",
    preview: "Done. Added tests for the issue-opened and PR-review paths.",
    updated_at: "2026-07-10 19:30:00",
    messages: [
      m("user", "We have no coverage on the webhook handler. Can you add some?"),
      m("assistant", "Sure — I'll cover the two main event types: `issue-opened` and `pull_request_review`."),
      m("assistant", "Done. Added tests for the issue-opened and PR-review paths, plus a negative case for unknown events."),
    ],
  },
  {
    id: "c4",
    title: "Explain the cron parser",
    preview: "The cron parser lives in `src/engine/scheduler-run.ts`…",
    updated_at: "2026-07-10 11:05:00",
    messages: [
      m("user", "How does the cron scheduler decide when to fire next?"),
      m("assistant", "The cron parser lives in `src/engine/scheduler-run.ts`. It uses the `cron-parser` library to compute the next fire time from each job's expression, stores it in `next_run_at`, and a `setInterval` tick checks every minute for due jobs."),
    ],
  },
];

/** Canned assistant reply used when the user "sends" a message in the mock UI. */
const CANNED_REPLIES = [
  "Got it — looking into that now.",
  "Here's what I found. Let me know if you want me to go deeper.",
  "Makes sense. I'll start on a fix and open a PR when it's ready.",
  "Good question. The short answer is in the code below — happy to expand.",
];

let replyCursor = 0;

function lastExcerpt(messages: ParsedChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i].text.trim();
    if (t) return t.length > 80 ? t.slice(0, 80) + "…" : t;
  }
  return "";
}

export async function mockListChats(): Promise<{ chats: MockChat[] }> {
  // Newest first, mirroring how the real runs/schedulers list is ordered.
  const sorted = [...chats].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  return Promise.resolve({ chats: sorted });
}

export async function mockGetChat(id: string): Promise<{ chat: MockChat }> {
  const chat = chats.find((c) => c.id === id);
  if (!chat) throw new Error("Chat not found");
  return Promise.resolve({ chat });
}

export async function mockCreateChat(title?: string): Promise<{ chat: MockChat }> {
  const chat: MockChat = {
    id: `c${Date.now()}`,
    title: title?.trim() || "New chat",
    preview: "",
    updated_at: nowIso(),
    messages: [],
  };
  chats.unshift(chat);
  return Promise.resolve({ chat });
}

/** Append a user message + a canned assistant reply. Returns the updated chat. */
export async function mockAppendMessage(id: string, text: string): Promise<{ chat: MockChat }> {
  const chat = chats.find((c) => c.id === id);
  if (!chat) throw new Error("Chat not found");
  chat.messages.push(m("user", text));
  // Simulate a reply deterministically (no real model behind this).
  const reply = CANNED_REPLIES[replyCursor % CANNED_REPLIES.length];
  replyCursor++;
  chat.messages.push(m("assistant", reply));
  chat.updated_at = nowIso();
  chat.preview = lastExcerpt(chat.messages);
  if (chat.title === "New chat") {
    chat.title = text.slice(0, 40) + (text.length > 40 ? "…" : "");
  }
  return Promise.resolve({ chat });
}
