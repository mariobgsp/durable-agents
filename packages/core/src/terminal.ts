import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { agentTmpDir } from "./agents.ts";
import { agentResolver } from "./remember.ts";

/**
 * The `terminal` tool: one real shell in a project directory, for build, test and git inspection.
 *
 * It is deliberately stateless per call — a shell, its output, then nothing. A persistent shell or a PTY would
 * hold a process, a buffer and a child tree for the life of the thread, and an agent's idle time is most of the
 * day; spawning per call keeps idle RAM flat. The cost is that `cd` and exported variables do not survive
 * between calls, which is why the working directory is a parameter and the result always echoes it.
 *
 * The environment is scrubbed, not inherited wholesale: a shell that prints its environment would otherwise
 * hand the server's own token and every provider key to the model. Only the variables a build actually needs
 * survive, and pagers are disabled so `git log` cannot wait for a key press that will never come.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
/** Longer than this is a hung command, not a slow build; the owner can run it themselves. */
const MAX_TIMEOUT_MS = 600_000;
/** What the model reads. A model that needs more can rerun the command with a narrower scope. */
const TEXT_LIMIT = 24_000;
/** Half of the 4 MB in-memory ceiling, kept for the head and for the tail respectively. */
const HALF_BUFFER = 2 * 1024 * 1024;

const KEEP_ENV = new Set(["HOME", "PATH", "TERM", "LANG", "SHELL", "TMPDIR"]);
/** Server credentials and provider keys: never inherited by a shell the model drives. */
const SECRET_ENV = /TOKEN|SECRET|PASSWORD|API_KEY|_KEY$|^PI_/i;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The shell's environment: a scrubbed copy of ours, with the build and pager settings a caller expects. */
function shellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (KEEP_ENV.has(key)) {
      env[key] = value;
      continue;
    }
    if (SECRET_ENV.test(key)) continue;
    env[key] = value;
  }
  env.CI = "1";
  env.TERM = "dumb";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  return env;
}

function clampTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.round(requested), MAX_TIMEOUT_MS);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where to run: the caller's directory when it names one, otherwise the owning agent's scratch dir.
 *
 * The scratch dir is created here rather than assumed, because it is the agent's own place to put throwaway
 * scripts and a missing one would otherwise fail the command with a spawn error that says nothing useful.
 */
async function resolveCwd(
  requested: string | undefined,
  conversationId: string,
): Promise<{ dir: string } | { problem: string }> {
  if (requested !== undefined) {
    const dir = isAbsolute(requested) ? requested : resolve(process.cwd(), requested);
    return (await isDirectory(dir)) ? { dir } : { problem: `The working directory ${dir} does not exist.` };
  }
  const agentId = await agentResolver()?.(conversationId);
  if (agentId) {
    const dir = agentTmpDir(agentId);
    try {
      await mkdir(dir, { recursive: true });
      return { dir };
    } catch {
      // A scratch dir that cannot be made is not a reason to refuse the command.
    }
  }
  return { dir: process.cwd() };
}

/** Kill the child's whole process group, so a build's own children die with it, not just the shell. */
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

type ShellOutcome = {
  /** Combined stdout and stderr, with a marker where the middle was discarded. */
  body: string;
  capturedBytes: number;
  droppedBytes: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError?: string;
};

/**
 * One shell, one result.
 *
 * Output is bounded while it is still in memory: the head and the tail of the stream are kept and the middle
 * is thrown away, so a command that prints a gigabyte cannot grow the server's heap. The caller only ever
 * reads the first 24k characters, but the tail still matters for a failing test run, which is why the middle
 * is the part that goes.
 */
function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellOutcome> {
  return new Promise((done) => {
    const head: string[] = [];
    let headBytes = 0;
    const tail: string[] = [];
    let tailBytes = 0;
    let capturedBytes = 0;
    let droppedBytes = 0;
    let timedOut = false;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;

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
        capturedBytes,
        droppedBytes,
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

    try {
      child = spawn("/bin/bash", ["-lc", command], {
        cwd,
        env: shellEnv(),
        // A new process group makes the timeout kill effective: `bash -lc` starts children of its own, and
        // killing only the shell would leave a build running behind the user's back.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, null, messageOf(error));
      return;
    }

    const started = child;
    timer = setTimeout(() => {
      timedOut = true;
      killGroup(started);
      // SIGKILL cannot be ignored, but a process stuck in the kernel can outlive it; do not hang the tool.
      setTimeout(() => finish(null, null), 5000).unref();
    }, timeoutMs);
    timer.unref();

    started.stdout?.setEncoding("utf8");
    started.stderr?.setEncoding("utf8");
    started.stdout?.on("data", absorb);
    started.stderr?.on("data", absorb);
    started.on("error", (error) => finish(null, null, messageOf(error)));
    started.on("close", (code, signal) => {
      // The shell has exited; anything still in its group was backgrounded by the command and is ours to reap.
      killGroup(started);
      finish(code, signal);
    });
  });
}

/** The tool result: the command, where it ran, what it printed, and how it ended — in that order. */
function formatOutcome(
  command: string,
  cwd: string,
  outcome: ShellOutcome,
  timeoutMs: number,
): { text: string; isError: boolean } {
  const footer = outcome.timedOut
    ? `timed out after ${timeoutMs}ms; the process group was killed`
    : outcome.spawnError !== undefined
      ? `could not start the shell: ${outcome.spawnError}`
      : outcome.exitCode === null
        ? `[no exit code; killed by ${outcome.signal ?? "a signal"}]`
        : `[exit code ${outcome.exitCode}]`;
  const isError =
    outcome.timedOut || outcome.spawnError !== undefined || outcome.exitCode === null || outcome.exitCode !== 0;

  const header = `$ ${command}\n${cwd}`;
  // The command's own newline is not a blank line: trim it so the footer sits exactly one blank line below.
  let body = outcome.body.replace(/\n+$/, "");
  if (body.length === 0) body = "(no output)";
  // Reserve room for the header, the footer and the note so the whole reply, not just the body, stays capped.
  const budget = Math.max(0, TEXT_LIMIT - header.length - footer.length - 400);
  let note = "";
  if (body.length > budget) {
    note = `\n[truncated: kept ${budget} of ${body.length} characters; ${outcome.capturedBytes} bytes captured]`;
    body = body.slice(0, budget);
  }
  const text = `${header}\n\n${body}${note}\n\n${footer}`;
  return { text: text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text, isError };
}

function refusal(message: string): { output: { type: "text"; text: string }[]; isError: true } {
  return { output: [{ type: "text", text: message }], isError: true };
}

export const terminalTool = defineTool({
  name: "terminal",
  description:
    "Run one shell command in a project directory and return its combined output and exit code. Use it for " +
    "builds, tests, git inspection and scripts. Each call is a fresh shell: state such as cd and exported " +
    "variables does not carry over, so pass cwd explicitly. The environment is scrubbed of credentials. A " +
    "non-zero exit is an error result, not a silent success.",
  parameters: Type.Object({
    command: Type.String({ description: "The command line, run as /bin/bash -lc." }),
    cwd: Type.Optional(
      Type.String({
        description: "Absolute project directory, or a path relative to the server. Defaults to your scratch dir.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Number({
        description: "Kill the process group after this many milliseconds. Default 120000, maximum 600000.",
      }),
    ),
  }),
  async execute(args, api) {
    try {
      const timeoutMs = clampTimeout(args.timeoutMs);
      const target = await resolveCwd(args.cwd, String(api.conversationId));
      if ("problem" in target) return refusal(target.problem);
      const outcome = await runShell(args.command, target.dir, timeoutMs);
      const { text, isError } = formatOutcome(args.command, target.dir, outcome, timeoutMs);
      return isError
        ? { output: [{ type: "text" as const, text }], isError: true }
        : { output: [{ type: "text" as const, text }] };
    } catch (error) {
      return refusal("The command could not be run: " + messageOf(error).slice(0, 300));
    }
  },
});
