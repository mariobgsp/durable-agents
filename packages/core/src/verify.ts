import { readFile, readdir, readlink, stat, writeFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { listAgents } from "./agents.ts";
import { defaultCwd, readConfig, type DuraConfig } from "./config.ts";
import { context, harnessInstance } from "./harness.ts";
import { log } from "./logger.ts";
import { models } from "./models.ts";
import { dbPath, configPath, duraHome, socketPath } from "./paths.ts";
import { createSession, removeSessionRecord, sendMessage, transcript } from "./sessions.ts";
import { purgeConversation } from "./storage.ts";
import { removeArtifacts } from "./artifacts.ts";

/**
 * Connection test: the one function that both the wizard's final step and dura verify call. Every
 * check is an observation, not a guess: a provider answer, a bot identity, a message id, a live
 * agent reply, a socket mode, a SQLite read, and the absence of a TCP listener for this process.
 */

export type Check = {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
  ms?: number;
};

export type VerifyOptions = {
  /** Bot labels known to the caller; core uses them to validate agent home bots. */
  bots?: string[];
  /** One live agent round-trip. On by default; the wizard disables it with --no-agent-ping. */
  agentPing?: boolean;
  /** Extra checks supplied by the transport (Telegram getMe, owner message, poll). */
  extra?: () => Promise<Check[]>;
  timeoutMs?: number;
};

function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  return work().then((value) => ({ value, ms: Date.now() - started }));
}

async function checkHome(): Promise<Check[]> {
  const checks: Check[] = [];
  const started = Date.now();
  try {
    const file = duraHome + "/.verify-" + process.pid;
    await writeFile(file, "ok", { mode: 0o600 });
    await rm(file, { force: true });
    checks.push({ name: "home-writable", ok: true, detail: duraHome, required: true, ms: Date.now() - started });
  } catch (error) {
    checks.push({ name: "home-writable", ok: false, detail: String(error), required: true });
  }
  try {
    const info = await stat(configPath);
    const mode = (info.mode & 0o777).toString(8);
    checks.push({
      name: "config-mode",
      ok: (info.mode & 0o077) === 0,
      detail: mode + " " + configPath,
      required: true,
    });
  } catch (error) {
    checks.push({ name: "config-mode", ok: false, detail: String(error), required: true });
  }
  return checks;
}

async function checkProvider(config: DuraConfig): Promise<Check[]> {
  const checks: Check[] = [];
  const provider = config.models.default.provider;
  const started = Date.now();
  try {
    const available = await models.getAvailable(provider);
    const ids = available.map((model) => (model as { id?: unknown }).id).filter((id): id is string => typeof id === "string");
    checks.push({
      name: "provider-models",
      ok: ids.length > 0,
      detail: provider + ": " + ids.length + " models",
      required: true,
      ms: Date.now() - started,
    });
  } catch (error) {
    checks.push({ name: "provider-models", ok: false, detail: provider + ": " + String(error), required: true });
    return checks;
  }

  const startedCall = Date.now();
  try {
    const model = await models.getModel(provider, config.models.default.modelId);
    if (!model) throw new Error("model not found: " + provider + "/" + config.models.default.modelId);
    const answer = await models.completeSimple(
      model,
      {
        systemPrompt: "Reply with exactly: OK",
        messages: [{ role: "user", content: "Connection test. Reply with OK.", timestamp: Date.now() }],
      },
      { sessionId: "dura-verify" },
    );
    const text = Array.isArray((answer as { content?: unknown })?.content)
      ? ((answer as { content: { text?: unknown }[] }).content).map((block) => (typeof block.text === "string" ? block.text : "")).join("")
      : "";
    checks.push({
      name: "provider-completion",
      ok: text.trim().length > 0,
      detail: provider + "/" + config.models.default.modelId + " answered: " + text.trim().slice(0, 40),
      required: true,
      ms: Date.now() - startedCall,
    });
  } catch (error) {
    checks.push({
      name: "provider-completion",
      ok: false,
      detail: provider + "/" + config.models.default.modelId + ": " + String(error),
      required: true,
      ms: Date.now() - startedCall,
    });
  }
  return checks;
}

async function checkAgents(config: DuraConfig, bots: string[] | undefined): Promise<Check[]> {
  const checks: Check[] = [];
  const agents = await listAgents();
  const knownBots = new Set(bots ?? []);
  if (agents.length === 0) {
    checks.push({ name: "agents", ok: false, detail: "no agents are configured", required: true });
    return checks;
  }
  let ok = true;
  const problems: string[] = [];
  for (const agent of agents) {
    const model = models.getModel(agent.provider, agent.modelId);
    if (!model) {
      ok = false;
      problems.push(agent.id + ": model " + agent.provider + "/" + agent.modelId + " is not registered");
    }
    // Unpaired agents are valid: they are reachable through the orchestrator until a bot is connected.
    if (agent.telegramBot && bots !== undefined && !knownBots.has(agent.telegramBot)) {
      ok = false;
      problems.push(agent.id + ": bot " + agent.telegramBot + " is not configured");
    }
  }
  checks.push({
    name: "agents",
    ok,
    detail: ok
      ? agents.length + " agents, models and bots resolve"
      : problems.join("; "),
    required: true,
  });
  const orchestrator = config.orchestrator.agentId;
  checks.push({
    name: "orchestrator",
    ok: Boolean(orchestrator && agents.some((agent) => agent.id === orchestrator)),
    detail: orchestrator ? "orchestrator: " + orchestrator : "no orchestrator configured",
    required: false,
  });
  return checks;
}

/** LISTEN sockets (state 0A) owned by this process, from /proc. */
export async function tcpListenersFor(pid = process.pid): Promise<string[]> {
  const inodes = new Set<string>();
  try {
    for (const name of await readdir("/proc/" + pid + "/fd")) {
      const target = await readlink("/proc/" + pid + "/fd/" + name).catch(() => "");
      const match = target.match(/^socket:\[(\d+)\]$/);
      if (match?.[1]) inodes.add(match[1]);
    }
  } catch {
    return [];
  }
  const listeners: string[] = [];
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await readFile(table, "utf8").catch(() => "");
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      if (fields[3] !== "0A") continue;
      const inode = fields[9];
      if (!inode || !inodes.has(inode)) continue;
      const [address, portHex] = (fields[1] ?? "").split(":");
      listeners.push((address ?? "?") + ":" + parseInt(portHex ?? "0", 16));
    }
  }
  return listeners;
}

async function checkIpc(): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const info = await stat(socketPath);
    checks.push({
      name: "ipc-socket",
      ok: info.isSocket() && (info.mode & 0o077) === 0,
      detail: socketPath + " mode " + (info.mode & 0o777).toString(8),
      required: true,
    });
  } catch (error) {
    checks.push({ name: "ipc-socket", ok: false, detail: String(error), required: true });
  }
  const listeners = await tcpListenersFor();
  checks.push({
    name: "no-tcp-listener",
    ok: listeners.length === 0,
    detail: listeners.length === 0 ? "none" : listeners.join(", "),
    required: true,
  });
  return checks;
}

async function checkSqlite(): Promise<Check> {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
    } finally {
      db.close();
    }
    const info = await stat(dbPath);
    return { name: "sqlite", ok: true, detail: Math.round(info.size / 1024) + " KiB", required: true };
  } catch (error) {
    return { name: "sqlite", ok: false, detail: String(error), required: true };
  }
}

/** One live round-trip through a real agent: provider + durable conversation + agent files + tools. */
async function checkAgentPing(config: DuraConfig, timeoutMs: number): Promise<Check> {
  const agentId = config.orchestrator.agentId ?? (await listAgents())[0]?.id;
  const started = Date.now();
  if (!agentId) return { name: "agent-ping", ok: false, detail: "no agent to ping", required: false };
  let sessionId: string | undefined;
  try {
    const session = await createSession("Connection test", agentId);
    sessionId = session.id;
    await sendMessage(session.id, { text: "Connection test. Reply with one short sentence." });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entries = await transcript(session.id);
      const answer = entries.find((entry) => entry.role === "assistant" && entry.text.trim().length > 0);
      if (answer) {
        return {
          name: "agent-ping",
          ok: true,
          detail: agentId + " answered in " + (Date.now() - started) + "ms",
          required: false,
          ms: Date.now() - started,
        };
      }
      await new Promise((done) => setTimeout(done, 250));
    }
    return {
      name: "agent-ping",
      ok: false,
      detail: "no answer within " + timeoutMs + "ms",
      required: false,
      ms: Date.now() - started,
    };
  } catch (error) {
    return { name: "agent-ping", ok: false, detail: String(error), required: false, ms: Date.now() - started };
  } finally {
    if (sessionId) {
      // A connection test is not a conversation worth retaining: export nothing, delete the rows now.
      try {
        const entries = await transcript(sessionId);
        await purgeConversation(sessionId, entries);
        await removeArtifacts(sessionId);
        await removeSessionRecord(sessionId);
      } catch {
        // The test already reported its result; cleanup must not fail it.
      }
    }
  }
}

export type VerifyResult = { ok: boolean; checks: Check[]; verifiedAt: number | null };

/** Run every check. Required failures make the test fail; optional checks are reported only. */
export async function verifyConnection(options: VerifyOptions = {}): Promise<VerifyResult> {
  const config = await readConfig({ fresh: true });
  const checks: Check[] = [];
  checks.push(...(await checkHome()));
  checks.push(...(await checkProvider(config)));
  checks.push(...(await checkAgents(config, options.bots)));
  checks.push(...(await checkIpc()));
  checks.push(await checkSqlite());
  if (options.extra) checks.push(...(await options.extra()));
  if (options.agentPing !== false) checks.push(await checkAgentPing(config, options.timeoutMs ?? 90_000));

  const ok = checks.every((check) => !check.required || check.ok);
  const verifiedAt = ok ? Date.now() : null;
  if (verifiedAt) {
    const { updateConfig } = await import("./config.ts");
    await updateConfig({ setup: { verifiedAt, completed: [...new Set([...config.setup.completed, "test"])] } });
  }
  log[ok ? "info" : "error"]("verify.done", {
    ok,
    failed: checks.filter((check) => !check.ok).map((check) => check.name),
  });
  return { ok, checks, verifiedAt };
}
