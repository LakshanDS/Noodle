import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunLogger } from "../src/util/log.js";

/** Wait until the file at `filePath` contains at least `minLines` lines. */
async function waitForLines(filePath: string, minLines: number, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = readFileSync(filePath, "utf8").trim();
      if (content && content.split("\n").length >= minLines) return;
    } catch {
      // file not readable yet — keep waiting
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${minLines} lines in ${filePath}`);
}

/**
 * createRunLogger reads NOODLE_LOGS_DIR lazily, so we point it at a throwaway
 * tmp dir per test, build a logger, await `ready` (the file fd is open), write,
 * then read the file back and assert valid JSON-Lines + the bound context.
 */
let dir: string;
const createdDirs: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noodle-log-"));
  createdDirs.push(dir);
  process.env.NOODLE_LOGS_DIR = dir;
  process.env.NOODLE_JSON_LOGS = "1"; // pick the JSON-stdout branch regardless of tty
});

afterEach(() => {
  for (const d of createdDirs) rmSync(d, { recursive: true, force: true });
  createdDirs.length = 0;
  delete process.env.NOODLE_LOGS_DIR;
  delete process.env.NOODLE_JSON_LOGS;
});

describe("createRunLogger", () => {
  it("writes valid newline-delimited JSON to logs/<branch-slug>.log", async () => {
    const { log, filePath, ready } = createRunLogger("noodle/issue-42-abc12345", {
      jobId: "job-1",
      repo: "owner/name",
      issue: 42,
    });
    await ready;
    log.info({ step: "clone" }, "cloned repo");
    log.info({ step: "commit" }, "committed");
    await waitForLines(filePath, 2);

    const content = readFileSync(filePath, "utf8").trim();
    const lines = content.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const obj = JSON.parse(line); // throws if not valid JSON
      expect(obj.msg).toBeTypeOf("string");
    }
  });

  it("slugifies the branch name (/ -> -) for the filename", async () => {
    const { filePath, ready } = createRunLogger("noodle/issue-7-xyz", { jobId: "j", repo: "o/r", issue: 7 });
    await ready;
    expect(filePath).toMatch(/[\\/]noodle-issue-7-xyz\.log$/);
  });

  it("binds the context fields onto every log line", async () => {
    const { log, filePath, ready } = createRunLogger("noodle/issue-9-a1", {
      jobId: "job-9",
      repo: "owner/repo",
      issue: 9,
      branch: "noodle/issue-9-a1",
    });
    await ready;
    log.info("hello");
    await waitForLines(filePath, 1);

    const obj = JSON.parse(readFileSync(filePath, "utf8").trim());
    expect(obj.jobId).toBe("job-9");
    expect(obj.repo).toBe("owner/repo");
    expect(obj.issue).toBe(9);
    expect(obj.branch).toBe("noodle/issue-9-a1");
    expect(obj.msg).toBe("hello");
  });

  it("creates the logs directory if it does not exist", async () => {
    const nested = join(dir, "deeper", "logs");
    process.env.NOODLE_LOGS_DIR = nested;
    const { log, filePath, ready } = createRunLogger("noodle/issue-1-z", { jobId: "j", repo: "o/r", issue: 1 });
    await ready;
    log.info("deep");
    await waitForLines(filePath, 1);
    expect(filePath.startsWith(nested)).toBe(true);
    expect(readFileSync(filePath, "utf8").trim().length).toBeGreaterThan(0);
  });
});
