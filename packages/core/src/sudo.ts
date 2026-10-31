import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, statfs, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { readAgent } from "./agents.ts";
import { harnessInstance } from "./harness.ts";
import { log } from "./logger.ts";
import { agentResolver } from "./remember.ts";
import { policyOf } from "./permissions.ts";
import { sudoPath } from "./paths.ts";
import {
  detectMaintenance,
  resolveBinary,
  type Command,
  type Maintenance,
  type MaintenanceCommands,
  type SudoMode,
} from "./platform.ts";

/**
 * The sudo tool: owner-approved maintenance that actually runs as root.
 *
 * The daemon's unit forbids setuid sudo, so approved commands run in a transient systemd user unit, a
 * sibling of dura.service. That unit has default sandbox settings, which is what lets sudo and package
 * managers work without weakening the daemon's own hardening. The host's sudoers file is the authority:
 * the installer writes one exact rule per detected command, and this tool runs exactly those commands.
 *
 * Every use is a chat question with the exact commands and a preview. Approval is a one-shot grant bound
 * to the conversation, the agent and the command list; a different command asks again. A denial or a
 * restart of the daemon runs nothing.
 */

export type SudoAction = "cleanup" | "memory" | "update" | "run";

export type SudoConfig = {
  version: 1;
  mode: SudoMode;
  installedAt: number;
  user: string;
  os: { id: string; name: string; versionId: string; family: string };
  manager: string;
  /** A harmless command that proves the sudoers rule is effective; empty when no safe probe exists. */
  probe: Command;
  /** Cache directories, recorded at install time so the preview does not depend on the current user's access. */
  cachePaths: string[];
  commands: MaintenanceCommands;
};

type Pending = {
  action: SudoAction;
  agentId: string;
  commands: Command[];
  expiresAt: number;
};

type Outcome = {
  command: Command;
  body: string;
  capturedBytes: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  unit?: string;
  spawnError?: string;
};

type RunOptions = {
  timeoutMs: number;
  sudo: string;
  systemdRun?: string;
  label?: string;
};

const APPROVAL_TTL_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
const TEXT_LIMIT = 24_000;
const HALF_BUFFER = 2 * 1024 * 1024;
const execFileAsync = promisify(execFile);

const NOT_INSTALLED =
  "Privileged actions are not installed on this host. Ask the owner to run \"dura sudo install\" once in a " +
  "terminal (add --root only if arbitrary commands should be allowed).";

const pending = new Map<string, Pending>();
const grants = new Map<string, Pending>();
let executing = false;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function keyOf(conversationId: string, digest: string): string {
  return conversationId + ":" + digest;
}

function prune(): void {
  const now = Date.now();
  for (const [key, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(key);
  }
  for (const [key, entry] of grants) {
    if (entry.expiresAt <= now) grants.delete(key);
  }
}

function digestOf(conversationId: string, agentId: string, action: SudoAction, commands: Command[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ conversationId, agentId, action, commands }))
    .digest("hex");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isCommand(value: unknown): value is Command {
  return isStringArray(value) && value.length > 0 && value.every((entry) => entry.length > 0);
}

function isCommandList(value: unknown): value is Command[] {
  return Array.isArray(value) && value.every((entry) => isCommand(entry));
}

/** A narrow reader: a corrupt or older record is no record, not a guessed configuration. */
export async function readSudoConfig(): Promise<SudoConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(sudoPath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  if (record.mode !== "fixed" && record.mode !== "root") return undefined;
  if (typeof record.installedAt !== "number" || typeof record.user !== "string") return undefined;
  const os = record.os as Record<string, unknown> | undefined;
  if (!os || typeof os.id !== "string" || typeof os.name !== "string") return undefined;
  const commands = record.commands as Record<string, unknown> | undefined;
  if (
    !commands ||
    !isCommandList(commands.update) ||
    !isCommandList(commands.cleanup) ||
    !isCommandList(commands.memory)
  ) {
    return undefined;
  }
  if (!isStringArray(record.probe)) {
    return undefined;
  }
  return {
    version: 1,
    mode: record.mode as SudoMode,
    installedAt: record.installedAt,
    user: record.user,
    os: {
      id: os.id,
      name: os.name,
      versionId: typeof os.versionId === "string" ? os.versionId : "",
      family: typeof os.family === "string" ? os.family : "",
    },
    manager: typeof record.manager === "string" ? record.manager : "unknown",
    probe: record.probe,
    cachePaths: Array.isArray(record.cachePaths)
      ? record.cachePaths.filter((entry): entry is string => typeof entry === "string")
      : [],
    commands: {
      update: commands.update,
      cleanup: commands.cleanup,
      memory: commands.memory,
    },
  };
}

export async function saveSudoConfig(config: SudoConfig): Promise<void> {
  await mkdir(dirname(sudoPath), { recursive: true, mode: 0o700 });
  const temporary = sudoPath + ".tmp";
  await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, sudoPath);
}

/**
 * Owner approval, called by the transport when the button is pressed.
 *
 * The pending entry is the proof that this exact command was asked for: the transport passes only the
 * digest from the question data, and a missing or expired entry refuses. A grant is one-shot: the tool
 * consumes it on the retry and refuses if it is gone.
 */
export async function approveSudoRequest(
  conversationId: string,
  digest: string,
): Promise<{ ok: boolean; message: string }> {
  prune();
  const key = keyOf(conversationId, digest);
  const entry = pending.get(key);
  if (!entry) {
    return { ok: false, message: "This approval expired; ask the agent to try again." };
  }
  pending.delete(key);
  grants.set(key, { ...entry, expiresAt: Date.now() + APPROVAL_TTL_MS });
  log.info("sudo.approved", { agentId: entry.agentId, action: entry.action });
  return {
    ok: true,
    message: "Approved. Retry the sudo tool with exactly the same action and arguments.",
  };
}

export function denySudoRequest(
  conversationId: string,
  digest: string,
): { ok: boolean; message: string } {
  const key = keyOf(conversationId, digest);
  const entry = pending.get(key);
  if (!entry) {
    return { ok: false, message: "This approval expired; ask the agent to try again." };
  }
  pending.delete(key);
  log.info("sudo.denied", { agentId: entry.agentId, action: entry.action });
  return { ok: true, message: "Denied. Do not retry that command." };
}

function refusal(message: string): { output: { type: "text"; text: string }[]; isError: true } {
  return { output: [{ type: "text", text: message }], isError: true };
}

function reply(message: string): { output: { type: "text"; text: string }[] } {
  return { output: [{ type: "text", text: message }] };
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(value), 60_000), MAX_TIMEOUT_MS);
}

function displayArgument(argument: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(argument) ? argument : JSON.stringify(argument);
}

function humanBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return (unit === 0 ? String(Math.round(size)) : size.toFixed(1)) + " " + (units[unit] ?? "B");
}

function validateRunCommand(value: string[] | undefined): { command: Command } | { problem: string } {
  if (value === undefined || value.length === 0) {
    return { problem: "The run action needs a non-empty command array." };
  }
  if (value.length > 32) {
    return { problem: "The run action accepts at most 32 arguments." };
  }
  for (const argument of value) {
    if (typeof argument !== "string" || argument.length === 0) {
      return { problem: "Every command argument must be a non-empty string." };
    }
    if (argument.length > 4096) {
      return { problem: "One command argument is too long (limit 4096 characters)." };
    }
    if (/[\u0000-\u001f\u007f]/.test(argument)) {
      return { problem: "Command arguments must not contain control characters." };
    }
  }
  return { command: value };
}

async function askOwner(input: {
  conversationId: unknown;
  context: Context;
  agentId: string;
  text: string;
  digest: string;
  entry: Pending;
  mapKey: string;
}): Promise<boolean> {
  // The harness handle, not api.conversation(): this is a passive entry write, the same call the question
  // tool uses, and it works while this run is active.
  const conversation = await harnessInstance().conversation(input.conversationId as never, input.context);
  if (!conversation) return false;
  pending.set(input.mapKey, input.entry);
  try {
    await conversation.submit(
      {
        type: "write",
        entry: {
          kind: "chat.question",
          data: {
            text: input.text,
            author: input.agentId,
            options: ["Run it", "Deny"],
            approval: { kind: "sudo", action: input.entry.action, digest: input.digest },
          },
        },
      },
      input.context,
    );
    return true;
  } catch (error) {
    pending.delete(input.mapKey);
    log.warn("sudo.ask_failed", { error: messageOf(error).slice(0, 300) });
    return false;
  }
}

async function askPrompt(input: {
  action: SudoAction;
  config: SudoConfig;
  commands: Command[];
  reason?: string;
}): Promise<string> {
  const host =
    "Detected " +
    (input.config.os.name || input.config.os.id || "Linux") +
    " (" +
    input.config.manager +
    ", " +
    input.config.mode +
    " mode).";
  const lines: string[] = [host, ""];
  if (input.action === "cleanup") {
    lines.push("Clean system caches and temporary files?");
    const sizes = await cleanupPreview(input.config.cachePaths);
    if (sizes.length > 0) lines.push("", ...sizes);
  } else if (input.action === "memory") {
    lines.push("Drop page cache, dentries and inodes?");
    const memory = await memoryInfo();
    if (memory) {
      lines.push(
        "",
        "Memory now: " + humanBytes(memory.available) + " available, " + humanBytes(memory.cache) + " cache.",
      );
    }
  } else if (input.action === "update") {
    lines.push("Update all system packages?");
  } else {
    lines.push("Run this command as root?");
  }
  lines.push("", "Will run:", ...input.commands.map((command) => "$ sudo " + command.map(displayArgument).join(" ")));
  if (input.action === "cleanup") {
    lines.push(
      "",
      "Only package caches, journal data beyond 200 MB and system temp files are removed. Project folders and user files are not touched.",
    );
  }
  if (input.action === "memory") {
    lines.push("", "No swap changes and no processes are killed.");
  }
  if (input.reason) {
    const reason = input.reason.replace(/\s+/g, " ").trim().slice(0, 300);
    if (reason.length > 0) lines.push("", "Reason: " + reason);
  }
  return lines.join("\n").slice(0, 1800);
}

async function cleanupPreview(cachePaths: string[]): Promise<string[]> {
  const lines: string[] = [];
  const cache = await duBytes(cachePaths);
  if (cache !== undefined) lines.push("Package cache: ~" + humanBytes(cache));
  const journal = (await duBytes(["/var/log/journal"])) ?? (await journalDiskUsage());
  if (journal !== undefined) lines.push("Journal: ~" + humanBytes(journal));
  const temp = await duBytes(["/tmp", "/var/tmp"]);
  if (temp !== undefined) lines.push("Temp: ~" + humanBytes(temp));
  return lines;
}

async function duBytes(paths: string[]): Promise<number | undefined> {
  if (paths.length === 0) return undefined;
  const du = await resolveBinary("du");
  if (!du) return undefined;
  let total = 0;
  let found = false;
  for (const path of paths) {
    try {
      const { stdout } = await execFileAsync(du, ["-sb", path], { timeout: 5_000, maxBuffer: 1024 * 1024 });
      const first = String(stdout).split("\n")[0] ?? "";
      if (first.length === 0) continue;
      const size = Number(first.split(/\s+/)[0]);
      if (Number.isFinite(size) && size >= 0) {
        total += size;
        found = true;
      }
    } catch {
      // A missing or unreadable path is an absent line, not a failed preview.
    }
  }
  return found ? total : undefined;
}

async function journalDiskUsage(): Promise<number | undefined> {
  const journalctl = await resolveBinary("journalctl");
  if (!journalctl) return undefined;
  try {
    const { stdout } = await execFileAsync(journalctl, ["--disk-usage"], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const match = /([\d.]+)\s*([KMGT]?)i?B/i.exec(String(stdout));
    if (!match) return undefined;
    const value = Number(match[1]);
    const unit = (match[2] ?? "").toUpperCase();
    const factor =
      unit === "T" ? 1024 ** 4 : unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1;
    return Math.round(value * factor);
  } catch {
    return undefined;
  }
}

async function memoryInfo(): Promise<{ available: number; cache: number } | undefined> {
  const text = await readFile("/proc/meminfo", "utf8").catch(() => "");
  if (text.length === 0) return undefined;
  const value = (key: string): number | undefined => {
    const match = new RegExp("^" + key + ":\\s+(\\d+) kB", "m").exec(text);
    return match?.[1] ? Number(match[1]) * 1024 : undefined;
  };
  const available = value("MemAvailable") ?? value("MemFree");
  if (available === undefined) return undefined;
  const cache = (value("Cached") ?? 0) + (value("Buffers") ?? 0) + (value("SReclaimable") ?? 0);
  return { available, cache };
}

async function diskFree(): Promise<number | undefined> {
  try {
    const info = await statfs("/");
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return undefined;
  }
}

function daemonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Run one command through sudo, in a transient user unit when systemd-run is available. */
function runOne(command: Command, options: RunOptions): Promise<Outcome> {
  return new Promise((done) => {
    const unit = "dura-sudo-" + Date.now().toString(36) + "-" + randomBytes(3).toString("hex");
    const label = (options.label ?? "command").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "command";
    const inner: string[] = [
      "/usr/bin/env",
      "-i",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "TERM=dumb",
      "PAGER=cat",
      "SYSTEMD_PAGER=cat",
      "DEBIAN_FRONTEND=noninteractive",
    ];
    if (process.env.LANG) inner.push("LANG=" + process.env.LANG);
    inner.push(options.sudo, "-n", "--", ...command);

    const systemdRun = options.systemdRun;
    const useSystemd = systemdRun !== undefined && process.env.XDG_RUNTIME_DIR !== undefined;
    const argv: string[] =
      systemdRun !== undefined && useSystemd
        ? [
            systemdRun,
            "--user",
            "--quiet",
            "--pipe",
            "--wait",
            "--collect",
            "--unit=" + unit,
            "--description=dura sudo: " + label,
            "--",
            ...inner,
          ]
        : inner;
    const unitName = useSystemd ? unit : undefined;

    const head: string[] = [];
    let headBytes = 0;
    const tail: string[] = [];
    let tailBytes = 0;
    let capturedBytes = 0;
    let droppedBytes = 0;
    let timedOut = false;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: string,
    ): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      const middle = droppedBytes > 0 ? "\n[... " + droppedBytes + " bytes of output discarded ...]\n" : "";
      done({
        command,
        body: head.join("") + middle + tail.join(""),
        capturedBytes,
        exitCode,
        signal,
        timedOut,
        ...(unitName ? { unit: unitName } : {}),
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    };

    const absorb = (text: string): void => {
      const bytes = Buffer.byteLength(text);
      capturedBytes += bytes;
      if (headBytes + bytes <= HALF_BUFFER) {
        head.push(text);
        headBytes += bytes;
        return;
      }
      tail.push(text);
      tailBytes += bytes;
      while (tailBytes > HALF_BUFFER) {
        const dropped = tail.shift();
        if (dropped === undefined) break;
        const size = Buffer.byteLength(dropped);
        tailBytes -= size;
        droppedBytes += size;
      }
    };

    let child: ChildProcess;
    try {
      child = spawn(argv[0] ?? "/usr/bin/env", argv.slice(1), {
        cwd: "/",
        env: daemonEnv(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, null, messageOf(error));
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
      // SIGKILL cannot be ignored, but a process stuck in the kernel can outlive it; do not hang the tool.
      setTimeout(() => finish(null, null), 5000).unref();
    }, options.timeoutMs);
    timer.unref();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);
    child.on("error", (error) => finish(null, null, messageOf(error)));
    child.on("close", (code, signal) => {
      // The client has exited; anything still in its group is ours to reap. A transient unit survives a
      // timed-out client, which is what makes a long package update safe to leave running.
      killGroup(child);
      finish(code, signal);
    });
  });
}

async function runCommands(commands: Command[], options: RunOptions): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const command of commands) {
    const outcome = await runOne(command, options);
    outcomes.push(outcome);
    if (outcome.exitCode !== 0 || outcome.timedOut || outcome.spawnError !== undefined) break;
  }
  return outcomes;
}

async function activeUnit(): Promise<string | undefined> {
  const systemctl = await resolveBinary("systemctl");
  if (!systemctl) return undefined;
  try {
    const { stdout } = await execFileAsync(
      systemctl,
      [
        "--user",
        "list-units",
        "--type=service",
        "--state=active",
        "--no-legend",
        "--plain",
        "dura-sudo-*",
      ],
      { timeout: 3_000, maxBuffer: 1024 * 1024 },
    );
    const line = String(stdout)
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    return line ? line.split(/\s+/)[0] : undefined;
  } catch {
    return undefined;
  }
}

function footer(outcome: Outcome, timeoutMs: number): string {
  if (outcome.timedOut) {
    if (outcome.unit) {
      return (
        "timed out after " +
        timeoutMs +
        "ms; the command continues in " +
        outcome.unit +
        " (systemctl --user status " +
        outcome.unit +
        "; journalctl --user -u " +
        outcome.unit +
        ")"
      );
    }
    return "timed out after " + timeoutMs + "ms; the process group was killed";
  }
  if (outcome.spawnError !== undefined) return "could not start: " + outcome.spawnError;
  if (outcome.exitCode === null) return "[no exit code; killed by " + (outcome.signal ?? "a signal") + "]";
  return "[exit code " + outcome.exitCode + "]";
}

function hintFor(outcomes: Outcome[]): string | undefined {
  const body = outcomes.map((outcome) => outcome.body).join("\n");
  if (/a password is required|no tty present/i.test(body)) {
    return "The host does not allow passwordless sudo for this command. Run \"dura sudo status\" and reinstall the rule if needed.";
  }
  if (/not permitted|no new privileges/i.test(body)) {
    return "The command could not gain root. Start the daemon under systemd so the transient unit can be used.";
  }
  return undefined;
}

function formatResult(input: {
  action: SudoAction;
  config: SudoConfig;
  outcomes: Outcome[];
  timeoutMs: number;
  elapsedMs: number;
  diskBefore?: number;
  diskAfter?: number;
  memoryBefore?: { available: number; cache: number };
  memoryAfter?: { available: number; cache: number };
}): { text: string; isError: boolean } {
  const lines: string[] = [
    "Host: " +
      (input.config.os.name || input.config.os.id || "Linux") +
      " (" +
      input.config.manager +
      ", " +
      input.config.mode +
      " mode)",
  ];
  for (const outcome of input.outcomes) {
    lines.push("", "$ sudo " + outcome.command.map(displayArgument).join(" "));
    if (outcome.unit) lines.push("unit: " + outcome.unit);
    const body = outcome.body.replace(/\n+$/, "");
    lines.push("", body.length > 0 ? body : "(no output)", "", footer(outcome, input.timeoutMs));
  }
  const hint = hintFor(input.outcomes);
  if (hint) lines.push("", hint);
  if (input.action === "cleanup" && input.diskBefore !== undefined && input.diskAfter !== undefined) {
    const delta = input.diskAfter - input.diskBefore;
    lines.push(
      "",
      "Disk free: " +
        humanBytes(input.diskBefore) +
        " -> " +
        humanBytes(input.diskAfter) +
        " (" +
        (delta >= 0 ? "+" : "-") +
        humanBytes(Math.abs(delta)) +
        ")",
    );
  }
  if (input.action === "memory" && input.memoryBefore && input.memoryAfter) {
    lines.push(
      "",
      "Memory: available " +
        humanBytes(input.memoryBefore.available) +
        " -> " +
        humanBytes(input.memoryAfter.available) +
        "; cache " +
        humanBytes(input.memoryBefore.cache) +
        " -> " +
        humanBytes(input.memoryAfter.cache),
    );
  }
  lines.push("", "Elapsed: " + Math.max(1, Math.round(input.elapsedMs / 1000)) + "s");
  const isError =
    input.outcomes.length === 0 ||
    input.outcomes.some(
      (outcome) => outcome.exitCode !== 0 || outcome.timedOut || outcome.spawnError !== undefined,
    );
  let text = lines.join("\n");
  if (text.length > TEXT_LIMIT) {
    const note = "\n[truncated: kept " + TEXT_LIMIT + " of " + text.length + " characters]";
    text = text.slice(0, TEXT_LIMIT - note.length) + note;
  }
  return { text, isError };
}

function e2eText(action: SudoAction, config: SudoConfig, commands: Command[]): string {
  return (
    "Host: " +
    (config.os.name || config.os.id || "Linux") +
    " (" +
    config.manager +
    ", " +
    config.mode +
    " mode)\n" +
    "E2E: approved " +
    action +
    "; no privileged command was executed.\n\n" +
    commands.map((command) => "$ sudo " + command.map(displayArgument).join(" ")).join("\n")
  );
}

async function executeGranted(input: {
  conversationId: string;
  agentId: string;
  action: SudoAction;
  commands: Command[];
  config: SudoConfig;
  detected: Maintenance | undefined;
  timeoutMs: number;
}): Promise<{ output: { type: "text"; text: string }[]; isError?: true }> {
  const e2e = process.env.DURA_E2E === "1";
  if (e2e) {
    log.info("sudo.run", {
      agentId: input.agentId,
      conversationId: input.conversationId,
      action: input.action,
      commands: input.commands,
      e2e: true,
    });
    return reply(e2eText(input.action, input.config, input.commands));
  }
  if (executing) {
    return reply("Another privileged command is already running; wait for it to finish and try again.");
  }
  const active = await activeUnit();
  if (active) {
    return reply(
      "A privileged command is still running (" +
        active +
        "). Check systemctl --user status " +
        active +
        " and retry when it finishes.",
    );
  }
  const sudo = input.detected?.tools.sudo;
  if (!sudo) {
    return refusal("sudo was not found on PATH, so the command could not start.");
  }
  executing = true;
  const startedAt = Date.now();
  const diskBefore = input.action === "cleanup" ? await diskFree() : undefined;
  const memoryBefore = input.action === "memory" ? await memoryInfo() : undefined;
  try {
    const timeoutMs = input.timeoutMs;
    const outcomes = await runCommands(input.commands, {
      timeoutMs,
      sudo,
      ...(input.detected?.tools.systemdRun ? { systemdRun: input.detected.tools.systemdRun } : {}),
      label: input.action,
    });
    const diskAfter = input.action === "cleanup" ? await diskFree() : undefined;
    const memoryAfter = input.action === "memory" ? await memoryInfo() : undefined;
    const { text, isError } = formatResult({
      action: input.action,
      config: input.config,
      outcomes,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
      ...(diskBefore !== undefined ? { diskBefore } : {}),
      ...(diskAfter !== undefined ? { diskAfter } : {}),
      ...(memoryBefore ? { memoryBefore } : {}),
      ...(memoryAfter ? { memoryAfter } : {}),
    });
    log.info("sudo.run", {
      agentId: input.agentId,
      conversationId: input.conversationId,
      action: input.action,
      commands: input.commands,
      exitCode: outcomes.at(-1)?.exitCode ?? null,
      timedOut: outcomes.some((outcome) => outcome.timedOut),
      units: outcomes.map((outcome) => outcome.unit).filter((unit): unit is string => unit !== undefined),
    });
    return isError ? { output: [{ type: "text" as const, text }], isError: true } : reply(text);
  } catch (error) {
    log.error("sudo.run_failed", { error: messageOf(error).slice(0, 300) });
    return refusal("The privileged command could not be started: " + messageOf(error).slice(0, 300));
  } finally {
    executing = false;
  }
}

export const sudoTool = defineTool({
  name: "sudo",
  description:
    "Run one owner-approved privileged maintenance action. cleanup removes the system package cache, journal " +
    "data beyond 200 MB and system temp files; memory drops page cache, dentries and inodes; update runs the " +
    "host package manager's full upgrade; run executes one explicit argv as root and works only in root mode. " +
    "Every call asks the owner in chat with the exact commands. Pass an argv array, never a shell string. " +
    "Nothing runs until the owner presses the approve button and you call this tool again.",
  parameters: Type.Object({
    action: Type.Union(
      [Type.Literal("cleanup"), Type.Literal("memory"), Type.Literal("update"), Type.Literal("run")],
      {
        description: "The maintenance action: cleanup, memory, update, or run (root mode only).",
      },
    ),
    command: Type.Optional(
      Type.Array(Type.String({ description: "One argv element." }), {
        description: "For action run only: the exact argv to execute as root. Never a shell string.",
      }),
    ),
    reason: Type.Optional(
      Type.String({ description: "Optional one-line reason shown in the owner's approval prompt." }),
    ),
    timeoutMs: Type.Optional(
      Type.Number({
        description: "Kill the client after this many milliseconds; default 1800000, maximum 3600000.",
      }),
    ),
  }),
  async execute(args, api, context) {
    const conversationId = String(api.conversationId);
    const action = args.action;
    if (action === "run") {
      if (args.command === undefined) {
        return refusal("The run action needs a command array.");
      }
    } else if (args.command !== undefined) {
      return refusal("The command argument is only for action run.");
    }

    const agentId = await agentResolver()?.(conversationId);
    if (!agentId) {
      return refusal("This thread has no agent, so a privileged command cannot be attributed.");
    }
    const files = await readAgent(agentId);
    if (!files) {
      return refusal("This agent no longer exists.");
    }
    if (files.record.enabled === false) {
      return refusal("This agent is disabled, so it cannot start a privileged command.");
    }
    if (policyOf(files.record).tier === "standard") {
      return refusal(
        "Standard agents cannot run privileged commands. Switch this agent to Custom or Full Access first.",
      );
    }

    const config = await readSudoConfig();
    if (!config) {
      return reply(NOT_INSTALLED);
    }

    const e2e = process.env.DURA_E2E === "1";
    let detected: Maintenance | undefined;
    if (!e2e) {
      detected = await detectMaintenance();
      if (
        detected.manager !== config.manager ||
        JSON.stringify(detected.commands) !== JSON.stringify(config.commands)
      ) {
        return reply(
          "The detected OS or maintenance tools changed since sudo was installed (" +
            (detected.os.prettyName || detected.os.id || "unknown") +
            " / " +
            detected.manager +
            "). Ask the owner to run \"dura sudo install\" again.",
        );
      }
      if (!detected.tools.sudo) {
        return refusal("sudo was not found on PATH, so the installed rule cannot be used.");
      }
      if (config.probe.length > 0) {
        const probe = await runOne(config.probe, {
          timeoutMs: 60_000,
          sudo: detected.tools.sudo,
          ...(detected.tools.systemdRun ? { systemdRun: detected.tools.systemdRun } : {}),
          label: "probe",
        });
        if (probe.timedOut || probe.spawnError !== undefined || probe.exitCode !== 0) {
          const detail = probe.body.trim().slice(0, 400) || probe.spawnError || "no output";
          return reply(
            "The installed sudo rule is not effective: " +
              detail +
              "\nRun \"dura sudo status\" and reinstall with \"dura sudo install\" if needed.",
          );
        }
      }
    }

    let commands: Command[];
    if (action === "run") {
      if (config.mode !== "root") {
        return reply(
          "Arbitrary root commands are not enabled on this host. Ask the owner to reinstall with " +
            "\"dura sudo install --root\" if that is intended.",
        );
      }
      const validated = validateRunCommand(args.command);
      if ("problem" in validated) {
        return refusal(validated.problem);
      }
      commands = [validated.command];
    } else {
      commands = config.commands[action];
      if (commands.length === 0) {
        const why = detected?.unsupported.length ? " " + detected.unsupported.join(" ") : "";
        return reply("The " + action + " action is not available on this host." + why);
      }
    }

    const digest = digestOf(conversationId, agentId, action, commands);
    const key = keyOf(conversationId, digest);
    prune();

    const grant = grants.get(key);
    if (grant) {
      grants.delete(key);
      if (grant.expiresAt > Date.now()) {
        return executeGranted({
          conversationId,
          agentId,
          action,
          commands: grant.commands,
          config,
          detected,
          timeoutMs: clampTimeout(args.timeoutMs),
        });
      }
    }

    const waiting = pending.get(key);
    if (waiting && waiting.expiresAt > Date.now()) {
      return reply(
        "An approval for this exact command is already waiting in chat. Press the button, then retry.",
      );
    }

    const prompt = await askPrompt({
      action,
      config,
      commands,
      ...(args.reason ? { reason: args.reason } : {}),
    });
    const requested = await askOwner({
      conversationId: api.conversationId,
      context,
      agentId,
      text: prompt,
      digest,
      entry: { action, agentId, commands, expiresAt: Date.now() + APPROVAL_TTL_MS },
      mapKey: key,
    });
    if (!requested) {
      return refusal("The approval prompt could not be shown, so nothing was run.");
    }
    return reply(
      "Approval requested in chat. Press the button; your turn is over. If approved, call the sudo tool " +
        "again with exactly the same action and arguments.",
    );
  },
});
