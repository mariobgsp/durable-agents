import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

/**
 * The `coding` tool: hand one coding task to a local CLI that is already authenticated, or keep it in this app.
 *
 * The choice is the owner's, so the tool exists mostly to record it: `durable` spawns nothing and tells the model
 * to use its own file and shell tools. The other two spawn a CLI that has its own login, its own model budget and
 * its own idea of a project, which is why no conversation context is handed over — the prompt has to stand alone.
 *
 * The server's environment is scrubbed before either CLI starts. Both are trusted programs, but they are also
 * third-party programs that print what they are told to print, and the server's token and provider keys have no
 * business in a child that may echo them back into a tool result.
 */

export type CliAvailability = { available: boolean; version?: string; reason?: string };
export type CodingAvailability = { pi: CliAvailability; opencode: CliAvailability };

type CliName = "pi" | "opencode";

const DEFAULT_TIMEOUT_MS = 600_000;
/** A coding task can legitimately take half an hour; this is the point where it is a hang, not work. */
const MAX_TIMEOUT_MS = 1_800_000;
/** What the model reads. The CLI's own transcript is longer than a tool result has any use for. */
const TEXT_LIMIT = 24_000;
/** Half of the 4 MB in-memory ceiling: the head and the tail survive, the middle does not. */
const HALF_BUFFER = 2 * 1024 * 1024;
/** A version banner either arrives at once or not at all; waiting longer would stall the settings page. */
const VERSION_TIMEOUT_MS = 3_000;

/** The owner's answer when they want this thread to do the work itself. */
const KEEP_IN_THREAD =
  "Durable agents selected: do the work in this thread with your own read/write/edit/bash/terminal tools.";
const NOT_AUTHENTICATED = "The CLI is not authenticated; run `pi auth` / `opencode auth login` once in a terminal.";

/** Server credentials and provider keys: inherited by neither CLI. */
const SECRET_ENV = /TOKEN|SECRET|PASSWORD|API_KEY|^PI_/i;
const AUTH_FAILURE = /not logged in|no credentials|auth/i;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.round(requested), MAX_TIMEOUT_MS);
}

/** The child's environment: ours minus anything that looks like a credential, plus what the CLI needs to run. */
function cliEnv(tool: CliName): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SECRET_ENV.test(key)) continue;
    env[key] = value;
  }
  // pi treats an unset PI_OFFLINE as ambiguous; the app is online, so say so instead of inheriting a guess.
  if (tool === "pi") env.PI_OFFLINE = "0";
  return env;
}

/**
 * Resolve a binary the way `which` would, but without a shell.
 *
 * Spawning `bash -lc "which pi"` to find a binary the tool is about to spawn anyway would put a login profile
 * between the request and the answer, and that profile is exactly where a user's PATH differs from ours. Walking
 * PATH is the same rule the shell uses, minus a process.
 */
async function resolveBinary(name: string): Promise<string | undefined> {
  const path = process.env.PATH ?? "";
  for (const directory of path.split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory; look in the next one.
    }
  }
  return undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Display form of an argument: quoted only when it would otherwise read as more than one word. */
function quoted(argument: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(argument) ? argument : JSON.stringify(argument);
}

/** Kill the child's whole process group: a CLI starts its own children, and they must not outlive the timeout. */
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

type CliOutcome = {
  /** Combined stdout and stderr, with a marker where the middle was discarded. */
  body: string;
  /** The last part of stderr alone: authentication failures are diagnosed from it, not from stdout. */
  stderr: string;
  capturedBytes: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError?: string;
};

/**
 * Run one CLI invocation to completion, or to the timeout.
 *
 * Output is bounded while it is still in memory, because a chatty CLI is still a child process and its pipe has
 * no natural end. Detached puts it in its own process group so the timeout can kill the tree, not just the
 * entry point.
 */
function runCli(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CliOutcome> {
  return new Promise((done) => {
    const head: string[] = [];
    let headBytes = 0;
    const tail: string[] = [];
    let tailBytes = 0;
    let capturedBytes = 0;
    let droppedBytes = 0;
    let stderr = "";
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
      const middle =
        droppedBytes > 0 ? `\n[... ${droppedBytes} bytes of output discarded ...]\n` : "";
      done({
        body: head.join("") + middle + tail.join(""),
        stderr,
        capturedBytes,
        exitCode,
        signal,
        timedOut,
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
      child = spawn(file, [...args], {
        cwd: options.cwd,
        env: options.env,
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
    child.stderr?.on("data", (text: string) => {
      absorb(text);
      // Bounded from the end: an authentication failure is the last thing the CLI says, not the first.
      stderr = (stderr + text).slice(-16_384);
    });
    child.on("error", (error) => finish(null, null, messageOf(error)));
    child.on("close", (code, signal) => {
      // The CLI has exited; anything backgrounded into its group is ours to reap.
      killGroup(child);
      finish(code, signal);
    });
  });
}

function missingBinary(tool: CliName): string {
  return tool === "pi"
    ? "pi is not on PATH, so coding could not start. Install pi and make sure its binary directory is on " +
      "PATH, then retry."
    : "opencode is not on PATH, so coding could not start. Install it from https://opencode.ai (for example " +
        "`npm install -g opencode-ai`), then retry.";
}

/** The CLI-specific argument list. The prompt is a complete instruction: neither CLI sees this conversation. */
function commandArgs(tool: CliName, prompt: string, continueSession: boolean): string[] {
  if (tool === "pi") {
    return ["-p", prompt, "--mode", "text", ...(continueSession ? ["-c"] : [])];
  }
  return ["run", prompt, ...(continueSession ? ["--continue"] : [])];
}

function refusal(message: string): { output: { type: "text"; text: string }[]; isError: true } {
  return { output: [{ type: "text", text: message }], isError: true };
}

function reply(text: string): { output: { type: "text"; text: string }[] } {
  return { output: [{ type: "text", text }] };
}

/**
 * The tool result: the command, where it ran, what it printed, and how it ended.
 *
 * The command is repeated because the model wrote it and the user did not: a handed-over task is one the owner
 * will want to reproduce by hand. The exit code is reported even on success, since a CLI that "finished" with a
 * non-zero code has not done the job.
 */
function formatOutcome(
  display: string,
  cwd: string,
  outcome: CliOutcome,
  timeoutMs: number,
): { text: string; isError: boolean } {
  const failed = outcome.timedOut || outcome.spawnError !== undefined || outcome.exitCode !== 0;
  const footer = outcome.timedOut
    ? `timed out after ${timeoutMs}ms; the process group was killed`
    : outcome.spawnError !== undefined
      ? `could not start: ${outcome.spawnError}`
      : outcome.exitCode === null
        ? `[no exit code; killed by ${outcome.signal ?? "a signal"}]`
        : `[exit code ${outcome.exitCode}]`;
  // Only a real failure is worth a hint; an "auth" that merely appears in a passing run is noise.
  const hint = failed && AUTH_FAILURE.test(outcome.stderr) ? `\n${NOT_AUTHENTICATED}` : "";

  const header = `$ ${display}\n${cwd}`;
  // The CLI's own newline is not a blank line: trim it so the footer sits exactly one blank line below.
  let body = outcome.body.replace(/\n+$/, "");
  if (body.length === 0) body = "(no output)";
  const reserve = header.length + footer.length + hint.length + 400;
  const budget = Math.max(0, TEXT_LIMIT - reserve);
  let note = "";
  if (body.length > budget) {
    note = `\n[truncated: kept ${budget} of ${body.length} characters; ${outcome.capturedBytes} bytes captured]`;
    body = body.slice(0, budget);
  }
  const text = `${header}\n\n${body}${note}\n\n${footer}${hint}`;
  const capped = text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text;
  return { text: capped, isError: failed || outcome.exitCode === null };
}

/** Probe one binary: find it, ask for its version, and turn either failure into a value. */
async function probeCli(tool: CliName): Promise<CliAvailability> {
  const binary = await resolveBinary(tool);
  if (binary === undefined) return { available: false, reason: "not installed" };
  const outcome = await runCli(binary, ["--version"], {
    cwd: process.cwd(),
    env: cliEnv(tool),
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (outcome.spawnError !== undefined || outcome.timedOut) {
    return { available: true, reason: "version probe failed" };
  }
  const first = (outcome.body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "").trim();
  return first.length > 0
    ? { available: true, version: first.slice(0, 120) }
    : { available: true, reason: "version probe failed" };
}

async function probeAll(): Promise<CodingAvailability> {
  const [pi, opencode] = await Promise.all([probeCli("pi"), probeCli("opencode")]);
  return { pi, opencode };
}

const UNKNOWN: CodingAvailability = {
  pi: { available: false, reason: "the probe failed" },
  opencode: { available: false, reason: "the probe failed" },
};

let cached: CodingAvailability | undefined;
let probing: Promise<CodingAvailability> | undefined;

/**
 * What the settings page shows: which CLIs are installed, and their versions.
 *
 * Cached because the UI polls, and a version probe is a process spawn: asking twice a second must not become
 * twice-a-second process churn. The cache is lazy — nothing here runs at import time — and a failed probe is a
 * value, because a settings page that throws is worse than one that says "not installed".
 */
export async function codingAvailability(): Promise<CodingAvailability> {
  if (cached !== undefined) return cached;
  probing ??= probeAll().catch(() => UNKNOWN);
  const value = await probing;
  cached = value;
  return value;
}

/** Forget the probe, so a test can observe the first-call path or a newly installed CLI. */
export function resetCodingAvailabilityCache(): void {
  cached = undefined;
  probing = undefined;
}

export const codingTool = defineTool({
  name: "coding",
  description:
    "Hand this coding task to a local coding CLI, or keep it here. Use \"pi\" or \"opencode\" when the owner has " +
    "those installed and wants that agent to do the work; use \"durable\" to do it yourself with your own " +
    "read/write/edit/bash/terminal tools. The CLI has no conversation context, so the prompt must be a complete, " +
    "self-contained instruction. The CLI runs in cwd and its output and exit code come back as the result.",
  parameters: Type.Object({
    tool: Type.Union([Type.Literal("pi"), Type.Literal("opencode"), Type.Literal("durable")], {
      description: "Who does the work: the pi CLI, the opencode CLI, or this thread (durable).",
    }),
    prompt: Type.String({
      description: "The task, as a complete instruction for an agent that cannot see this conversation.",
    }),
    cwd: Type.Optional(
      Type.String({ description: "Absolute project directory. Defaults to the server's working directory." }),
    ),
    continue: Type.Optional(
      Type.Boolean({
        description: "Continue the CLI's previous session in that directory instead of starting a new one.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Number({
        description: "Kill the CLI's process group after this many milliseconds. Default 600000, maximum 1800000.",
      }),
    ),
  }),
  async execute(args) {
    // The owner's own choice, recorded rather than acted on: no process, no output, no ambiguity.
    if (args.tool === "durable") return reply(KEEP_IN_THREAD);

    const timeoutMs = clampTimeout(args.timeoutMs);
    const requested = args.cwd;
    const cwd =
      requested === undefined
        ? process.cwd()
        : isAbsolute(requested)
          ? requested
          : resolve(process.cwd(), requested);
    if (!(await isDirectory(cwd))) return refusal(`The working directory ${cwd} does not exist.`);

    const binary = await resolveBinary(args.tool);
    if (binary === undefined) return refusal(missingBinary(args.tool));

    const argv = commandArgs(args.tool, args.prompt, args.continue === true);
    const display = [args.tool, ...argv].map(quoted).join(" ");
    const outcome = await runCli(binary, argv, { cwd, env: cliEnv(args.tool), timeoutMs });
    const { text, isError } = formatOutcome(display, cwd, outcome, timeoutMs);
    return isError
      ? { output: [{ type: "text" as const, text }], isError: true }
      : { output: [{ type: "text" as const, text }] };
  },
});
