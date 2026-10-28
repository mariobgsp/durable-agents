import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { logPath } from "./paths.ts";

/**
 * One logger, two sinks: the log file (JSON lines, rotated) and the terminal when the daemon runs
 * in the foreground. Level policy is part of the product: info records lifecycle, connection
 * success, conversation start/finish and errors; debug adds per-update and per-edit detail. No
 * secrets are ever passed to it — callers redact before logging.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LoggerOptions = {
  level?: LogLevel;
  file?: boolean;
  console?: boolean;
  maxBytes?: number;
  keep?: number;
};

const defaults: Required<LoggerOptions> = {
  level: (process.env.DURA_LOG_LEVEL as LogLevel) ?? "info",
  file: true,
  console: false,
  maxBytes: 5 * 1024 * 1024,
  keep: 3,
};
let options: Required<LoggerOptions> = { ...defaults };
let queue: Promise<void> = Promise.resolve();
const ring: string[] = [];
const RING = 200;

export function configureLogger(next: LoggerOptions): void {
  options = { ...options, ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) } as Required<LoggerOptions>;
}

export function logLevel(): LogLevel {
  return options.level;
}

export function setLogLevel(level: LogLevel): void {
  options.level = level;
}

function jsonLine(level: LogLevel, event: string, fields: LogFields): string {
  return JSON.stringify({ at: new Date().toISOString(), level, event, ...fields });
}

async function rotate(): Promise<void> {
  const size = await stat(logPath).then((entry) => entry.size).catch(() => 0);
  if (size < options.maxBytes) return;
  for (let index = options.keep - 1; index >= 1; index -= 1) {
    await rename(logPath + "." + index, logPath + "." + (index + 1)).catch(() => undefined);
  }
  await rename(logPath, logPath + ".1").catch(() => undefined);
  await rm(logPath, { force: true });
}

function write(level: LogLevel, event: string, fields: LogFields): void {
  if (ORDER[level] < ORDER[options.level]) return;
  const line = jsonLine(level, event, fields);
  ring.push(line);
  while (ring.length > RING) ring.shift();
  if (options.console) {
    const prefix = level === "debug" ? "[debug] " : level === "info" ? "" : "[" + level + "] ";
    const detail = Object.keys(fields).length > 0 ? " " + JSON.stringify(fields) : "";
    const sink = level === "error" || level === "warn" ? console.error : console.log;
    sink(prefix + event + detail);
  }
  if (!options.file) return;
  queue = queue
    .then(async () => {
      await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
      await rotate();
      await appendFile(logPath, line + "\n", { mode: 0o600 });
    })
    .catch(() => undefined);
}

export const log = {
  debug(event: string, fields: LogFields = {}): void {
    write("debug", event, fields);
  },
  info(event: string, fields: LogFields = {}): void {
    write("info", event, fields);
  },
  warn(event: string, fields: LogFields = {}): void {
    write("warn", event, fields);
  },
  error(event: string, fields: LogFields = {}): void {
    write("error", event, fields);
  },
};

/** Flush the append queue; called on shutdown so the last lines are on disk. */
export async function flushLog(): Promise<void> {
  await queue.catch(() => undefined);
}

/** The last lines this process wrote, for IPC clients that ask without reading the file. */
export function recentLogLines(limit = 50): string[] {
  return ring.slice(-limit);
}

/** Redact obvious secret shapes before a value is logged. */
export function redact(value: string): string {
  return value
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "<telegram-token>")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "<api-key>");
}

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return { error: redact(error.message), stack: error.stack ? redact(error.stack) : undefined };
  }
  return { error: redact(String(error)) };
}
