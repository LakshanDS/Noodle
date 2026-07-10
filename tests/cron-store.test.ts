import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CronStore, sqliteUtc } from "../src/server/cron-store.js";

let dir: string;
let store: CronStore;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-cron-"));
  db = new Database(join(dir, "test.db"));
  store = CronStore.fromDb(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("CronStore", () => {
  it("creates a cron job and reads it back", () => {
    const cron = store.createCron({
      name: "Bug sweep",
      repo: "owner/repo",
      prompt: "Find bugs",
      branch_name: "wa-agent",
      cron_expression: "0 0 * * *",
    });
    expect(cron.name).toBe("Bug sweep");
    expect(cron.repo).toBe("owner/repo");
    expect(cron.enabled).toBe(1);
    expect(cron.next_run_at).not.toBeNull();
    expect(cron.id).toBeGreaterThan(0);

    const fetched = store.getCron(cron.id);
    expect(fetched.name).toBe("Bug sweep");
  });

  it("seeds next_run_at from the expression on create", () => {
    const cron = store.createCron({
      name: "hourly",
      repo: "o/r",
      prompt: "p",
      branch_name: "b",
      cron_expression: "0 * * * *",
    });
    // next_run_at should be within the next hour.
    expect(cron.next_run_at).toBeTruthy();
  });

  it("disabled crons get null next_run_at on create", () => {
    const cron = store.createCron({
      name: "disabled",
      repo: "o/r",
      prompt: "p",
      branch_name: "b",
      cron_expression: "0 0 * * *",
      enabled: 0,
    });
    expect(cron.enabled).toBe(0);
    expect(cron.next_run_at).toBeNull();
  });

  it("updates fields and recomputes next_run_at when expression changes", () => {
    const cron = store.createCron({
      name: "test",
      repo: "o/r",
      prompt: "p",
      branch_name: "b",
      cron_expression: "0 0 * * *",
    });
    const oldNext = cron.next_run_at;
    const updated = store.updateCron(cron.id, { cron_expression: "0 * * * *", prompt: "new prompt" });
    expect(updated.prompt).toBe("new prompt");
    expect(updated.cron_expression).toBe("0 * * * *");
    // next_run_at changes because the expression changed.
    expect(updated.next_run_at).not.toBe(oldNext);
  });

  it("re-enabling a disabled cron recomputes next_run_at", () => {
    const cron = store.createCron({
      name: "test",
      repo: "o/r",
      prompt: "p",
      branch_name: "b",
      cron_expression: "0 0 * * *",
      enabled: 0,
    });
    expect(cron.next_run_at).toBeNull();
    const enabled = store.updateCron(cron.id, { enabled: 1 });
    expect(enabled.enabled).toBe(1);
    expect(enabled.next_run_at).not.toBeNull();
  });

  it("disabling clears next_run_at", () => {
    const cron = store.createCron({
      name: "test",
      repo: "o/r",
      prompt: "p",
      branch_name: "b",
      cron_expression: "0 0 * * *",
    });
    expect(cron.next_run_at).not.toBeNull();
    const disabled = store.updateCron(cron.id, { enabled: 0 });
    expect(disabled.enabled).toBe(0);
    expect(disabled.next_run_at).toBeNull();
  });

  it("deletes a cron", () => {
    const cron = store.createCron({
      name: "test",
      repo: "o/r",
      prompt: "p",
      branch_name: "b",
      cron_expression: "0 0 * * *",
    });
    store.deleteCron(cron.id);
    expect(() => store.getCron(cron.id)).toThrow(/not found/);
  });

  it("listCrons returns all crons newest-first", () => {
    store.createCron({ name: "first", repo: "o/r", prompt: "p", branch_name: "b", cron_expression: "0 0 * * *" });
    store.createCron({ name: "second", repo: "o/r", prompt: "p", branch_name: "b", cron_expression: "0 0 * * *" });
    const list = store.listCrons();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("second");
  });

  it("listDueCrons returns only enabled crons whose next_run_at has passed", () => {
    const due = store.createCron({
      name: "due",
      repo: "o/r",
      prompt: "p",
      branch_name: "b",
      cron_expression: "0 0 * * *",
    });
    const notDue = store.createCron({
      name: "not-due",
      repo: "o/r",
      prompt: "p",
      branch_name: "b",
      cron_expression: "0 0 * * *",
    });
    // Force `due`'s next_run_at into the past; leave `notDue` in the future.
    db.prepare("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?")
      .run("2020-01-01 00:00:00", due.id);
    const dueList = store.listDueCrons(new Date());
    const ids = dueList.map((c) => c.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(notDue.id);
  });

  it("listDueCrons skips disabled crons", () => {
    const disabled = store.createCron({
      name: "disabled",
      repo: "o/r",
      prompt: "p",
      branch_name: "b",
      cron_expression: "0 0 * * *",
      enabled: 0,
    });
    // Even with a past next_run_at, disabled crons are excluded.
    db.prepare("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?")
      .run("2020-01-01 00:00:00", disabled.id);
    const dueList = store.listDueCrons(new Date());
    expect(dueList.map((c) => c.id)).not.toContain(disabled.id);
  });

  it("markScheduled stamps last_run_at and advances next_run_at", () => {
    const cron = store.createCron({
      name: "test",
      repo: "o/r",
      prompt: "p",
      branch_name: "b",
      cron_expression: "0 * * * *",
    });
    const beforeNext = cron.next_run_at;
    // Advance "now" 2 hours into the future so the next fire time moves past
    // the create-time computation (which used the real now).
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    store.markScheduled(cron.id, later);
    const updated = store.getCron(cron.id);
    expect(updated.last_run_at).not.toBeNull();
    // next_run_at should have advanced (computed from 2h later, not create time).
    expect(updated.next_run_at).not.toBe(beforeNext);
  });

  it("nextRunFromExpr throws on an invalid expression", () => {
    expect(() => CronStore.nextRunFromExpr("not a cron")).toThrow();
  });
});

describe("sqliteUtc", () => {
  it("formats a Date as SQLite datetime without T/Z separators", () => {
    const d = new Date("2026-07-11T12:00:00.000Z");
    expect(sqliteUtc(d)).toBe("2026-07-11 12:00:00");
  });

  it("pads single-digit components", () => {
    const d = new Date("2026-01-05T03:07:09.000Z");
    expect(sqliteUtc(d)).toBe("2026-01-05 03:07:09");
  });
});
