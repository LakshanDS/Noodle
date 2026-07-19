import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ChatStore } from "../src/server/chat-store.js";

let dir: string;
let store: ChatStore;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-chat-"));
  db = new Database(join(dir, "test.db"));
  store = ChatStore.fromDb(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ChatStore", () => {
  /* ---- CRUD ---- */

  it("creates a chat and reads it back", () => {
    const chat = store.create({ repo: "owner/repo", branch: "main", default_branch: "main" });
    expect(chat.id).toBeGreaterThan(0);
    expect(chat.title).toBe("New chat");
    expect(chat.repo).toBe("owner/repo");
    expect(chat.branch).toBe("main");
    expect(chat.default_branch).toBe("main");
    expect(chat.profile).toBeNull();
    expect(chat.workspace_path).toBeNull();
    expect(chat.session_dir).toBeNull();
    expect(chat.status).toBe("idle");
    expect(chat.last_error).toBeNull();
    expect(chat.preview).toBe("");

    const fetched = store.get(chat.id);
    expect(fetched.repo).toBe("owner/repo");
  });

  it("creates with optional fields", () => {
    const chat = store.create({
      title: "Fix auth",
      repo: "acme/api",
      branch: "develop",
      default_branch: "main",
      profile: "cheap",
    });
    expect(chat.title).toBe("Fix auth");
    expect(chat.profile).toBe("cheap");
  });

  it("defaults thinking_level to medium on create", () => {
    const chat = store.create({ repo: "a/b", branch: "main", default_branch: "main" });
    expect(chat.thinking_level).toBe("medium");
  });

  it("persists thinking_level when supplied on create", () => {
    const chat = store.create({
      repo: "a/b",
      branch: "main",
      default_branch: "main",
      thinking_level: "high",
    });
    expect(chat.thinking_level).toBe("high");
    // Round-trips through get().
    expect(store.get(chat.id).thinking_level).toBe("high");
  });

  it("updates thinking_level", () => {
    const chat = store.create({ repo: "a/b", branch: "main", default_branch: "main" });
    store.update(chat.id, { thinking_level: "xhigh" });
    expect(store.get(chat.id).thinking_level).toBe("xhigh");
  });

  it("lists chats newest-first", () => {
    store.create({ repo: "a/b", branch: "main", default_branch: "main" });
    store.create({ repo: "c/d", branch: "main", default_branch: "main" });
    const list = store.list();
    expect(list.length).toBe(2);
    expect(list[0].repo).toBe("c/d");
  });

  it("updates editable fields", () => {
    const chat = store.create({ repo: "a/b", branch: "main", default_branch: "main" });
    store.update(chat.id, { title: "Updated", status: "running", workspace_path: "/tmp/abc" });
    const updated = store.get(chat.id);
    expect(updated.title).toBe("Updated");
    expect(updated.status).toBe("running");
    expect(updated.workspace_path).toBe("/tmp/abc");
  });

  it("delete removes the chat", () => {
    const chat = store.create({ repo: "a/b", branch: "main", default_branch: "main" });
    store.delete(chat.id);
    expect(() => store.get(chat.id)).toThrow();
  });

  /* ---- Messages ---- */

  it("appends and lists messages", () => {
    const chat = store.create({ repo: "a/b", branch: "main", default_branch: "main" });
    store.appendMessage(chat.id, { role: "user", text: "Hello" });
    store.appendMessage(chat.id, { role: "assistant", text: "Hi there" });
    store.appendMessage(chat.id, { role: "tool", text: "output", tool_name: "bash", tool_call_id: "tc1" });

    const msgs = store.listMessages(chat.id);
    expect(msgs.length).toBe(3);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].text).toBe("Hello");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[2].role).toBe("tool");
    expect(msgs[2].tool_name).toBe("bash");
    expect(msgs[2].tool_call_id).toBe("tc1");
  });

  it("cascade-deletes messages when chat is deleted", () => {
    const chat = store.create({ repo: "a/b", branch: "main", default_branch: "main" });
    store.appendMessage(chat.id, { role: "user", text: "test" });
    store.appendMessage(chat.id, { role: "assistant", text: "reply" });
    store.delete(chat.id);
    // listMessages returns [] for a deleted chat (rows cascade-deleted).
    const msgs = store.listMessages(chat.id);
    expect(msgs.length).toBe(0);
  });

  it("bumps updated_at and preview on appendMessage", () => {
    const chat = store.create({ repo: "a/b", branch: "main", default_branch: "main" });
    store.appendMessage(chat.id, { role: "user", text: "First message" });
    const after = store.get(chat.id);
    expect(after.preview).toBe("First message");

    // A tool message doesn't update the preview.
    store.appendMessage(chat.id, { role: "tool", text: "raw output", tool_name: "grep" });
    const afterTool = store.get(chat.id);
    expect(afterTool.preview).toBe("First message"); // unchanged

    // An assistant message does update the preview.
    store.appendMessage(chat.id, { role: "assistant", text: "Here is my answer." });
    const afterAsst = store.get(chat.id);
    expect(afterAsst.preview).toBe("Here is my answer.");
  });

  it("truncates long previews to 80 chars", () => {
    const chat = store.create({ repo: "a/b", branch: "main", default_branch: "main" });
    const longText = "A".repeat(100);
    store.appendMessage(chat.id, { role: "user", text: longText });
    const after = store.get(chat.id);
    expect(after.preview.length).toBeLessThanOrEqual(81); // 80 + "…"
    expect(after.preview).toMatch(/…$/);
  });

  /* ---- Stale reset ---- */

  it("resetStaleRunning flips running chats to errored", () => {
    const chat = store.create({ repo: "a/b", branch: "main", default_branch: "main" });
    store.update(chat.id, { status: "running" });
    const count = store.resetStaleRunning();
    expect(count).toBe(1);
    const updated = store.get(chat.id);
    expect(updated.status).toBe("errored");
    expect(updated.last_error).toBe("server restarted while running");
  });

  it("resetStaleRunning ignores non-running chats", () => {
    store.create({ repo: "a/b", branch: "main", default_branch: "main" }); // idle
    const count = store.resetStaleRunning();
    expect(count).toBe(0);
  });

  /* ---- Error cases ---- */

  it("get throws for missing id", () => {
    expect(() => store.get(9999)).toThrow("chat 9999 not found");
  });

  it("getMessage throws for missing id", () => {
    expect(() => store.getMessage(9999)).toThrow("chat message 9999 not found");
  });
});
