/**
 * E2E harness: a throwaway home, a fake Bot API, five fake agents' worth of infrastructure when a
 * scenario asks for it, and a real daemon. Everything is deterministic and offline: DURA_E2E swaps
 * every model provider for the faux provider, and the Telegram base URL points at the fake server.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { connect } from "node:net";
import { startFakeTelegram } from "./fake-telegram.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const TOOLS = ["read", "write", "edit", "bash", "terminal", "coding", "codemode", "browser", "vault", "question", "create_file", "create_pdf", "publish_file"];

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export class Ipc {
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
  static async connect(path, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const socket = connect(path);
        await new Promise((done, fail) => {
          socket.once("connect", done);
          socket.once("error", fail);
        });
        return new Ipc(socket);
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

async function writeAgent(home, agent, defaultBot) {
  const dir = resolve(home, "agents", agent.id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "agent.json"),
    JSON.stringify(
      {
        id: agent.id,
        name: agent.name,
        provider: "e2e",
        modelId: "faux-vision",
        thinkingLevel: "off",
        tools: agent.tools ?? TOOLS,
        permissions: "full",
        cwd: resolve(home, "work"),
        enabled: true,
        mesh: agent.mesh ?? "full",
        ...(agent.telegramBot ?? defaultBot ? { telegramBot: agent.telegramBot ?? defaultBot } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(resolve(dir, "AGENT.md"), agent.agentMd ?? "# Role\n\n" + agent.name + ".\n");
  await writeFile(resolve(dir, "SOUL.md"), agent.soulMd ?? "# Who you are\n\n" + agent.name + ".\n");
}

export async function startHarness(options = {}) {
  const home = await mkdtemp(resolve(tmpdir(), "dura-e2e-"));
  await mkdir(resolve(home, "work"), { recursive: true });

  const fake = options.fake ?? (await startFakeTelegram());
  const bots = options.bots ?? [{ label: "main", username: "mainbot", id: 1001, token: "1001:test-token" }];
  for (const bot of bots) fake.addBot(bot);

  await mkdir(resolve(home, "secrets"), { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(home, "secrets", "telegram.json"),
    JSON.stringify(
      {
        version: 1,
        default: bots[0].label,
        bots: bots.map((bot) => ({ label: bot.label, token: bot.token, botId: String(bot.id), username: bot.username, enabled: true })),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  await mkdir(resolve(home, "telegram"), { recursive: true, mode: 0o700 });
  const owner = options.owner ?? "100";
  await writeFile(
    resolve(home, "telegram", "users.json"),
    JSON.stringify({ owner, users: [{ id: owner, role: "owner", addedAt: Date.now() }], pending: [] }, null, 2) + "\n",
    { mode: 0o600 },
  );

  const agents = options.agents ?? [{ id: "helper", name: "Helper" }];
  // One bot is one agent: the first agent gets the default bot; the rest are unpaired unless explicit.
  for (const [index, agent] of agents.entries()) {
    await writeAgent(home, agent, index === 0 ? bots[0]?.label : undefined);
  }

  await writeFile(
    resolve(home, "config.json"),
    JSON.stringify(
      {
        version: 1,
        orchestrator: { agentId: options.orchestrator ?? null },
        models: { registered: ["e2e"], default: { provider: "e2e", modelId: "faux-vision" } },
        defaults: { cwd: resolve(home, "work"), permissions: "full", telegramBot: bots[0].label, tools: TOOLS },
        limits: { maxConcurrentRuns: 5, queuedRuns: 20, maxAgents: 25, maxBots: 10, codemodeMemoryMb: 128, browserIdleMinutes: 5 },
        telegram: {
          apiBase: fake.base,
          defaultBot: bots[0].label,
          allowGroups: true,
          topics: false,
          editIntervalMs: 300,
          broadcastBoot: false,
          notifyOnAgentDocChange: false,
          askBotOnAgentCreate: false,
        },
        logging: { level: "info", maxBytes: 5 * 1024 * 1024, keep: 1 },
        service: { systemd: false },
        tui: { allowCreate: false },
        setup: { completed: [], verifiedAt: null },
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );

  const scriptPath = resolve(home, "script.json");
  await writeFile(scriptPath, JSON.stringify(options.script ?? [{ text: "Hello from the faux model." }], null, 2) + "\n");

  const child = spawn(process.execPath, ["packages/cli/bin/dura.ts", "start", "--foreground"], {
    cwd: ROOT,
    env: { ...process.env, DURA_HOME: home, DURA_E2E: "1", DURA_E2E_SCRIPT_FILE: scriptPath, DURA_LOG_LEVEL: "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += String(chunk)));
  child.stderr.on("data", (chunk) => (log += String(chunk)));

  const readyPath = resolve(home, "run", "ready.json");
  const deadline = Date.now() + 30_000;
  let ready;
  while (Date.now() < deadline) {
    try {
      ready = JSON.parse(await readFile(readyPath, "utf8"));
      if (ready.pid) break;
    } catch {
      /* not yet */
    }
    if (child.exitCode !== null) throw new Error("daemon exited during startup:\n" + log);
    await sleep(120);
  }
  if (!ready) {
    child.kill("SIGKILL");
    throw new Error("daemon did not become ready:\n" + log);
  }

  const client = await Ipc.connect(resolve(home, "run", "daemon.sock"));

  const send = (label, update) => fake.inject(label, update);
  const messageId = { value: 1 };
  const text = (label, chatId, messageText, extra = {}) => {
    const id = messageId.value++;
    send(label, {
      update_id: id,
      message: {
        message_id: id,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: "private" },
        from: { id: Number(owner), is_bot: false, username: "owner" },
        text: messageText,
        ...extra,
      },
    });
    return id;
  };

  const waitFor = async (predicate, timeoutMs = 25_000, describe = "condition") => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const hit = predicate();
      if (hit) return hit;
      await sleep(100);
    }
    throw new Error("timed out waiting for " + describe + "\n" + log.split("\n").slice(-15).join("\n"));
  };

  return {
    home,
    owner,
    fake,
    agents,
    client,
    log: () => log,
    send,
    text,
    waitFor,
    stop: async () => {
      try {
        await client.request("shutdown");
      } catch {
        /* already gone */
      }
      client.close();
      await sleep(500);
      child.kill("SIGTERM");
      await sleep(300);
      if (child.exitCode === null) child.kill("SIGKILL");
      if (options.keepHome !== true) await rm(home, { recursive: true, force: true });
      if (options.keepFake !== true) await fake.close();
    },
  };
}

export { ROOT };
