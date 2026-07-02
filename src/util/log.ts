import pino from "pino";

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
