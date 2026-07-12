/**
 * TEMPORARY in-memory store for the Commands and Skills pages while the backend
 * store + SKILL.md read/write layer lands. Delete this whole file (and swap the
 * views' `mockXxx` calls back to `getJson`/`sendJson`) once the real API exists.
 *
 * Functions are async + return the same envelope shapes the server will, so the
 * views are written exactly like the cron views — the migration is mechanical.
 */
import type {
  CommandRow,
  CommandsResponse,
  CommandDetailResponse,
  CommandMutationResponse,
  CommandInput,
  SkillRow,
  SkillsResponse,
  SkillDetailResponse,
  SkillMutationResponse,
  SkillInput,
  ParsedChatMessage,
} from "../api/types.js";

/* ------------------------------------------------------------------ commands */

let nextCommandId = 4;
const commands: CommandRow[] = [
  {
    id: 1,
    trigger: "question",
    name: "Answer a question",
    description: "Reads the issue as a question and posts a reasoned answer — no code changes.",
    system_prompt:
      "You answer questions about this repository. Read the relevant code, then post a clear, concise answer as a comment. Do not open a PR or edit files — this is research and explanation only.",
    profile: null,
    enabled: 1,
    created_at: "2026-07-01T09:00:00",
    updated_at: "2026-07-01T09:00:00",
  },
  {
    id: 2,
    trigger: "search",
    name: "Search & summarize",
    description: "Finds where something lives in the codebase and summarizes how it fits together.",
    system_prompt:
      "Someone has asked where/how something works in this codebase. Locate the relevant code with grep/find/read, trace how the pieces connect, and write a short architectural summary as a comment. Do not modify files.",
    profile: null,
    enabled: 1,
    created_at: "2026-07-02T11:30:00",
    updated_at: "2026-07-02T11:30:00",
  },
  {
    id: 3,
    trigger: "review",
    name: "Review changes",
    description: "Reviews the issue's PR the way a careful senior engineer would.",
    system_prompt:
      "Review the changes related to this issue as a senior engineer. Call out bugs, risks, and missing tests. Be specific — reference files and lines. Keep it to the highest-signal points rather than exhaustive nitpicks.",
    profile: null,
    enabled: 0,
    created_at: "2026-07-03T14:10:00",
    updated_at: "2026-07-03T14:10:00",
  },
];

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function normalizeTrigger(raw: string): string {
  // Accept "/question" or "question"; store without the slash.
  return raw.trim().replace(/^\/+/, "");
}

export async function mockListCommands(): Promise<CommandsResponse> {
  return Promise.resolve({ commands: [...commands] });
}

export async function mockGetCommand(id: number): Promise<CommandDetailResponse> {
  const command = commands.find((c) => c.id === id);
  if (!command) throw new Error("Command not found");
  return Promise.resolve({ command: { ...command } });
}

export async function mockCreateCommand(input: CommandInput): Promise<CommandMutationResponse> {
  const ts = nowIso();
  const command: CommandRow = {
    id: nextCommandId++,
    trigger: normalizeTrigger(input.trigger),
    name: input.name.trim(),
    description: input.description.trim(),
    system_prompt: input.system_prompt,
    profile: input.profile || null,
    enabled: 1,
    created_at: ts,
    updated_at: ts,
  };
  commands.unshift(command);
  return Promise.resolve({ command: { ...command } });
}

export async function mockUpdateCommand(id: number, input: Partial<CommandInput>): Promise<CommandMutationResponse> {
  const command = commands.find((c) => c.id === id);
  if (!command) throw new Error("Command not found");
  if (input.trigger !== undefined) command.trigger = normalizeTrigger(input.trigger);
  if (input.name !== undefined) command.name = input.name.trim();
  if (input.description !== undefined) command.description = input.description.trim();
  if (input.system_prompt !== undefined) command.system_prompt = input.system_prompt;
  if (input.profile !== undefined) command.profile = input.profile || null;
  command.updated_at = nowIso();
  return Promise.resolve({ command: { ...command } });
}

export async function mockDeleteCommand(id: number): Promise<void> {
  const idx = commands.findIndex((c) => c.id === id);
  if (idx >= 0) commands.splice(idx, 1);
  return Promise.resolve();
}

/* -------------------------------------------------------------------- skills */

/** `source: "bundled"` seeds mirror the real skills/ directory at the repo root. */
const skills: SkillRow[] = [
  {
    name: "noodle-default",
    description:
      "Noodle's always-active engineering mindset — the lazy-senior decision ladder, minimal-diff rule, stdlib-first, deletion over addition.",
    body: "# Noodle default\n\nThe always-active mindset. Question whether the task needs to exist (YAGNI)…",
    source: "bundled",
    updated_at: "2026-06-20T08:00:00",
  },
  {
    name: "noodle-fix",
    description:
      "How Noodle fixes a bug or implements a change from a GitHub issue. Pairs with noodle-default. Investigate → Fix → Verify → Finish.",
    body: "# Fixing an issue\n\nPairs with **noodle-default**. Adds the fix workflow: investigate, fix, verify, finish.",
    source: "bundled",
    updated_at: "2026-06-20T08:00:00",
  },
  {
    name: "noodle-review",
    description:
      "Review/audit workflow. Pairs with noodle-default. Approach, report format, and what not to do.",
    body: "# Reviewing\n\nPairs with **noodle-default**. Highest-signal findings only — reference files and lines.",
    source: "bundled",
    updated_at: "2026-06-20T08:00:00",
  },
];

export async function mockListSkills(): Promise<SkillsResponse> {
  return Promise.resolve({ skills: [...skills] });
}

export async function mockGetSkill(name: string): Promise<SkillDetailResponse> {
  const skill = skills.find((s) => s.name === name);
  if (!skill) throw new Error("Skill not found");
  return Promise.resolve({ skill: { ...skill } });
}

export async function mockCreateSkill(input: SkillInput): Promise<SkillMutationResponse> {
  const name = input.name.trim();
  if (skills.some((s) => s.name === name)) throw new Error(`A skill named "${name}" already exists`);
  const skill: SkillRow = {
    name,
    description: input.description.trim(),
    body: input.body,
    source: "custom",
    updated_at: nowIso(),
  };
  skills.unshift(skill);
  return Promise.resolve({ skill: { ...skill } });
}

export async function mockUpdateSkill(name: string, input: Partial<SkillInput>): Promise<SkillMutationResponse> {
  const skill = skills.find((s) => s.name === name);
  if (!skill) throw new Error("Skill not found");
  if (input.description !== undefined) skill.description = input.description.trim();
  if (input.body !== undefined) skill.body = input.body;
  skill.updated_at = nowIso();
  return Promise.resolve({ skill: { ...skill } });
}

export async function mockDeleteSkill(name: string): Promise<void> {
  const idx = skills.findIndex((s) => s.name === name);
  if (idx >= 0) skills.splice(idx, 1);
  return Promise.resolve();
}

/* -------------------------------------------------------------------- chats */

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
      m("assistant", "There are three repeated call sites for `/api/runs` — in `RunsView`, `RunDetailView`, and `CronsView`. They should funnel through a single `fetchRuns()` helper in `api/client.ts`."),
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
    preview: "The cron parser lives in `src/engine/cron-run.ts`…",
    updated_at: "2026-07-10 11:05:00",
    messages: [
      m("user", "How does the cron scheduler decide when to fire next?"),
      m("assistant", "The cron parser lives in `src/engine/cron-run.ts`. It uses the `cron-parser` library to compute the next fire time from each job's expression, stores it in `next_run_at`, and a `setInterval` tick checks every minute for due jobs."),
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
  // Newest first, mirroring how the real runs/crons list is ordered.
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

