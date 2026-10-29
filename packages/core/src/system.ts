import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { listAgents } from "./agents.ts";
import { rebindAgent } from "./sessions.ts";
import { repoRoot, restartSentinelPath, systemPath } from "./paths.ts";

/**
 * The app's own process facts, and the two operations it can perform on itself.
 *
 * One owner: this module. `index.ts` supplies two process-shaped hooks and three one-line routes; the UI
 * reads a snapshot and polls it. Nothing else in the app knows what npm is, how a supervisor is detected,
 * or that a restart spans two processes.
 */

export type Supervisor = "systemd" | "dev" | "none";
export type UpdateMode = "packages" | "reload";
export type RestartCapability = "supervised" | "stops";

/** What this process loaded at boot, read from `node_modules`. The disk may have moved on. */
export type ToolVersions = {
  piDurable: string;
  piCodemode: string;
  piAi: string;
  chord: string;
  node: string;
};

export type ProcessFacts = {
  pid: number;
  startedAt: number;
  sandboxed: boolean;
  supervisor: Supervisor;
  /** What is possible here, derived at boot. The panel cannot offer the impossible. */
  capability: { update: UpdateMode; restart: RestartCapability };
  versions: ToolVersions;
};

export type Step = "checking" | "installing" | "building" | "reloading" | "stopping";

export type UpdateOutcome = {
  kind: "update";
  mode: UpdateMode;
  before: ToolVersions;
  after: ToolVersions;
  changed: boolean;
};

/** `downtimeMs` is written by the *next* process, so "asked to restart" and "came back" stay two facts. */
export type RestartOutcome = { kind: "restart"; supervisor: Supervisor; downtimeMs: number | null };

/** One name per panel state, so a screen cannot invent a seventh rendering. */
export type OperationState =
  | { name: "running"; step: Step }
  | { name: "done"; outcome: UpdateOutcome | RestartOutcome }
  | { name: "failed"; reason: string; exitCode: number | null }
  | { name: "restarting"; supervisor: Supervisor }
  | { name: "stopped" }
  | { name: "interrupted"; reason: string };

export type LogLine = { seq: number; at: number; kind: "state" | "log"; text: string };

export type Operation = {
  id: string;
  kind: "update" | "restart";
  state: OperationState;
  startedAt: number;
  endedAt: number | null;
  log: LogLine[];
  truncated: boolean;
};

export type SystemSnapshot = {
  process: ProcessFacts;
  /** The one operation still allowed to transition, or null. At most one. */
  current: Operation | null;
  /** The most recent terminal operation, including one left by the process before this one. */
  last: Operation | null;
};

export type SystemHooks = {
  /** Re-install the core extensions from modules already in memory; return their names. */
  reloadTools: () => string[];
  /** Stop the daemon, then exit. A supervisor, or nothing, does the rest. */
  stop: () => Promise<void>;
};

export class OperationBusyError extends Error {
  readonly operation: Operation;

  constructor(operation: Operation) {
    super("another system operation is running");
    this.name = "OperationBusyError";
    this.operation = operation;
  }
}

const LOG_LINES = 60;
const LOG_LINE_CHARS = 500;
const UPDATE_TIMEOUT_MS = 15 * 60_000;
const execFileAsync = promisify(execFile);
const PI_PACKAGES = [
  "@earendil-works/chord",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-durable",
] as const;

type ChildResult = { code: number | null; signal: string | null; timedOut: boolean };

let hooks: SystemHooks | undefined;
let facts: ProcessFacts | undefined;
let current: Operation | null = null;
let last: Operation | null = null;
let runningChild: ChildProcess | undefined;
let operationCount = 0;
let logSeq = 0;

/** `PI_SUPERVISOR` is the explicit override (tests, `dev.mjs`); systemd sets the other two. */
function supervisorOf(): Supervisor {
  const explicit = process.env.PI_SUPERVISOR;
  if (explicit === "dev" || explicit === "systemd" || explicit === "none") return explicit;
  if (process.env.INVOCATION_ID || process.env.JOURNAL_STREAM) return "systemd";
  return "none";
}

async function packageVersion(name: string): Promise<string> {
  try {
    const raw = await readFile(resolve(repoRoot, "node_modules", name, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

async function readVersions(): Promise<ToolVersions> {
  const [piDurable, piCodemode, piAi, chord] = await Promise.all([
    packageVersion("@earendil-works/pi-durable"),
    packageVersion("@earendil-works/pi-codemode"),
    packageVersion("@earendil-works/pi-ai"),
    packageVersion("@earendil-works/chord"),
  ]);
  return { piDurable, piCodemode, piAi, chord, node: process.version };
}

function addLine(operation: Operation, kind: "state" | "log", text: string): void {
  operation.log.push({
    seq: ++logSeq,
    at: Date.now(),
    kind,
    text: text.length > LOG_LINE_CHARS ? text.slice(0, LOG_LINE_CHARS) + "…" : text,
  });
  if (operation.log.length > LOG_LINES) {
    operation.log.splice(0, operation.log.length - LOG_LINES);
    operation.truncated = true;
  }
}

function describe(state: OperationState): string {
  switch (state.name) {
    case "running":
      return "Running: " + state.step;
    case "done":
      return state.outcome.kind === "update"
        ? "Done: " + (state.outcome.changed ? "versions changed" : "already up to date")
        : "Done: restart acknowledged";
    case "failed":
      return "Failed: " + state.reason;
    case "restarting":
      return "Restarting under " + state.supervisor;
    case "stopped":
      return "Stopped; nothing supervises this process";
    case "interrupted":
      return "Interrupted: " + state.reason;
  }
}

function move(operation: Operation, state: OperationState): void {
  operation.state = state;
  addLine(operation, "state", describe(state));
}

function settle(operation: Operation, state: OperationState): void {
  move(operation, state);
  operation.endedAt = Date.now();
  current = null;
  last = operation;
}

function finish(operation: Operation, outcome: UpdateOutcome | RestartOutcome): void {
  settle(operation, { name: "done", outcome });
}

function fail(operation: Operation, reason: string, exitCode: number | null): void {
  settle(operation, { name: "failed", reason, exitCode });
  void persist();
}

async function persist(): Promise<void> {
  if (!last) return;
  try {
    await mkdir(dirname(systemPath), { recursive: true });
    const temporary = systemPath + ".tmp";
    await writeFile(temporary, JSON.stringify({ last }, null, 2), { mode: 0o600 });
    await rename(temporary, systemPath);
  } catch (error) {
    console.error("could not persist the system record:", String(error));
  }
}

/** A narrow reader: a corrupt or older record is no record, not an interrupted operation. */
function parseOperation(value: unknown): Operation | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string") return null;
  if (candidate.kind !== "update" && candidate.kind !== "restart") return null;
  if (typeof candidate.startedAt !== "number") return null;
  if (candidate.endedAt !== null && typeof candidate.endedAt !== "number") return null;
  const state = candidate.state as Record<string, unknown> | undefined;
  if (!state || typeof state.name !== "string") return null;
  const known = ["running", "done", "failed", "restarting", "stopped", "interrupted"];
  if (!known.includes(state.name)) return null;
  if (!Array.isArray(candidate.log)) return null;
  const log: LogLine[] = [];
  for (const entry of candidate.log) {
    if (typeof entry !== "object" || entry === null) return null;
    const line = entry as Record<string, unknown>;
    if (typeof line.seq !== "number" || typeof line.at !== "number" || typeof line.text !== "string") return null;
    if (line.kind !== "state" && line.kind !== "log") return null;
    log.push({ seq: line.seq, at: line.at, kind: line.kind, text: line.text });
    if (line.seq > logSeq) logSeq = line.seq;
  }
  return {
    id: candidate.id,
    kind: candidate.kind,
    state: candidate.state as OperationState,
    startedAt: candidate.startedAt,
    endedAt: (candidate.endedAt as number | null) ?? null,
    log,
    truncated: candidate.truncated === true,
  };
}

async function readPersisted(): Promise<Operation | null> {
  try {
    const raw = await readFile(systemPath, "utf8");
    const parsed = JSON.parse(raw) as { last?: unknown };
    return parseOperation(parsed.last);
  } catch {
    return null;
  }
}

/**
 * Read the process facts once, and reconcile whatever the previous process left behind.
 *
 * Only a terminal record is ever written, so a `running` record means the writer died mid-operation; a
 * `restarting` record means this process is the proof it came back.
 */
export async function openSystem(systemHooks: SystemHooks): Promise<void> {
  hooks = systemHooks;
  const supervisor = supervisorOf();
  const sandboxed = process.env.PI_SANDBOXED === "1";
  facts = {
    pid: process.pid,
    startedAt: Date.now(),
    sandboxed,
    supervisor,
    capability: {
      update: sandboxed ? "reload" : "packages",
      restart: supervisor === "none" ? "stops" : "supervised",
    },
    versions: await readVersions(),
  };

  const previous = await readPersisted();
  if (previous?.state.name === "running") {
    last = {
      ...previous,
      state: {
        name: "interrupted",
        reason: "the process restarted before this operation finished",
      },
      endedAt: Date.now(),
    };
    addLine(last, "state", describe(last.state));
    await persist();
    return;
  }
  if (previous?.kind === "restart" && previous.state.name === "restarting") {
    const endedAt = previous.endedAt ?? previous.startedAt;
    last = {
      ...previous,
      state: {
        name: "done",
        outcome: {
          kind: "restart",
          supervisor: previous.state.supervisor,
          downtimeMs: Math.max(0, Date.now() - endedAt),
        },
      },
      endedAt: Date.now(),
    };
    addLine(last, "state", describe(last.state));
    await persist();
    return;
  }
  last = previous;
}

export function systemSnapshot(): SystemSnapshot {
  if (!facts) throw new Error("system not open: call openSystem() first");
  return { process: facts, current, last };
}

function npmCommand(): { command: string; args: string[] } | null {
  const execpath = process.env.npm_execpath;
  if (execpath && /\.(c?js|mjs)$/.test(execpath)) {
    return { command: process.execPath, args: [execpath] };
  }
  return { command: "npm", args: [] };
}

function runChild(operation: Operation, command: string, args: string[]): Promise<ChildResult> {
  return new Promise((done) => {
    // Deliberately minimal: npm has no business holding the app token, and the unit's 768 MB heap cap is
    // not Vite's build budget.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CI: "1",
    };
    if (process.env.LANG) env.LANG = process.env.LANG;
    if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;

    addLine(operation, "log", "$ " + [command, ...args].join(" "));
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      addLine(operation, "log", "could not start: " + String(error));
      done({ code: 127, signal: null, timedOut: false });
      return;
    }

    runningChild = child;
    let settled = false;
    let timedOut = false;
    let rest = "";
    const timer = setTimeout(() => {
      timedOut = true;
      addLine(operation, "log", "timed out after " + Math.round(UPDATE_TIMEOUT_MS / 60_000) + " minutes");
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, UPDATE_TIMEOUT_MS);

    const consume = (chunk: string): void => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) addLine(operation, "log", line);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.on("error", (error) => {
      addLine(operation, "log", "process error: " + String(error));
    });
    child.on("close", (code, signal) => {
      if (rest.length > 0) addLine(operation, "log", rest);
      clearTimeout(timer);
      runningChild = undefined;
      if (settled) return;
      settled = true;
      addLine(operation, "log", "exit " + (code ?? "—") + (signal ? " (" + signal + ")" : ""));
      done({ code, signal, timedOut });
    });
  });
}

async function runUpdate(operation: Operation): Promise<void> {
  if (!facts) return;
  const before = facts.versions;

  if (facts.capability.update === "reload") {
    move(operation, { name: "running", step: "reloading" });
    if (!hooks) return;
    const names = hooks.reloadTools();
    addLine(operation, "log", "re-registered " + names.length + " extensions: " + names.join(", "));
    let threads = 0;
    for (const agent of await listAgents()) threads += await rebindAgent(agent.id);
    addLine(operation, "log", "rebound " + threads + " thread" + (threads === 1 ? "" : "s") + " to the files on disk");
    addLine(
      operation,
      "log",
      "No packages were installed: the systemd unit mounts the repository read-only. Versions are unchanged.",
    );
    finish(operation, { kind: "update", mode: "reload", before, after: before, changed: false });
    void persist();
    return;
  }

  const npm = npmCommand();
  if (!npm) {
    fail(operation, "npm could not be located in this process", 127);
    return;
  }

  move(operation, { name: "running", step: "installing" });
  const install = await runChild(operation, npm.command, [...npm.args, "update", ...PI_PACKAGES, "--no-audit", "--no-fund"]);
  if (install.timedOut || install.code !== 0) {
    fail(operation, install.timedOut ? "the package update timed out" : "the package update failed", install.code);
    return;
  }

  move(operation, { name: "running", step: "building" });
  const build = await runChild(operation, npm.command, [...npm.args, "run", "build"]);
  if (build.timedOut || build.code !== 0) {
    fail(operation, build.timedOut ? "the UI build timed out" : "packages updated, but the UI build failed", build.code);
    return;
  }

  const after = await readVersions();
  finish(operation, {
    kind: "update",
    mode: "packages",
    before,
    after,
    changed: JSON.stringify(before) !== JSON.stringify(after),
  });
  void persist();
}

/**
 * Start an operation, or join the one already running.
 *
 * A restart is terminal for this process the moment it is recorded: there is no work left to watch, and the
 * next process is what proves it came back.
 */
export function startOperation(kind: "update" | "restart"): Operation {
  if (!facts) throw new Error("system not open: call openSystem() first");
  if (current) {
    if (current.kind === kind && current.state.name === "running") return current;
    throw new OperationBusyError(current);
  }

  const operation: Operation = {
    id: process.pid + "-" + ++operationCount,
    kind,
    state: kind === "restart" ? { name: "running", step: "stopping" } : { name: "running", step: "checking" },
    startedAt: Date.now(),
    endedAt: null,
    log: [],
    truncated: false,
  };
  addLine(operation, "state", kind === "restart" ? "Restart requested" : "Update requested");
  current = operation;

  if (kind === "restart") {
    const supervisor = facts.supervisor;
    settle(operation, supervisor === "none" ? { name: "stopped" } : { name: "restarting", supervisor });
    void scheduleRestart(1.5).catch((error) => console.error("could not schedule the restart:", String(error)));
    return operation;
  }

  void runUpdate(operation).catch((error: unknown) => {
    fail(operation, error instanceof Error ? error.message : String(error), null);
  });
  return operation;
}

/**
 * Persist the terminal restart record, tell the dev supervisor, then leave.
 *
 * Called from the route after the response has been flushed (`reply.raw.once("finish")`), so the client
 * receives the operation instead of a dropped connection.
 */
/**
 * Restart the service without the daemon having to survive its own replacement.
 *
 * Under systemd a transient timer fires outside this unit's cgroup; if systemd-run is unavailable the
 * daemon stops cleanly and Restart=always brings it back. This is what makes edited source files take
 * effect: the next process loads the same working tree.
 */
export async function scheduleRestart(delaySeconds = 2): Promise<{ scheduled: boolean; detail: string }> {
  if (process.env.DURA_E2E === "1") return { scheduled: false, detail: "e2e dry-run; restart not performed" };
  if (!facts) throw new Error("system not open: call openSystem() first");
  if (facts.supervisor === "systemd") {
    try {
      await execFileAsync(
        "systemd-run",
        [
          "--user",
          "--collect",
          "--on-active=" + Math.max(1, Math.ceil(delaySeconds)),
          "--unit=dura-restart-" + Date.now(),
          "systemctl",
          "--user",
          "restart",
          "dura.service",
        ],
        { timeout: 5_000 },
      );
      return { scheduled: true, detail: "systemd timer armed in " + Math.max(1, Math.ceil(delaySeconds)) + "s" };
    } catch {
      // Fall through to a clean stop: Restart=always starts the new process.
    }
  }
  setTimeout(() => {
    void hooks?.stop();
  }, Math.max(1, delaySeconds) * 1_000).unref?.();
  return {
    scheduled: false,
    detail: facts.supervisor === "none" ? "stopping; no supervisor, start it manually" : "stopping; systemd will restart it",
  };
}

export async function performRestart(): Promise<void> {
  await persist();
  if (facts?.supervisor === "dev") {
    try {
      await mkdir(dirname(restartSentinelPath), { recursive: true });
      await writeFile(restartSentinelPath, String(process.pid) + "\n", { mode: 0o600 });
    } catch (error) {
      console.error("could not write the restart sentinel:", String(error));
    }
  }
  if (hooks) await hooks.stop();
}

/** On SIGTERM: never leave a child writing `node_modules` while the next process starts another. */
export function disposeSystem(): void {
  if (runningChild) {
    if (current) addLine(current, "log", "stopping the child");
    runningChild.kill("SIGTERM");
    runningChild = undefined;
  }
  if (current && current.state.name === "running") {
    settle(current, { name: "interrupted", reason: "the server stopped while this operation was running" });
    void persist();
  }
}
