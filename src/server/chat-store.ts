import type { Database as Db } from "better-sqlite3";

/**
 * DB-backed store for the Chats feature — interactive, multi-turn agent
 * conversations driven from the web UI (as opposed to GitHub issue/PR/cron
 * runs). Mirrors the other stores (`CommandStore`, `SchedulerStore`, …): a
 * class over the shared `better-sqlite3` handle, with `fromDb` for in-memory
 * tests, a `SCHEMA` const, and CRUD methods.
 *
 * Two tables:
 *
 *  - `chats` — one row per conversation. Holds the chosen repo + branch, the
 *    resolved profile, the on-disk workspace path + pi session dir (NULL until
 *    the first prompt actually boots the agent), a denormalised status +
 *    preview for the list view, and a `last_error` for failed boots.
 *  - `chat_messages` — one row per turn (user / assistant / tool result). Kept
 *    as an append-only log so the detail view can render the full thread on
 *    load, including the live-run history persisted by `ChatRuntime`.
 *
 * The workspace path is stored on the chat row so a server restart can re-wrap
 * the existing clone (no re-clone) and the pi session can be reopened from its
 * JSONL — the conversation resumes with full context.
 */

/** One chat conversation. */
export interface ChatRow {
  id: number;
  title: string;
  /** "owner/name" of the repo the agent runs against. */
  repo: string;
  /** Branch checked out in the workspace. */
  branch: string;
  /** The repo's default branch — used by the boot logic to decide whether to
   * switch branches (stay put on main/master, switch otherwise). */
  default_branch: string;
  /** Resolved profile name, or null to use the instance default. */
  profile: string | null;
  /**
   * Per-chat thinking-level override (off|minimal|low|medium|high|xhigh).
   * Applied at session boot; falls back to the profile's thinking_level when
   * unset/medium. Defaults to "medium".
   */
  thinking_level: string;
  /** Temp dir of the cloned repo. NULL until the first prompt boots it. */
  workspace_path: string | null;
  /** pi session dir (JSONL lives here). NULL until the first prompt. */
  session_dir: string | null;
  /** idle | running | errored | disposed. */
  status: string;
  /** Last error message (set when status = 'errored'). */
  last_error: string | null;
  /** Last message excerpt, for the list view. */
  preview: string;
  created_at: string;
  updated_at: string;
}

/** Body for creating a chat. */
export interface NewChat {
  title?: string;
  repo: string;
  branch: string;
  default_branch: string;
  profile?: string | null;
  /** Optional thinking-level override; defaults to "medium". */
  thinking_level?: string;
}

/** Partial update. All fields optional. */
export interface ChatUpdate {
  title?: string;
  profile?: string | null;
  thinking_level?: string;
  workspace_path?: string | null;
  session_dir?: string | null;
  status?: string;
  last_error?: string | null;
  preview?: string;
}

/** One turn in a chat thread. */
export interface ChatMessageRow {
  id: number;
  chat_id: number;
  /** "user" | "assistant" | "tool". */
  role: string;
  text: string;
  /** Tool name (for role = "tool" / tool-call chips). NULL for prose turns. */
  tool_name: string | null;
  /** Tool call id linking a tool result to its call. NULL for prose turns. */
  tool_call_id: string | null;
  created_at: string;
}

/** Body for appending a message. */
export interface NewChatMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  tool_name?: string | null;
  tool_call_id?: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'New chat',
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  profile TEXT,
  thinking_level TEXT NOT NULL DEFAULT 'medium',
  workspace_path TEXT,
  session_dir TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT,
  preview TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  tool_name TEXT,
  tool_call_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id, id);
`;

export class ChatStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    this.db.exec(SCHEMA);
    // Add `thinking_level` (per-chat override) to pre-existing tables. Fresh
    // DBs have it via the CREATE. Mirrors the migration pattern in
    // command-store.ts.
    const cols = db.prepare("PRAGMA table_info(chats)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "thinking_level")) {
      db.exec("ALTER TABLE chats ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'medium'");
    }
    // Foreign-key cascade (OFF by default in sqlite3) so deleting a chat also
    // drops its messages.
    this.db.pragma("foreign_keys = ON");
  }

  /** For tests that want to inject an in-memory DB. */
  static fromDb(db: Db): ChatStore {
    return new ChatStore(db);
  }

  /** Create a chat. Caller validates repo + branch first. */
  create(input: NewChat): ChatRow {
    this.db
      .prepare(
        `INSERT INTO chats (title, repo, branch, default_branch, profile, thinking_level)
         VALUES (@title, @repo, @branch, @default_branch, @profile, @thinking_level)`,
      )
      .run({
        title: input.title?.trim() || "New chat",
        repo: input.repo,
        branch: input.branch,
        default_branch: input.default_branch,
        profile: input.profile ?? null,
        thinking_level: input.thinking_level ?? "medium",
      });
    const id = (this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    return this.get(id);
  }

  /** Apply a partial update. */
  update(id: number, update: ChatUpdate): ChatRow {
    const current = this.get(id);
    const cols: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const key of [
      "title",
      "profile",
      "thinking_level",
      "workspace_path",
      "session_dir",
      "status",
      "last_error",
      "preview",
    ] as const) {
      if (update[key] !== undefined) {
        cols.push(`${key} = @${key}`);
        params[key] = update[key];
      }
    }
    if (cols.length === 0) return current;
    cols.push("updated_at = datetime('now')");
    this.db.prepare(`UPDATE chats SET ${cols.join(", ")} WHERE id = @id`).run(params);
    return this.get(id);
  }

  /** Fetch one chat by id. Throws if missing. */
  get(id: number): ChatRow {
    const row = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as
      | ChatRow
      | undefined;
    if (!row) throw new Error(`chat ${id} not found`);
    return row;
  }

  /** All chats, newest-first (by updated_at, tiebreak id). */
  list(): ChatRow[] {
    return this.db
      .prepare("SELECT * FROM chats ORDER BY updated_at DESC, id DESC")
      .all() as ChatRow[];
  }

  /** Delete a chat. Cascade removes its messages. */
  delete(id: number): void {
    this.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
  }

  /** Append a turn. Returns the inserted row. Also bumps the chat's updated_at
   *  + (for prose turns) its preview. */
  appendMessage(chatId: number, input: NewChatMessage): ChatMessageRow {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO chat_messages (chat_id, role, text, tool_name, tool_call_id)
           VALUES (@chat_id, @role, @text, @tool_name, @tool_call_id)`,
        )
        .run({
          chat_id: chatId,
          role: input.role,
          text: input.text,
          tool_name: input.tool_name ?? null,
          tool_call_id: input.tool_call_id ?? null,
        });
      const id = (this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

      // Bump updated_at on every turn, and refresh the list-view preview from
      // the latest prose turn (user or assistant) — tool rows don't make good
      // previews.
      const preview =
        input.role === "user" || input.role === "assistant" ? previewOf(input.text) : null;
      const cols = ["updated_at = datetime('now')"];
      const params: Record<string, unknown> = { id: chatId };
      if (preview !== null) {
        cols.push("preview = @preview");
        params.preview = preview;
      }
      this.db.prepare(`UPDATE chats SET ${cols.join(", ")} WHERE id = @id`).run(params);

      return this.getMessage(id);
    })();
  }

  /** Fetch one message by id. Throws if missing. */
  getMessage(id: number): ChatMessageRow {
    const row = this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as
      | ChatMessageRow
      | undefined;
    if (!row) throw new Error(`chat message ${id} not found`);
    return row;
  }

  /** All messages for a chat, oldest-first (by id). */
  listMessages(chatId: number): ChatMessageRow[] {
    return this.db
      .prepare("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY id ASC")
      .all(chatId) as ChatMessageRow[];
  }

  /**
   * Reset any chats left in 'running' state (a server crash mid-prompt).
   * Called at boot — no live session survives a restart, so a 'running' row is
   * a lie. Flips them to 'errored' with a clear reason. Returns the count.
   */
  resetStaleRunning(): number {
    const result = this.db
      .prepare(
        `UPDATE chats SET status = 'errored', last_error = 'server restarted while running',
         updated_at = datetime('now')
         WHERE status = 'running'`,
      )
      .run();
    return result.changes;
  }
}

/** Truncate a message to a short list-view preview (one line, ≤80 chars). */
function previewOf(text: string): string {
  const oneLine = text.trim().replace(/\s+/g, " ");
  return oneLine.length > 80 ? oneLine.slice(0, 80) + "…" : oneLine;
}
