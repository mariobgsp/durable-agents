import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readConfig, updateConfig, type DuraConfig } from "./config.ts";
import { boot, closeHarness } from "./boot.ts";
import { subscribeAgents, listAgents, readAgent, isThinkingLevel, THINKING_LEVELS } from "./agents.ts";
import { subscribe as subscribeActivity } from "./activity.ts";
import { fleetSnapshot } from "./fleet.ts";
import { subscribeMesh } from "./mesh.ts";
import { subscribeSchedules, startScheduler, stopScheduler } from "./schedules.ts";
import { configureLogger, errorFields, flushLog, log, setLogLevel } from "./logger.ts";
import { RunLimiter } from "./limits.ts";
import { createIpcServer, type IpcConnection, type IpcServer } from "./ipc.ts";
import { context, harnessInstance, reloadTools } from "./harness.ts";
import { providerStatus } from "./models.ts";
import {
  abortSession,
  compactSession,
  contextInfo,
  createSession,
  deleteSession,
  findSession,
  listSessions,
  moveSession,
  rebindAgent,
  removeSessionRecord,
  renameSession,
  restartSession,
  restoreSession,
  sendMessage,
  setSessionGrant,
  setSessionModel,
  transcript,
  allSessionRecords,
} from "./sessions.ts";
import { isRoom } from "./rooms.ts";
import { appendMemory, readMemory } from "./agents.ts";
import { cleanupStorage, purgeConversation, storageReport } from "./storage.ts";
import { usageReport } from "./usage.ts";
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  runScheduleNow,
  updateSchedule,
} from "./schedules.ts";
import { announceLeaving, disposeSystem, openSystem, startOperation, systemSnapshot } from "./system.ts";
import { verifyConnection, type Check } from "./verify.ts";
import { chmod } from "node:fs/promises";
import {
  duraHome,
  lockPath,
  pidPath,
  readyPath,
  runDir,
  socketPath,
} from "./paths.ts";

/**
 * The daemon: one process that owns the harness, SQLite, the scheduler, the run limiter, the local
 * control socket and — supplied by the caller — the one active chat transport. It has no TCP listener.
 *
 * The CLI and the TUI speak to it over the Unix socket. The active transport runs in-process and
 * imports the core services directly, so a chat message never goes through the control socket.
 */

export type DaemonChannels = {
  start(): Promise<void>;
  stop(): Promise<void>;
  status?(): Promise<Record<string, unknown>>;
};

export type DaemonMethod = (
  params: Record<string, unknown>,
  connection: IpcConnection,
) => Promise<unknown>;

export type DaemonOptions = {
  config?: DuraConfig;
  channels?: DaemonChannels;
  methods?: Record<string, DaemonMethod>;
  /** Extra checks for the connection test (bot getMe, owner message, poll). */
  verifyExtra?: () => Promise<Check[]>;
  /** Bot labels the verification should accept on agents. */
  botLabels?: () => Promise<string[]>;
  console?: boolean;
  /** Set false when a test imports startDaemon in-process. Default true. */
  exitOnStop?: boolean;
  /** Called once, after the socket is listening and before readiness. */
  onReady?: () => Promise<void>;
};

export type DaemonHandle = {
  config: DuraConfig;
  limiter: RunLimiter;
  ipc: IpcServer;
  startedAt: number;
  stop(code?: number): Promise<void>;
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(): Promise<() => Promise<void>> {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        await unlink(lockPath).catch(() => undefined);
        await unlink(pidPath).catch(() => undefined);
        await unlink(readyPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raw = await readFile(lockPath, "utf8").catch(() => "");
      const pid = Number(raw.trim());
      if (Number.isSafeInteger(pid) && pid > 0 && isAlive(pid)) {
        throw new Error("dura daemon is already running (pid " + pid + ")");
      }
      await unlink(lockPath).catch(() => undefined);
    }
  }
  throw new Error("could not acquire the daemon lock at " + lockPath);
}

function str(params: Record<string, unknown>, key: string, fallback = ""): string {
  const value = params[key];
  return typeof value === "string" ? value : fallback;
}

function bool(params: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const config = options.config ?? (await readConfig());
  configureLogger({
    level: config.logging.level,
    console: options.console ?? false,
    maxBytes: config.logging.maxBytes,
    keep: config.logging.keep,
    file: true,
  });

  const releaseLock = await acquireLock();
  await writeFile(pidPath, String(process.pid) + "\n", { mode: 0o600 });
  const booted = await boot();
  const limiter = new RunLimiter(config.limits.maxConcurrentRuns, config.limits.queuedRuns);

  await openSystem({
    reloadTools: () => reloadTools(),
    stop: async () => {
      await stop(0, "restart");
    },
  });

  const subscriptions = new Set<IpcConnection>();
  let fleetTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  const broadcastFleet = (): void => {
    if (subscriptions.size === 0) return;
    if (fleetTimer) return;
    fleetTimer = setTimeout(() => {
      fleetTimer = undefined;
      void fleetSnapshot()
        .then((fleet) => {
          for (const connection of subscriptions) connection.send("fleet", fleet);
        })
        .catch((error) => log.warn("fleet.failed", errorFields(error)));
    }, 50);
    fleetTimer.unref?.();
  };

  const stopUnsubscribers = [
    subscribeActivity(broadcastFleet),
    subscribeMesh(broadcastFleet),
    subscribeSchedules(broadcastFleet),
    subscribeAgents(broadcastFleet),
  ];

  const status = async (): Promise<Record<string, unknown>> => {
    const fresh = await readConfig({ fresh: true }).catch(() => config);
    const memory = process.memoryUsage();
    const [records, agents, channels] = await Promise.all([
      allSessionRecords(),
      listAgents(),
      options.channels?.status ? options.channels.status() : Promise.resolve(undefined),
    ]);
    return {
      pid: process.pid,
      home: duraHome,
      startedAt: booted.startedAt,
      uptimeMs: Date.now() - booted.startedAt,
      node: process.version,
      memory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
      },
      runs: limiter.stats(),
      counts: {
        agents: agents.length,
        sessions: records.filter((record) => !record.deletedAt).length,
        groups: records.filter((record) => record.room).length,
      },
      model: fresh.models.default,
      orchestrator: fresh.orchestrator.agentId,
      setup: fresh.setup,
      channels: channels ?? null,
      system: systemSnapshot(),
      ipc: { socket: socketPath, clients: 0 },
      verifiedAt: fresh.setup.verifiedAt,
    };
  };

  const coreMethods: Record<string, DaemonMethod> = {
    status: async () => status(),
    doctor: async () => ({
      status: await status(),
      providers: await providerStatus(),
      storage: await storageReport(),
    }),
    shutdown: async () => {
      setTimeout(() => void stop(0, "dura stop"), 50).unref();
      return { ok: true };
    },
    reload: async () => {
      const { reloadEverything } = await import("./reload.ts");
      const result = await reloadEverything();
      log.info("tools.reloaded", { extensions: result.extensions, rebound: result.rebound });
      return result;
    },
    "fleet.subscribe": async (_params, connection) => {
      subscriptions.add(connection);
      connection.send("fleet", await fleetSnapshot());
      return { subscribed: true };
    },
    "fleet.unsubscribe": async (_params, connection) => {
      subscriptions.delete(connection);
      return { subscribed: false };
    },
    "fleet.snapshot": async () => fleetSnapshot(),

    "sessions.list": async (params) => listSessions(bool(params, "includeDeleted")),
    "sessions.create": async (params) =>
      createSession(str(params, "title") || undefined, str(params, "agent") || undefined),
    "sessions.show": async (params) => findSession(str(params, "id")) ?? null,
    "sessions.transcript": async (params) => transcript(str(params, "id")),
    "sessions.send": async (params) =>
      sendMessage(str(params, "id"), {
        text: str(params, "text"),
        requestId: str(params, "requestId") || undefined,
      }),
    "sessions.abort": async (params) => {
      const id = str(params, "id");
      return { ok: (await isRoom(id)) ? false : await abortSession(id) };
    },
    "sessions.rename": async (params) => renameSession(str(params, "id"), str(params, "title")),
    "sessions.delete": async (params) => deleteSession(str(params, "id")),
    "sessions.restore": async (params) => restoreSession(str(params, "id")),
    "sessions.compact": async (params) => compactSession(str(params, "id")),
    "sessions.restart": async (params) => restartSession(str(params, "id"), str(params, "handoff") || undefined),
    "sessions.move": async (params) => moveSession(str(params, "id"), str(params, "agent")),
    "sessions.model": async (params) =>
      setSessionModel(str(params, "id"), { provider: str(params, "provider"), modelId: str(params, "modelId") }),
    "sessions.grant": async (params) =>
      setSessionGrant(str(params, "id"), params.grant === "full" ? "full" : null),
    "sessions.context": async (params) => contextInfo(str(params, "id")),
    "sessions.purgeDeleted": async (params) => {
      const { purgeDeletedSessions } = await import("./sessions.ts");
      return purgeDeletedSessions(Number(params.olderThanDays ?? 0));
    },
    "retention.run": async () => {
      const { runRetention } = await import("./retention.ts");
      return runRetention();
    },
    "retention.status": async () => {
      const { readConfig } = await import("./config.ts");
      return (await readConfig({ fresh: true })).storage;
    },
    "sessions.prune": async (params) => {
      const { pruneSessions } = await import("./sessions.ts");
      return pruneSessions({
        olderThanDays: typeof params.olderThanDays === "number" ? params.olderThanDays : Number(params.olderThanDays ?? 30),
        purge: params.purge === true,
        dryRun: params.dryRun === true,
        includePurpose: params.includePurpose === true,
      });
    },
    "sessions.purge": async (params) => {
      const id = str(params, "id");
      const { noteThreadBeforeRemoval } = await import("./sessions.ts");
      await noteThreadBeforeRemoval(id);
      const entries = await transcript(id);
      const result = await purgeConversation(id, entries);
      await removeSessionRecord(id);
      return result;
    },

    "mcp.list": async () => {
      const { mcpStatus, mcpToolInfos } = await import("./mcp.ts");
      return { servers: mcpStatus(), tools: mcpToolInfos() };
    },
    "mcp.add": async (params) => {
      const { addMcpServer } = await import("./mcp.ts");
      return addMcpServer({
        name: str(params, "name"),
        command: str(params, "command"),
        args: Array.isArray(params.args) ? params.args.filter((value): value is string => typeof value === "string") : [],
        env: object(params.env) as Record<string, string>,
        ...(str(params, "cwd") ? { cwd: str(params, "cwd") } : {}),
      });
    },
    "mcp.remove": async (params) => {
      const { removeMcpServer } = await import("./mcp.ts");
      return removeMcpServer(str(params, "name"));
    },
    "mcp.reload": async () => {
      const { reloadMcp } = await import("./mcp.ts");
      return reloadMcp();
    },
    "mcp.tools": async () => {
      const { mcpToolInfos } = await import("./mcp.ts");
      return mcpToolInfos();
    },
    "bots.pair": async (params) => {
      const { assignBotToAgent } = await import("./agent-admin.ts");
      return assignBotToAgent(str(params, "bot"), str(params, "agent"), "cli");
    },
    "bots.release": async (params) => {
      const { releaseBot } = await import("./agent-admin.ts");
      return { freed: await releaseBot(str(params, "bot"), "cli") };
    },
    "bots.normalize": async () => {
      const { normalizeBotAssignments } = await import("./agent-admin.ts");
      return { cleared: await normalizeBotAssignments() };
    },
    "rooms.list": async () => {
      const records = await allSessionRecords();
      return records
        .filter((record) => record.room && !record.deletedAt)
        .map((record) => ({
          id: String(record.id),
          title: record.title,
          mode: record.room?.mode,
          members: record.room?.members ?? [],
          speaker: record.channel?.bot ?? null,
        }));
    },
    "rooms.create": async (params) => {
      const { createRoom } = await import("./rooms.ts");
      const members = Array.isArray(params.members) ? params.members.filter((value): value is string => typeof value === "string") : [];
      return createRoom(str(params, "title") || "Group", members);
    },
    "rooms.update": async (params) => {
      const { updateRoom } = await import("./rooms.ts");
      return updateRoom(str(params, "id"), object(params.patch) as never);
    },
    "agents.list": async () => listAgents(),
    "agents.show": async (params) => {
      const files = await readAgent(str(params, "id"));
      if (!files) return null;
      return files;
    },
    "agents.memory": async (params) => readMemory(str(params, "id")),
    "agents.remember": async (params) => appendMemory(str(params, "id"), str(params, "note")),
    "thinking.get": async () => {
      const fresh = await readConfig({ fresh: true });
      const agents = await listAgents();
      return { level: fresh.defaults.thinkingLevel, agents: agents.map((agent) => agent.thinkingLevel) };
    },
    "thinking.set": async (params) => {
      const level = str(params, "level");
      if (!isThinkingLevel(level)) throw new Error("level must be one of " + THINKING_LEVELS.join(", "));
      const { applyThinkingLevel } = await import("./agents.ts");
      const agentId = str(params, "agentId");
      const result = await applyThinkingLevel(level, agentId ? { agentId } : {});
      // Every affected agent is rebound so its open threads run at the new effort at once, not after a restart.
      const { rebindAgent } = await import("./sessions.ts");
      for (const id of result.agents) await rebindAgent(id);
      return result;
    },

    "orchestrator.get": async () => ({ agentId: config.orchestrator.agentId }),
    "orchestrator.set": async (params) => {
      const { setOrchestrator } = await import("./orchestrator.ts");
      const agentId = str(params, "agentId") || null;
      const current = await setOrchestrator(agentId);
      return { agentId: current };
    },

    "usage.report": async (params) => usageReport(str(params, "period") === "fresh"),
    "storage.report": async () => storageReport(),
    "storage.cleanup": async () => cleanupStorage(),

    "schedules.list": async (params) => listSchedules(str(params, "agentId") || undefined),
    "schedules.create": async (params) => createSchedule(object(params.input) as never),
    "schedules.update": async (params) => updateSchedule(str(params, "id"), object(params.patch) as never),
    "schedules.delete": async (params) => deleteSchedule(str(params, "id")),
    "schedules.run": async (params) => runScheduleNow(str(params, "id")),

    "config.get": async () => readConfig({ fresh: true }),
    "config.set": async (params) => updateConfig(object(params.patch) as never),
    "config.level": async (params) => {
      const level = str(params, "level");
      if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
        throw new Error("level must be debug, info, warn or error");
      }
      setLogLevel(level);
      await updateConfig({ logging: { level } });
      return { level };
    },
    "system.update": async () => startOperation("update"),
    "system.restart": async (params) =>
      startOperation("restart", {
        cause: str(params, "cause", "/restart"),
        ...(str(params, "sessionId") ? { sessionId: str(params, "sessionId") } : {}),
        ...(str(params, "agentId") ? { agentId: str(params, "agentId") } : {}),
        ...(typeof params.delaySeconds === "number" ? { delaySeconds: params.delaySeconds } : {}),
      }),
    "system.snapshot": async () => systemSnapshot(),

    "providers.list": async () => providerStatus(),
    "providers.test": async (params) => {
      if (!str(params, "provider")) return providerStatus();
      const { models } = await import("./models.ts");
      const available = await models.getAvailable(str(params, "provider"));
      return available.map((model) => (model as { id?: unknown }).id).filter(Boolean);
    },
    "providers.default": async (params) =>
      updateConfig({
        models: {
          default: { provider: str(params, "provider"), modelId: str(params, "modelId") },
        },
      }),

    "verify.run": async (params) => {
      const bots = options.botLabels ? await options.botLabels() : undefined;
      return verifyConnection({
        bots,
        agentPing: params.agentPing !== false,
        extra: options.verifyExtra,
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      });
    },
  };

  const methods = { ...coreMethods, ...(options.methods ?? {}) };

  const ipc = await createIpcServer(socketPath, async (method, params, connection) => {
    if (!stopped) log.debug("ipc.request", { method, client: connection.id });
    const entry = methods[method];
    if (!entry) throw new Error("unknown method: " + method);
    return entry(params, connection);
  });

  let stopping: Promise<void> | undefined;
  async function stop(code = 0, cause = "shutdown"): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      stopped = true;
      log.info("daemon.stop", { code, cause });
      // The transports are still holding their sockets: this is the last moment the owner can be told why
      // the bot goes quiet. Bounded and failure-tolerant, so a mute chat cannot keep the process alive.
      // `cause` is what the chat reads when nothing planned this exit — "stop" told the owner nothing.
      await announceLeaving({ cause }).catch((error) => log.warn("daemon.announce_failed", errorFields(error)));
      for (const unsubscribe of stopUnsubscribers) unsubscribe();
      if (fleetTimer) clearTimeout(fleetTimer);
      subscriptions.clear();
      await options.channels?.stop().catch((error) => log.warn("channels.stop_failed", errorFields(error)));
      const { stopMcp } = await import("./mcp.ts");
      await stopMcp().catch(() => undefined);
      const { stopRetention } = await import("./retention.ts");
      stopRetention();
      stopScheduler();
      disposeSystem();
      await ipc.close().catch(() => undefined);
      limiter.drain();
      await closeHarness();
      await flushLog();
      await releaseLock();
      if (options.exitOnStop !== false) process.exit(code);
    })();
    return stopping;
  }

  try {
    await options.channels?.start();
    startScheduler();
    const { startRetention } = await import("./retention.ts");
    startRetention();
    await options.onReady?.();
  } catch (error) {
    log.error("daemon.start_failed", errorFields(error));
    await stop(1, "startup failed");
    throw error;
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stop(0, signal);
    });
  }

  const ready = {
    pid: process.pid,
    home: duraHome,
    socket: socketPath,
    orchestrator: config.orchestrator.agentId,
    model: config.models.default,
    agents: booted.agents,
    sessions: booted.sessions,
  };
  const readyFile = readyPath + ".tmp";
  await writeFile(readyFile, JSON.stringify(ready), { mode: 0o600 });
  await rename(readyFile, readyPath);
  await chmod(readyPath, 0o600).catch(() => undefined);
  console.log("DURA_READY " + JSON.stringify(ready));
  log.info("daemon.ready", ready);

  return { config, limiter, ipc, startedAt: booted.startedAt, stop };
}

export { context, harnessInstance };
