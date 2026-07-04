import pino, { multistream } from "pino";
import pretty from "pino-pretty";
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { resolve } from "node:path";

/**
 * Noodle's logger. Pretty in dev (LOG_LEVEL=debug), JSON in prod.
 * Use `child({ repo, issue, jobId })` per job for correlated logs.
 */
const level = process.env.LOG_LEVEL ?? "info";
const isDev = !process.env.NOODLE_JSON_LOGS && process.stdout.isTTY;

export const log = isDev
  ? pino({ level, transport: { target: "pino-pretty", options: { colorize: true } } })
  : pino({ level });

export type Logger = typeof log;

/**
 * Directory holding per-run log files (one JSON-Lines file per agent run,
 * named after the branch). Read lazily so tests can point NOODLE_LOGS_DIR at a
 * tmp dir without re-importing the module. Resolved relative to cwd.
 */
function logsDir(): string {
  return resolve(process.env.NOODLE_LOGS_DIR ?? "./logs");
}

/**
 * Turn a git branch name into a safe filename component. Branch names can
 * contain `/` (e.g. `noodle/issue-42-abc`) which is invalid in a filename.
 */
function slugifyBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/**
 * Build a per-run logger that writes JSON-Lines to `logs/<branch-slug>.log`
 * AND mirrors to the console (pretty in dev, JSON in prod). Both Noodle's own
 * steps and every pi agent event flow through this single logger.
 *
 * `context` is bound to every line (jobId, repo, issue, branch) for correlation.
 * Returns the absolute path of the file written, alongside the logger and a
 * `ready` promise.
 *
 * `ready` resolves once the file's write stream has its fd open. In production
 * callers don't need to await it — pino buffers early writes until the stream
 * opens — but tests should await it before reading the file back.
 *
 * Uses in-process `multistream` (not a worker transport) so file writes are
 * durable in-process — important for not losing the final lines when the
 * process exits.
 */
export function createRunLogger(
  branchName: string,
  context: Record<string, unknown>,
): { log: Logger; filePath: string; ready: Promise<void> } {
  const dir = logsDir();
  mkdirSync(dir, { recursive: true });
  const slug = slugifyBranch(branchName);
  const filePath = resolve(dir, `${slug}.log`);

  // File destination always emits raw newline-delimited JSON.
  const fileStream: WriteStream = createWriteStream(filePath, { flags: "a" });
  const ready = new Promise<void>((resolve, reject) => {
    fileStream.once("open", () => resolve());
    fileStream.once("error", reject);
  });

  // Console mirror: pretty+colored in dev, raw JSON to stdout in prod.
  // multistream forwards one serialized line to every stream, so the pretty
  // console view is produced by piping through pino-pretty as a Transform.
  const consoleStream = isDev
    ? pretty({ colorize: true, translateTime: "SYS:HH:MM:ss.l" })
    : process.stdout;

  const base = pino({ level }, multistream([
    { stream: fileStream, level },
    { stream: consoleStream, level },
  ]));

  return { log: base.child(context), filePath, ready };
}
