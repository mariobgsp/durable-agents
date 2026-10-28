#!/usr/bin/env node
/**
 * Five-agent memory benchmark.
 *
 * Boots a throwaway daemon with the faux provider and five agents, runs the same complex scripted
 * task in all five at once (shell loop, 200 KiB file, read, memory note), and samples PSS for the
 * daemon and every descendant every 100 ms. The gate is peak PSS < 2048 MB with all five answers.
 *
 * Usage: node scripts/bench/five-agents.mjs [--json] [--keep] [--out FILE]
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { connect } from "node:net";

const ROOT = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const keep = args.includes("--keep");
const outIndex = args.indexOf("--out");
const outFile = outIndex >= 0 ? args[outIndex + 1] : undefined;
const GATE_MB = 2048;
const AGENTS = 5;

const TOOLS = ["read", "write", "edit", "bash", "terminal", "coding", "codemode", "browser", "vault", "question", "create_file", "create_pdf", "publish_file", "remember"];

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function pssOf(pid) {
  return readFile("/proc/" + pid + "/smaps_rollup", "utf8")
    .then((text) => {
      const match = /^Pss:\s+(\d+) kB/m.exec(text);
      return match ? Number(match[1]) / 1024 : 0;
    })
    .catch(() => 0);
}

async function descendantsOf(pid) {
  const found = new Set([pid]);
  let added = true;
  while (added) {
    added = false;
    let entries = [];
    try {
      entries = await readdir("/proc");
    } catch {
      break;
    }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const child = Number(name);
      if (found.has(child)) continue;
      const stat = await readFile("/proc/" + name + "/stat", "utf8").catch(() => "");
      const close = stat.lastIndexOf(")");
      if (close < 0) continue;
      const ppid = Number(stat.slice(close + 2).split(" ")[1]);
      if (found.has(ppid)) {
        found.add(child);
        added = true;
      }
    }
  }
  return [...found];
}

async function totalPss(pid) {
  const pids = await descendantsOf(pid);
  let total = 0;
  for (const child of pids) total += await pssOf(child);
  return { total, pids: pids.length };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index];
}

class Client {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const raw = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!raw) continue;
        let frame;
        try {
          frame = JSON.parse(raw);
        } catch {
          continue;
        }
        if (frame.event) continue;
        const pending = this.pending.get(String(frame.id));
        if (!pending) continue;
        this.pending.delete(String(frame.id));
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(new Error(frame.error?.message ?? "ipc error"));
      }
    });
  }
  static async connect(path, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const socket = connect(path);
        await new Promise((done, fail) => {
          socket.once("connect", done);
          socket.once("error", fail);
        });
        return new Client(socket);
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await sleep(150);
      }
    }
  }
  request(method, params = {}) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  close() {
    this.socket.destroy();
  }
}

async function writeAgent(home, index) {
  const id = "bench-" + (index + 1);
  const dir = resolve(home, "agents", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "agent.json"),
    JSON.stringify(
      {
        id,
        name: "Bench " + (index + 1),
        provider: "e2e",
        modelId: "faux-vision",
        thinkingLevel: "off",
        tools: TOOLS,
        permissions: "full",
        cwd: resolve(home, "work"),
        enabled: true,
        mesh: "full",
        telegramBot: "main",
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(resolve(dir, "AGENT.md"), "# Role\n\nBenchmark agent " + (index + 1) + ".\n");
  await writeFile(resolve(dir, "SOUL.md"), "# Who you are\n\nA benchmark agent.\n");
  return id;
}

async function main() {
  const home = await mkdtemp(resolve(tmpdir(), "dura-bench-"));
  await mkdir(resolve(home, "work"), { recursive: true });
  await writeFile(
    resolve(home, "config.json"),
    JSON.stringify(
      {
        version: 1,
        orchestrator: { agentId: null },
        models: { registered: ["e2e"], default: { provider: "e2e", modelId: "faux-vision" } },
        defaults: { cwd: resolve(home, "work"), permissions: "full", telegramBot: "main", tools: TOOLS },
        limits: { maxConcurrentRuns: 5, queuedRuns: 20, maxAgents: 25, maxBots: 10, codemodeMemoryMb: 128, browserIdleMinutes: 5 },
        telegram: { apiBase: "http://127.0.0.1:1", defaultBot: "main", allowGroups: true, topics: false, editIntervalMs: 1500, broadcastBoot: false, notifyOnAgentDocChange: false, askBotOnAgentCreate: false },
        logging: { level: "warn", maxBytes: 5242880, keep: 1 },
        service: { systemd: false },
        tui: { allowCreate: false },
        setup: { completed: [], verifiedAt: null },
      },
      null,
      2,
    ) + "\n",
  );

  const agentIds = [];
  for (let index = 0; index < AGENTS; index += 1) agentIds.push(await writeAgent(home, index));

  const child = spawn(process.execPath, ["packages/cli/bin/dura.ts", "start", "--foreground", "--no-telegram"], {
    cwd: ROOT,
    env: { ...process.env, DURA_HOME: home, DURA_E2E: "1", DURA_BENCH: "1", DURA_LOG_LEVEL: "warn" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonLog = "";
  child.stdout.on("data", (chunk) => (daemonLog += String(chunk)));
  child.stderr.on("data", (chunk) => (daemonLog += String(chunk)));

  const socketPath = resolve(home, "run", "daemon.sock");
  const client = await Client.connect(socketPath, 30_000);
  const started = Date.now();

  const samples = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const { total } = await totalPss(child.pid);
      samples.push(total);
      await sleep(100);
    }
  })();

  const sessions = [];
  for (const [index, agentId] of agentIds.entries()) {
    sessions.push(await client.request("sessions.create", { title: "Bench " + (index + 1), agent: agentId }));
  }
  await Promise.all(
    sessions.map((session) =>
      client.request("sessions.send", {
        id: session.id,
        text: "Run the benchmark task now. Use the tools, then answer with exactly: Benchmark task complete.",
      }),
    ),
  );

  const deadline = Date.now() + 10 * 60_000;
  let completed = 0;
  while (Date.now() < deadline) {
    completed = 0;
    for (const session of sessions) {
      const entries = await client.request("sessions.transcript", { id: session.id });
      const answer = [...entries].reverse().find((entry) => entry.role === "assistant" && entry.run);
      if (answer) completed += 1;
    }
    if (completed === sessions.length) break;
    await sleep(500);
  }

  const wallMs = Date.now() - started;
  sampling = false;
  await sampler;
  const peak = Math.max(0, ...samples);
  const report = {
    agents: AGENTS,
    completed,
    wallMs,
    samples: samples.length,
    peakPssMb: Math.round(peak),
    p95PssMb: Math.round(percentile(samples, 0.95)),
    p50PssMb: Math.round(percentile(samples, 0.5)),
    gateMb: GATE_MB,
    passed: completed === sessions.length && peak < GATE_MB,
  };

  try {
    await client.request("shutdown");
  } catch {
    /* the daemon may already be gone */
  }
  client.close();
  await sleep(800);
  if (!child.killed) child.kill("SIGTERM");
  await sleep(500);
  if (!child.killed) child.kill("SIGKILL");

  if (!keep) await rm(home, { recursive: true, force: true });
  if (outFile) await writeFile(outFile, JSON.stringify(report, null, 2) + "\n");

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("five-agent benchmark");
    console.log("  completed   " + completed + "/" + sessions.length);
    console.log("  wall        " + (wallMs / 1000).toFixed(1) + "s");
    console.log("  peak PSS    " + report.peakPssMb + " MB (gate " + GATE_MB + " MB)");
    console.log("  p95 / p50   " + report.p95PssMb + " / " + report.p50PssMb + " MB");
    console.log("  " + (report.passed ? "PASS" : "FAIL"));
    if (!report.passed) console.log("  log tail:\n" + daemonLog.split("\n").slice(-20).join("\n"));
  }
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
