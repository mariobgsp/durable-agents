import { spawn } from "node:child_process";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { watch } from "node:fs";
import { type Parsed, flag, flagAll, has } from "../args.ts";
import { print, printError, paint, fail, json } from "../output.ts";
import { readConfig, validateConfig, type DuraConfig } from "../../../core/src/config.ts";
import { duraHome, readyPath, runDir } from "../../../core/src/paths.ts";
import { startDaemon } from "../../../core/src/daemon.ts";
import { log } from "../../../core/src/logger.ts";

const BIN = resolve(import.meta.dirname, "../../bin/dura.ts");

type Channels = {
  start(): Promise<void>;
  stop(): Promise<void>;
  status?(): Promise<Record<string, unknown>>;
  methods?: Record<string, (params: Record<string, unknown>, connection: never) => Promise<unknown>>;
  verifyExtra?: () => Promise<import("../../../core/src/verify.ts").Check[]>;
  botLabels?: () => Promise<string[]>;
};

/**
 * Exactly one transport is imported and started. Core never imports either package; this
 * composition point is the only place the two meet, and the config enum is the only switch.
 */
async function loadChannels(parsed: Parsed, config: DuraConfig): Promise<Channels | undefined> {
  if (has(parsed, "no-chat") || has(parsed, "no-telegram")) return undefined;
  if (config.chat.active === "telegram") {
    try {
      const module = await import("../../../telegram/src/index.ts");
      return module.createTelegramTransport();
    } catch (error) {
      throw new Error("cannot load the Telegram transport: " + String(error));
    }
  }
  if (config.chat.active === "discord") {
    try {
      const module = await import("../../../discord/src/index.ts");
      return module.createDiscordTransport();
    } catch (error) {
      throw new Error("cannot load the Discord transport: " + String(error));
    }
  }
  throw new Error("chat.active must be telegram or discord (got " + JSON.stringify(config.chat.active) + ")");
}

async function waitForReady(pid: number, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const parsed = JSON.parse(await readFile(readyPath, "utf8")) as Record<string, unknown>;
      if (parsed.pid === pid) return parsed;
    } catch {
      // not ready yet
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error("the daemon did not become ready within " + timeoutMs + "ms; see the log with: dura logs");
}

function childArgs(parsed: Parsed, foreground: boolean): string[] {
  const args = [BIN, "start", ...(foreground ? ["--foreground"] : [])];
  if (has(parsed, "no-chat") || has(parsed, "no-telegram")) args.push("--no-chat");
  for (const label of flagAll(parsed, "bot")) args.push("--bot", label);
  return args;
}

export async function startDetached(parsed: Parsed): Promise<void> {
  const child = spawn(process.execPath, childArgs(parsed, true), {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  if (!child.pid) fail("could not start the daemon process");
  const ready = await waitForReady(child.pid);
  if (has(parsed, "json")) json(ready);
  else {
    print(paint("green", "daemon started") + " · pid " + child.pid + " · " + duraHome);
    print("socket " + String(ready.socket));
    print("next: dura status");
  }
}

async function runForeground(parsed: Parsed): Promise<void> {
  const config = await readConfig();
  const problems = validateConfig(config);
  if (problems.length > 0) throw new Error("invalid config: " + problems.join("; "));
  const channels = await loadChannels(parsed, config);
  const handle = await startDaemon({
    config,
    console: true,
    channels,
    methods: channels?.methods as never,
    verifyExtra: channels?.verifyExtra,
    botLabels: channels?.botLabels,
  });
  process.once("SIGINT", () => void handle.stop(0));
  process.once("SIGTERM", () => void handle.stop(0));
  await new Promise<void>(() => undefined);
}

async function runWatch(parsed: Parsed): Promise<void> {
  let child: ReturnType<typeof spawn> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let shuttingDown = false;

  const start = (): void => {
    child = spawn(process.execPath, childArgs(parsed, false), { stdio: "inherit", env: process.env });
  };
  const restart = (): void => {
    if (shuttingDown) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      child?.kill("SIGTERM");
      setTimeout(() => {
        child?.kill("SIGKILL");
        start();
      }, 500);
    }, 400);
  };
  const shutdown = (): void => {
    shuttingDown = true;
    child?.kill("SIGTERM");
    setTimeout(() => process.exit(0), 300);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  start();
  for (const dir of ["../../../core/src", "../../../telegram/src", "../../../discord/src"]) {
    const target = resolve(import.meta.dirname, dir);
    try {
      await stat(target);
      watch(target, { recursive: true }, (_event, name) => {
        if (!name?.endsWith(".ts")) return;
        print(paint("dim", "changed " + name + ", restarting"));
        restart();
      });
    } catch {
      // a package that does not exist yet is not a failure
    }
  }
  await new Promise<void>(() => undefined);
}

export async function runStart(parsed: Parsed): Promise<void> {
  if (has(parsed, "watch")) {
    await runWatch(parsed);
    return;
  }
  const foreground = has(parsed, "foreground") || (process.stdout.isTTY && !has(parsed, "detach"));
  if (foreground) {
    try {
      await runForeground(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("already running")) fail(message, 4);
      printError(message);
      process.exit(1);
    }
    return;
  }
  await startDetached(parsed);
}

export { waitForReady };
