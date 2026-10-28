import { context, harnessInstance } from "../../core/src/harness.ts";
import { activeIds } from "../../core/src/activity.ts";
import { listAgents, readAgent, readMemory, type AgentRecord } from "../../core/src/agents.ts";
import { readConfig, updateConfig } from "../../core/src/config.ts";
import { models } from "../../core/src/models.ts";
import { reloadEverything } from "../../core/src/reload.ts";
import { startOperation } from "../../core/src/system.ts";
import { syncBotCommands } from "./command-catalog.ts";
import { errorFields, log } from "../../core/src/logger.ts";
import { orchestratorId, setOrchestrator, subscribeOrchestrator } from "../../core/src/orchestrator.ts";
import { assignBotToAgent, releaseBot, setBotResolver, subscribeAdmin } from "../../core/src/agent-admin.ts";
import { subscribeDocChanges } from "../../core/src/doc-store.ts";
import { isRoom, postToRoom, updateRoom } from "../../core/src/rooms.ts";
import {
  abortSession,
  compactSession,
  createSession,
  findSession,
  restartSession,
  sendMessage,
  transcript,
  updateSessionRecord,
} from "../../core/src/sessions.ts";
import { usageReport } from "../../core/src/usage.ts";
import { openEventStream } from "../../core/src/stream.ts";
import type { WireMsg } from "../../core/src/wire.ts";
import { readArtifact } from "../../core/src/artifacts.ts";
import type { Check } from "../../core/src/verify.ts";
import type { AttachmentDraft } from "../../core/src/attachments.ts";
import { BotApi, TelegramError } from "./client.ts";
import { attachmentFromMessage, captionOf, MediaError } from "./media.ts";
import {
  loadRegistry,
  publicRegistry,
  addBot,
  botByLabel,
  defaultBot,
  removeBot,
  setBotEnabled,
  setDefaultBot,
  type BotRegistry,
} from "./registry.ts";
import {
  loadState,
  setHealth,
  stateFor,
  chatKey,
  getChat,
  setChat,
  saveState,
  rememberMessage,
  sessionForMessage,
  type TgState,
} from "./state.ts";
import {
  approvePending,
  denyPending,
  isAllowed,
  loadUsers,
  notePending,
  roleOf,
  saveUsers,
  setOwner,
  type Users,
} from "./users.ts";
import { escapeHtml, markdownToHtml, questionKeyboard, renderAnswer, renderLive, splitMessage, buttons } from "./render.ts";
import type { TgCallbackQuery, TgChat, TgMessage, TgUpdate } from "./types.ts";

/**
 * The Telegram runtime: one long poll per bot, one allowlist, one state file. It is deliberately a
 * thin transport over the core services — every durable decision (session, room, schedule, agent)
 * belongs to core. A Telegram failure can stop a poller; it cannot lose a run.
 */

type BotHandle = { label: string; api: BotApi; loop: Promise<void> | undefined; stopping: boolean; abort: AbortController };

const MENU_ROWS = [
  [{ text: "Agents", data: "cmd:agents" }, { text: "New thread", data: "cmd:new" }],
  [{ text: "Threads", data: "cmd:threads" }, { text: "Plan", data: "cmd:plan" }],
  [{ text: "Model", data: "cmd:model" }, { text: "Usage", data: "cmd:usage" }],
  [{ text: "Reload", data: "cmd:reload" }, { text: "Restart", data: "cmd:restart" }],
  [{ text: "Group", data: "cmd:group" }, { text: "Schedules", data: "cmd:schedules" }],
  [{ text: "Memory", data: "cmd:memory" }, { text: "Bots", data: "cmd:bots" }],
  [{ text: "MCP", data: "cmd:mcp" }, { text: "Prune", data: "cmd:prune" }],
  [{ text: "Status", data: "cmd:status" }, { text: "Help", data: "cmd:help" }],
];

function escapeText(text: string): string {
  return escapeHtml(text);
}

function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.round(seconds / 60) + "m";
  if (seconds < 86_400) return Math.round(seconds / 3600) + "h";
  return Math.round(seconds / 86_400) + "d";
}

export class TelegramRuntime {
  private registry!: BotRegistry;
  private users!: Users;
  private state!: TgState;
  private readonly handles = new Map<string, BotHandle>();
  private stopping = false;
  private readonly seen = new Map<string, number>();
  private stateQueue: Promise<void> = Promise.resolve();
  private unsubscribers: (() => void)[] = [];

  async start(): Promise<void> {
    this.registry = await loadRegistry();
    this.users = await loadUsers();
    this.state = await loadState();
    setBotResolver({
      validate: async (label) => this.registry.bots.some((bot) => bot.label === label),
      list: async () => this.registry.bots.map((bot) => bot.label),
    });

    this.unsubscribers.push(
      subscribeDocChanges((event) => {
        void this.notifyOwner(
          "✍️ " + event.agentId + " " + (event.doc === "agent" ? "AGENT.md" : "SOUL.md") +
            " updated by " + event.caller + " · " + event.sha256.slice(0, 8),
        );
      }),
    );
    this.unsubscribers.push(
      subscribeAdmin((event) => {
        if (event.kind === "doc") return;
        const verb = event.kind === "create" ? "created" : event.kind === "delete" ? "deleted" : "updated";
        void this.notifyOwner("🧩 agent " + event.agentId + " " + verb + " by " + event.caller);
      }),
    );
    this.unsubscribers.push(
      subscribeOrchestrator((event) => {
        if (event.kind === "requested") {
          void this.notifyOwner(
            "🔑 " + event.agentId + " asks to become the orchestrator (current: " + (event.current ?? "none") + ").",
            buttons([[{ text: "Approve", data: "oc:" + event.agentId }, { text: "Deny", data: "ocno:" + event.agentId }]]),
          );
        } else if (event.kind === "claimed") {
          void this.notifyOwner("🔑 " + event.agentId + " is now the orchestrator (no orchestrator was set).");
        }
      }),
    );

    for (const bot of this.registry.bots.filter((entry) => entry.enabled)) {
      await this.startBot(bot.label).catch((error) => log.error("telegram.bot_start_failed", { label: bot.label, ...errorFields(error) }));
    }
    log.info("telegram.started", { bots: [...this.handles.keys()] });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const handle of this.handles.values()) {
      handle.stopping = true;
      handle.abort.abort();
      await Promise.race([handle.loop?.catch(() => undefined), new Promise((done) => setTimeout(done, 3000))]);
    }
    this.handles.clear();
    await this.persist();
  }

  private async startBot(label: string): Promise<void> {
    const bot = botByLabel(this.registry, label);
    if (!bot) throw new Error("unknown bot: " + label);
    if (this.handles.has(label)) return;
    const config = await readConfig();
    const api = new BotApi({
      token: bot.token,
      apiBase: config.telegram.apiBase,
      label,
      report: (level, message, fields) => log[level](message, { bot: label, ...fields }),
    });
    const me = await api.getMe();
    // Clear every scope and language an older integration may have written, then install ours.
    const synced = await syncBotCommands(api).catch((error) => {
      log.warn("telegram.commands_failed", { label, ...errorFields(error) });
      return { cleared: 0, set: 0 };
    });
    log.info("telegram.commands", { label, ...synced });
    const botState = stateFor(this.state, label);
    botState.health = { ok: true, checkedAt: Date.now(), username: me.username };
    await this.persist();
    const handle: BotHandle = { label, api, loop: undefined, stopping: false, abort: new AbortController() };
    this.handles.set(label, handle);
    handle.loop = this.poll(handle);
    log.info("telegram.connected", { label, username: me.username });
  }

  private async poll(handle: BotHandle): Promise<void> {
    while (!this.stopping && !handle.stopping) {
      const botState = stateFor(this.state, handle.label);
      try {
        const updates = await handle.api.getUpdates(botState.offset, 50, handle.abort.signal);
        if (updates.length === 0) continue;
        for (const update of updates) {
          botState.offset = Math.max(botState.offset, update.update_id + 1);
          await this.handleUpdate(handle, update).catch((error) => {
            log.error("telegram.update_failed", { bot: handle.label, update: update.update_id, ...errorFields(error) });
            void this.reportError(handle.label, error);
          });
        }
        await this.persist();
        if (!botState.health.ok) {
          botState.health = { ok: true, checkedAt: Date.now(), username: botState.health.username };
          await this.persist();
          log.info("telegram.reconnected", { label: handle.label });
        }
      } catch (error) {
        if (this.stopping || handle.stopping || handle.abort.signal.aborted) return;
        const fatal = error instanceof TelegramError && (error.status === 401 || error.status === 409);
        botState.health = {
          ok: false,
          checkedAt: Date.now(),
          lastError: error instanceof Error ? error.message : String(error),
          ...(botState.health.username ? { username: botState.health.username } : {}),
        };
        await this.persist();
        log.error("telegram.poll_failed", { bot: handle.label, fatal, ...errorFields(error) });
        if (fatal) return;
        await new Promise((done) => setTimeout(done, 3000));
      }
    }
  }

  private async persist(): Promise<void> {
    this.stateQueue = this.stateQueue.then(() => saveState(this.state)).catch(() => undefined);
    await this.stateQueue;
  }

  /** The registry/health snapshot used by status, the fleet TUI and the wizard. */
  async status(): Promise<Record<string, unknown>> {
    const agents = await listAgents();
    return {
      bots: this.registry.bots.map((bot) => ({
        label: bot.label,
        username: bot.username,
        enabled: bot.enabled,
        default: bot.label === this.registry.default,
        ok: this.state.bots[bot.label]?.health.ok ?? false,
        pollState: this.handles.has(bot.label) ? "running" : "stopped",
        lastError: this.state.bots[bot.label]?.health.lastError,
        agents: agents.filter((agent) => (agent.telegramBot ?? this.registry.default) === bot.label).length,
      })),
      owner: this.users.owner,
      pending: this.users.pending.length,
      default: this.registry.default,
    };
  }

  botLabels(): string[] {
    return this.registry.bots.map((bot) => bot.label);
  }

  async verifyExtra(): Promise<Check[]> {
    const checks: Check[] = [];
    for (const bot of this.registry.bots.filter((entry) => entry.enabled)) {
      const started = Date.now();
      try {
        const config = await readConfig();
        const api = new BotApi({ token: bot.token, apiBase: config.telegram.apiBase, label: bot.label });
        const me = await api.getMe();
        checks.push({
          name: "telegram " + bot.label,
          ok: true,
          detail: "@" + me.username + " · token valid",
          required: true,
          ms: Date.now() - started,
        });
      } catch (error) {
        checks.push({ name: "telegram " + bot.label, ok: false, detail: String(error), required: true });
      }
    }
    if (this.users.owner && this.registry.bots.length > 0) {
      const started = Date.now();
      try {
        const api = this.apiFor(this.registry.default);
        const message = await api.sendMessage(this.users.owner, "dura connected · " + new Date().toISOString());
        checks.push({
          name: "owner-message",
          ok: Boolean(message.message_id),
          detail: "delivered message " + message.message_id + " via " + this.registry.default,
          required: true,
          ms: Date.now() - started,
        });
      } catch (error) {
        checks.push({ name: "owner-message", ok: false, detail: String(error), required: true });
      }
    }
    return checks;
  }

  methods(): Record<string, (params: Record<string, unknown>, connection: never) => Promise<unknown>> {
    return {
      "bots.list": async () => ({ ...publicRegistry(this.registry), status: await this.status() }),
      "bots.add": async (params) => this.ipcAddBot(params),
      "bots.remove": async (params) => this.ipcRemoveBot(String(params.label ?? "")),
      "bots.default": async (params) => {
        this.registry = await setDefaultBot(String(params.label ?? ""));
        return publicRegistry(this.registry);
      },
      "bots.enable": async (params) => {
        const label = String(params.label ?? "");
        this.registry = await setBotEnabled(label, true);
        await this.startBot(label);
        return publicRegistry(this.registry);
      },
      "bots.disable": async (params) => {
        const label = String(params.label ?? "");
        this.registry = await setBotEnabled(label, false);
        const handle = this.handles.get(label);
        if (handle) {
          handle.stopping = true;
          handle.abort.abort();
          await Promise.race([handle.loop?.catch(() => undefined), new Promise((done) => setTimeout(done, 3000))]);
          this.handles.delete(label);
        }
        return publicRegistry(this.registry);
      },
      "bots.test": async (params) => {
        const label = String(params.label ?? this.registry.default);
        const api = this.apiFor(label);
        const me = await api.getMe();
        await setHealth(this.state, label, { ok: true, checkedAt: Date.now(), username: me.username });
        return { label, username: me.username, id: me.id };
      },
      "telegram.status": async () => this.status(),
      "telegram.test": async () => {
        if (!this.users.owner) throw new Error("no owner configured");
        const api = this.apiFor(this.registry.default);
        const message = await api.sendMessage(this.users.owner, "dura test · " + new Date().toISOString());
        return { messageId: message.message_id, bot: this.registry.default };
      },
    };
  }

  private async ipcAddBot(params: Record<string, unknown>): Promise<unknown> {
    const token = String(params.token ?? "");
    if (!token.includes(":")) throw new Error("that does not look like a bot token");
    const config = await readConfig();
    const api = new BotApi({ token, apiBase: config.telegram.apiBase });
    const me = await api.getMe();
    if (!me.username) throw new Error("the bot has no username");
    const label =
      String(params.label ?? "").trim() ||
      me.username.replace(/_?bot$/i, "").replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase().slice(0, 32) ||
      "bot";
    this.registry = await addBot({ label, token, botId: String(me.id), username: me.username });
    await this.startBot(label);
    void this.notifyOwner(
      "New bot @" + me.username + " (" + label + ") is unpaired. One bot is one agent; use /bots or the orchestrator to connect it.",
    );
    return { label, username: me.username };
  }

  private async ipcRemoveBot(label: string): Promise<unknown> {
    const agents = (await listAgents()).filter((agent) => agent.telegramBot === label);
    if (agents.length > 0) throw new Error("agents still use this bot: " + agents.map((agent) => agent.id).join(", "));
    this.registry = await removeBot(label);
    const handle = this.handles.get(label);
    if (handle) {
      handle.stopping = true;
      handle.abort.abort();
      await Promise.race([handle.loop?.catch(() => undefined), new Promise((done) => setTimeout(done, 3000))]);
      this.handles.delete(label);
    }
    return publicRegistry(this.registry);
  }

  /* ----------------------------- updates ----------------------------- */

  private async handleUpdate(handle: BotHandle, update: TgUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(handle, update.callback_query);
      return;
    }
    const message = update.message;
    if (!message) return;
    if (message.migrate_to_chat_id) {
      await this.migrateChat(handle.label, message.chat.id, message.migrate_to_chat_id);
      return;
    }
    await this.handleMessage(handle, message);
  }

  private async handleMessage(handle: BotHandle, message: TgMessage): Promise<void> {
    const from = message.from;
    if (!from || from.is_bot) return;
    const userId = String(from.id);
    const role = roleOf(this.users, userId);

    if (!role) {
      this.users = await notePending(this.users, userId, from.username, (message.text ?? "").slice(0, 120));
      await handle.api.sendMessage(message.chat.id, "This bot is private. The owner has been notified.");
      await this.notifyOwner(
        "🚪 " + (from.username ? "@" + from.username : userId) + " tried to use @" + this.registry.bots.find((bot) => bot.label === handle.label)?.username,
        buttons([[{ text: "Approve", data: "ap:" + userId }, { text: "Block", data: "no:" + userId }]]),
      );
      return;
    }

    const text = (message.text ?? message.caption ?? "").trim();
    if (text.startsWith("/")) {
      await this.handleCommand(handle, message, text, role === "owner");
      return;
    }

    if (message.chat.type === "private") {
      await this.handlePrivate(handle, message, text);
      return;
    }
    if (message.chat.type === "group" || message.chat.type === "supergroup") {
      await this.handleGroup(handle, message, text);
    }
  }

  private apiFor(label: string): BotApi {
    const handle = this.handles.get(label);
    if (handle) return handle.api;
    const bot = botByLabel(this.registry, label) ?? defaultBot(this.registry);
    if (!bot) throw new Error("no bot configured");
    const config = { apiBase: "https://api.telegram.org" };
    return new BotApi({ token: bot.token, apiBase: config.apiBase, label: bot.label });
  }

  private async notifyOwner(text: string, keyboard?: ReturnType<typeof buttons>): Promise<void> {
    if (!this.users.owner) return;
    try {
      const bot = defaultBot(this.registry);
      if (!bot) return;
      await this.apiFor(bot.label).sendMessage(this.users.owner, text.length > 4000 ? text.slice(0, 4000) : text, {
        ...(keyboard ? { keyboard } : {}),
      });
    } catch (error) {
      log.warn("telegram.notify_failed", errorFields(error));
    }
  }

  private async reportError(label: string, error: unknown): Promise<void> {
    const message = error instanceof MediaError ? error.message : "The bot hit an error; it was written to the log.";
    try {
      await this.notifyOwner("⚠️ " + message);
    } catch {
      /* ignore */
    }
    log.error("telegram.error", { bot: label, ...errorFields(error) });
  }

  /* ----------------------------- commands ----------------------------- */

  private async handleCommand(handle: BotHandle, message: TgMessage, text: string, owner: boolean): Promise<void> {
    const [raw, ...parts] = text.split(/\s+/);
    const command = (raw ?? "").split("@")[0]?.replace(/^\//, "") ?? "";
    const argument = parts.join(" ").trim();
    const chatId = message.chat.id;
    const key = chatKey(chatId, message.message_thread_id);

    switch (command) {
      case "start":
        await this.sendMenu(handle, message);
        return;
      case "help":
        await handle.api.sendMessage(
          chatId,
          [
            "<b>Commands</b>",
            "/menu — buttons",
            "/new [title] — new thread",
            "/threads — list and switch threads",
            "/plan [goal] — ask for a plan before executing",
            "/model [provider/model] — show or change the model",
            "/usage — usage report",
            "/agents — switch agent",
            "/memory [agent] — memory notes",
            "/schedules — cron schedules",
            "/status — daemon and connection",
            "/whoami — your id and role",
            "/compact — compact this thread",
            "/abort — abort the current run",
            "/group — group settings · /bind <id> — owner",
            "/mcp — MCP servers and tools for all agents (owner)",
            "/prune [days] — remove stale threads (owner)",
            "/reload — reload tools and threads (owner)",
            "/restart — restart the service (owner)",
            "/orchestrator — show or choose (owner)",
            "/bots — bot registry (owner)",
            "/settings — configuration (owner)",
          ].join("\n"),
          { threadId: message.message_thread_id },
        );
        return;
      case "menu":
      case "commands":
        await this.sendMenu(handle, message);
        return;
      case "whoami":
        await handle.api.sendMessage(
          chatId,
          "id " + message.from?.id + " · " + (owner ? "owner" : "user") + " · bot " + handle.label,
          { threadId: message.message_thread_id },
        );
        return;
      case "status":
        await this.sendStatus(handle, message);
        return;
      case "agents":
        await this.sendAgents(handle, message);
        return;
      case "new":
        await this.newThread(handle, message, argument);
        return;
      case "threads":
        await this.sendThreads(handle, message);
        return;
      case "switch":
        await this.switchThread(handle, message, argument);
        return;
      case "rename":
        await this.renameThread(handle, message, argument);
        return;
      case "abort":
        await this.abortCurrent(handle, message);
        return;
      case "compact":
        await this.compactCurrent(handle, message, owner);
        return;
      case "restart-thread":
        await this.restartCurrent(handle, message, argument, owner);
        return;
      case "model":
        await this.showModel(handle, message, argument, owner);
        return;
      case "grant":
        await this.grant(handle, message, argument, owner);
        return;
      case "usage":
        await this.sendUsage(handle, message, owner);
        return;
      case "memory":
        await this.sendMemory(handle, message, argument);
        return;
      case "bots":
        await this.sendBots(handle, message, owner);
        return;
      case "orchestrator":
        await this.sendOrchestrator(handle, message, argument, owner);
        return;
      case "bind":
        await this.bindGroup(handle, message, argument, owner);
        return;
      case "group":
        await this.groupCommand(handle, message, argument, owner);
        return;
      case "approve":
        await this.approve(handle, message, argument, owner);
        return;
      case "schedules":
        await this.sendSchedules(handle, message);
        return;
      case "groups":
        await this.sendGroups(handle, message);
        return;
      case "plan":
        await this.plan(handle, message, argument, owner);
        return;
      case "prune":
        await this.prune(handle, message, argument, owner);
        return;
      case "mcp":
        await this.mcpCommand(handle, message, argument, owner);
        return;
      case "reload":
        await this.reload(handle, message, owner);
        return;
      case "restart":
        await this.restartService(handle, message, owner);
        return;
      case "settings":
        await this.sendSettings(handle, message, owner);
        return;
      default:
        await handle.api.sendMessage(chatId, "Unknown command. /help lists the ones that exist.", { threadId: message.message_thread_id });
    }
  }

  private async sendMenu(handle: BotHandle, message: TgMessage): Promise<void> {
    const bots = this.registry.bots.find((bot) => bot.label === handle.label);
    await handle.api.sendMessage(
      message.chat.id,
      "<b>dura-agents</b>\n@" + escapeText(bots?.username ?? handle.label) + " · owner " + (this.users.owner ? "set" : "missing"),
      { keyboard: buttons(MENU_ROWS), threadId: message.message_thread_id },
    );
  }

  private async sendStatus(handle: BotHandle, message: TgMessage): Promise<void> {
    const agents = await listAgents();
    const status = (await this.status()) as { bots: { label: string; ok: boolean; username?: string }[] };
    const lines = [
      "<b>Status</b>",
      "agents " + agents.length + " · orchestrator " + (orchestratorId() ?? "none") + " · owner " + (this.users.owner ?? "none"),
      "bots " + status.bots.map((bot) => bot.label + (bot.ok ? " ok" : " down")).join(", "),
      "active runs " + activeIds().length,
    ];
    await handle.api.sendMessage(message.chat.id, lines.join("\n"), { threadId: message.message_thread_id });
  }

  private async sendAgents(handle: BotHandle, message: TgMessage): Promise<void> {
    const paired = await this.pairedAgent(handle.label);
    if (!paired) return void (await this.offerPairing(handle, message));
    const bot = this.registry.bots.find((entry) => entry.label === handle.label);
    await handle.api.sendMessage(
      message.chat.id,
      "<b>" + escapeText(paired.name) + "</b> (" + escapeText(paired.id) + ")\n" +
        "bot @" + escapeText(bot?.username ?? handle.label) + " · one bot, one agent\n" +
        "model " + escapeText(paired.provider + "/" + paired.modelId) + " · " + (paired.permissions ?? "inferred") + "\n" +
        (paired.responsibility ? "responsibility: " + escapeText(paired.responsibility) + "\n" : "") +
        "/new starts a thread · /threads switches · /bots shows other pairings (owner)",
      { threadId: message.message_thread_id },
    );
  }

  private async sendThreads(handle: BotHandle, message: TgMessage): Promise<void> {
    const paired = await this.pairedAgent(handle.label);
    if (!paired) return void (await this.offerPairing(handle, message));
    const sessions = (await import("../../core/src/sessions.ts")).listSessions;
    const list = (await sessions()).filter((session) => session.agent === paired.id).slice(0, 10);
    if (list.length === 0) {
      await handle.api.sendMessage(message.chat.id, "No threads for this agent yet. /new starts one.");
      return;
    }
    const rows = list.map((session) => [
      { text: session.title.slice(0, 40) + " · " + age(Date.now() - session.updatedAt), data: "thread:" + session.id },
    ]);
    await handle.api.sendMessage(message.chat.id, "Threads:", {
      keyboard: buttons(rows),
      threadId: message.message_thread_id,
    });
  }

  private async newThread(handle: BotHandle, message: TgMessage, title: string): Promise<void> {
    const key = chatKey(message.chat.id, message.message_thread_id);
    const binding = getChat(this.state, handle.label, key);
    const paired = await this.pairedAgent(handle.label);
    if (!paired) return void (await this.offerPairing(handle, message));
    const agentId = paired.id;
    const session = await createSession(title || "New thread", agentId);
    await updateSessionRecord(Number(session.id), {
      channel: { kind: "telegram", bot: handle.label, chatId: String(message.chat.id), ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {}) },
    });
    await setChat(this.state, handle.label, key, {
      kind: message.message_thread_id ? "topic" : "dm",
      agentId,
      sessionId: session.id,
      ...(message.message_thread_id ? { topicId: message.message_thread_id } : {}),
    });
    await handle.api.sendMessage(message.chat.id, "New thread: " + escapeText(session.title), { threadId: message.message_thread_id });
  }

  private async switchThread(handle: BotHandle, message: TgMessage, argument: string): Promise<void> {
    const id = argument.replace(/^#/, "").trim();
    if (!id) {
      await this.sendThreads(handle, message);
      return;
    }
    const session = await findSession(id);
    const paired = await this.pairedAgent(handle.label);
    if (!session || !paired || (session.agent !== undefined && session.agent !== paired.id)) {
      await handle.api.sendMessage(message.chat.id, "No thread " + id + " for this bot's agent.");
      return;
    }
    const key = chatKey(message.chat.id, message.message_thread_id);
    await setChat(this.state, handle.label, key, {
      kind: message.message_thread_id ? "topic" : "dm",
      agentId: session.agent,
      sessionId: id,
      ...(message.message_thread_id ? { topicId: message.message_thread_id } : {}),
    });
    await handle.api.sendMessage(message.chat.id, "Switched to: " + escapeText(session.title), { threadId: message.message_thread_id });
  }

  private async renameThread(handle: BotHandle, message: TgMessage, title: string): Promise<void> {
    const binding = getChat(this.state, handle.label, chatKey(message.chat.id, message.message_thread_id));
    if (!binding?.sessionId) {
      await handle.api.sendMessage(message.chat.id, "No active thread.");
      return;
    }
    const { renameSession } = await import("../../core/src/sessions.ts");
    const renamed = await renameSession(binding.sessionId, title);
    await handle.api.sendMessage(message.chat.id, renamed ? "Renamed to: " + escapeText(renamed.title) : "A title cannot be empty.");
  }

  private async abortCurrent(handle: BotHandle, message: TgMessage): Promise<void> {
    const binding = getChat(this.state, handle.label, chatKey(message.chat.id, message.message_thread_id));
    if (!binding?.sessionId) {
      await handle.api.sendMessage(message.chat.id, "No active thread.");
      return;
    }
    const ok = await abortSession(binding.sessionId);
    await handle.api.sendMessage(message.chat.id, ok ? "Aborted." : "That thread is already idle.");
  }

  private async compactCurrent(handle: BotHandle, message: TgMessage, owner: boolean): Promise<void> {
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));
    const binding = getChat(this.state, handle.label, chatKey(message.chat.id, message.message_thread_id));
    if (!binding?.sessionId) return void (await handle.api.sendMessage(message.chat.id, "No active thread."));
    const ok = await compactSession(binding.sessionId);
    await handle.api.sendMessage(message.chat.id, ok ? "Compaction started." : "No such conversation.");
  }

  private async restartCurrent(handle: BotHandle, message: TgMessage, handoff: string, owner: boolean): Promise<void> {
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));
    const binding = getChat(this.state, handle.label, chatKey(message.chat.id, message.message_thread_id));
    if (!binding?.sessionId) return void (await handle.api.sendMessage(message.chat.id, "No active thread."));
    const ok = await restartSession(binding.sessionId, handoff || undefined);
    await handle.api.sendMessage(message.chat.id, ok ? "Fresh context started; the transcript is kept." : "No such conversation.");
  }

  private async showModel(handle: BotHandle, message: TgMessage, argument: string, owner: boolean): Promise<void> {
    const config = await readConfig({ fresh: true });
    const binding = getChat(this.state, handle.label, chatKey(message.chat.id, message.message_thread_id));
    const session = binding?.sessionId ? await findSession(binding.sessionId) : undefined;
    if (!argument) {
      const provider = session?.model?.provider ?? config.models.default.provider;
      const modelId = session?.model?.modelId ?? config.models.default.modelId;
      await handle.api.sendMessage(
        message.chat.id,
        "this thread " + provider + "/" + modelId +
          "\ndefault " + config.models.default.provider + "/" + config.models.default.modelId,
        { threadId: message.message_thread_id },
      );
      if (owner && binding?.sessionId) {
        try {
          const available = await models.getAvailable(provider);
          const ids = available
            .map((model) => (model as { id?: unknown }).id)
            .filter((id): id is string => typeof id === "string")
            .slice(0, 8);
          if (ids.length > 0) {
            await handle.api.sendMessage(message.chat.id, "Choose a model for this thread:", {
              threadId: message.message_thread_id,
              keyboard: buttons(ids.map((id) => [{ text: id, data: "sm:" + provider + "|" + id }])),
            });
          }
        } catch {
          // Offline or no credentials: the textual form /model provider/model still works.
        }
      }
      return;
    }
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));
    if (!binding?.sessionId) return void (await handle.api.sendMessage(message.chat.id, "No active thread."));
    const [provider, modelId] = argument.split("/");
    if (!provider || !modelId) return void (await handle.api.sendMessage(message.chat.id, "Use provider/model, for example opencode-go/deepseek-v4.1-flash"));
    const { setSessionModel } = await import("../../core/src/sessions.ts");
    const result = await setSessionModel(binding.sessionId, { provider, modelId });
    await handle.api.sendMessage(message.chat.id, result ? "Model changed (" + result.changed + ")." : "Could not change the model.");
  }

  private async grant(handle: BotHandle, message: TgMessage, argument: string, owner: boolean): Promise<void> {
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));
    const binding = getChat(this.state, handle.label, chatKey(message.chat.id, message.message_thread_id));
    if (!binding?.sessionId) return void (await handle.api.sendMessage(message.chat.id, "No active thread."));
    const { setSessionGrant } = await import("../../core/src/sessions.ts");
    const updated = await setSessionGrant(binding.sessionId, argument === "full" ? "full" : null);
    await handle.api.sendMessage(message.chat.id, updated ? "Full access " + (argument === "full" ? "granted to this thread." : "revoked.") : "No such thread.");
  }

  private async sendUsage(handle: BotHandle, message: TgMessage, owner: boolean): Promise<void> {
    const report = await usageReport();
    const period = report.periods.today;
    const lines = [
      "<b>Usage today</b>",
      "turns " + period.turns + " · tokens " + period.tokens.toLocaleString("en-US") + " · cached " + period.cacheRead.toLocaleString("en-US"),
      period.cost > 0 ? "cost $" + period.cost.toFixed(4) : "",
    ].filter(Boolean);
    if (owner) {
      lines.push("", "agents:");
      for (const agent of report.agents.slice(0, 10)) lines.push("· " + escapeText(agent.name) + " " + agent.today.tokens.toLocaleString("en-US"));
    }
    await handle.api.sendMessage(message.chat.id, lines.join("\n"));
  }

  private async sendMemory(handle: BotHandle, message: TgMessage, argument: string): Promise<void> {
    const paired = await this.pairedAgent(handle.label);
    const agentId = argument || paired?.id;
    if (!agentId) return void (await handle.api.sendMessage(message.chat.id, "No agent."));
    const memory = await readMemory(agentId).catch(() => "");
    const notes = memory.split("\n").filter((line) => line.trim().startsWith("- ")).slice(-15);
    await handle.api.sendMessage(
      message.chat.id,
      "<b>Memory</b> " + escapeText(agentId) + "\n" + (notes.length ? escapeHtml(notes.join("\n")) : "(empty)"),
    );
  }

  private async sendBots(handle: BotHandle, message: TgMessage, owner: boolean): Promise<void> {
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));
    const [agents, status] = await Promise.all([
      listAgents(),
      this.status() as Promise<{ bots: { label: string; username?: string; ok: boolean; enabled: boolean; default: boolean }[] }>,
    ]);
    const lines = status.bots.map((bot) => {
      const holder = agents.find((agent) => agent.telegramBot === bot.label);
      return (
        "· " + bot.label + " @" + (bot.username ?? "?") + (bot.default ? " (default)" : "") +
        " · " + (bot.ok ? "ok" : "down") + " → " + (holder ? holder.id + " (" + holder.name + ")" : "unpaired")
      );
    });
    const unpairedBots = status.bots.filter((bot) => !agents.some((agent) => agent.telegramBot === bot.label));
    const pairedBots = status.bots.filter((bot) => agents.some((agent) => agent.telegramBot === bot.label));
    const rows = [
      ...unpairedBots.map((bot) => [{ text: "Pair " + bot.label, data: "botmenu:" + bot.label }]),
      ...pairedBots.map((bot) => [{ text: "Release " + bot.label, data: "botrelease:" + bot.label }]),
    ];
    await handle.api.sendMessage(message.chat.id, "<b>Bots</b>\n" + escapeHtml(lines.join("\n")), {
      threadId: message.message_thread_id,
      ...(rows.length > 0 ? { keyboard: buttons(rows) } : {}),
    });
  }

  private async sendOrchestrator(handle: BotHandle, message: TgMessage, argument: string, owner: boolean): Promise<void> {
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));
    if (argument) {
      try {
        await setOrchestrator(argument);
        await handle.api.sendMessage(message.chat.id, "Orchestrator: " + escapeText(argument));
      } catch (error) {
        await handle.api.sendMessage(message.chat.id, escapeText(String(error)));
      }
      return;
    }
    const current = orchestratorId();
    const agents = await listAgents();
    const rows = agents.slice(0, 10).map((agent) => [{ text: (agent.id === current ? "• " : "") + agent.name, data: "orch:" + agent.id }]);
    await handle.api.sendMessage(
      message.chat.id,
      "Orchestrator: " + escapeText(current ?? "none") + "\nChoose one:" +
        (agents.length === 0 ? " (no agents yet)" : ""),
      agents.length > 0 ? { keyboard: buttons(rows) } : undefined,
    );
  }

  private async bindGroup(handle: BotHandle, message: TgMessage, argument: string, owner: boolean): Promise<void> {
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));
    if (message.chat.type === "private") return void (await handle.api.sendMessage(message.chat.id, "/bind is for a group."));
    const id = argument.trim();
    if (!id || !(await isRoom(id))) {
      await handle.api.sendMessage(message.chat.id, "Usage: /bind <group-session-id> (see dura agent list / a room id)");
      return;
    }
    const key = chatKey(message.chat.id, message.message_thread_id);
    await setChat(this.state, handle.label, key, { kind: "group", sessionId: id, speakerBot: handle.label });
    await handle.api.sendMessage(message.chat.id, "This group is bound to thread " + id + ". I am the speaker bot.");
  }

  private async groupCommand(handle: BotHandle, message: TgMessage, argument: string, owner: boolean): Promise<void> {
    if (message.chat.type === "private") return void (await handle.api.sendMessage(message.chat.id, "This command is for a bound group."));
    const binding = getChat(this.state, handle.label, chatKey(message.chat.id, message.message_thread_id));
    if (!binding?.sessionId) return void (await handle.api.sendMessage(message.chat.id, "No group bound here. Owner: /bind <id>"));
    const [field, ...rest] = argument.split(/\s+/);
    if (!field) {
      const record = await findSession(binding.sessionId);
      const room = record?.room;
      await handle.api.sendMessage(
        message.chat.id,
        "<b>Group</b> " + escapeText(record?.title ?? binding.sessionId) + "\nmembers " + (room?.members.join(", ") ?? "-") +
          "\nmode " + (room?.mode ?? "-") + " · speaker " + (binding.speakerBot ?? handle.label),
      );
      return;
    }
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));
    if (field === "mode") {
      const mode = rest[0];
      if (mode !== "nyahut" && mode !== "moderator" && mode !== "silent") {
        await handle.api.sendMessage(message.chat.id, "mode must be nyahut, moderator or silent");
        return;
      }
      await updateRoom(binding.sessionId, { mode });
      await handle.api.sendMessage(message.chat.id, "Mode: " + mode);
      return;
    }
    if (field === "speaker") {
      const label = rest[0];
      if (!label || !this.registry.bots.some((bot) => bot.label === label)) {
        await handle.api.sendMessage(message.chat.id, "Speaker must be a known bot label.");
        return;
      }
      await setChat(this.state, handle.label, chatKey(message.chat.id, message.message_thread_id), { ...binding, speakerBot: label });
      await handle.api.sendMessage(message.chat.id, "Speaker bot: " + label);
      return;
    }
    await handle.api.sendMessage(message.chat.id, "Usage: /group [mode nyahut|moderator|silent | speaker <label>]");
  }

  private async approve(handle: BotHandle, message: TgMessage, argument: string, owner: boolean): Promise<void> {
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));
    if (!argument) {
      const rows = this.users.pending.map((user) => [{ text: (user.username ?? user.id) + " → approve", data: "ap:" + user.id }]);
      await handle.api.sendMessage(message.chat.id, rows.length ? "Pending:" : "No pending users.", rows.length ? { keyboard: buttons(rows) } : undefined);
      return;
    }
    this.users = await approvePending(this.users, argument, this.users.owner ?? undefined);
    await handle.api.sendMessage(message.chat.id, "Approved " + argument);
  }

  private async sendSchedules(handle: BotHandle, message: TgMessage): Promise<void> {
    const { listSchedules } = await import("../../core/src/schedules.ts");
    const schedules = await listSchedules();
    if (schedules.length === 0) return void (await handle.api.sendMessage(message.chat.id, "No schedules."));
    const lines = schedules.slice(0, 15).map(
      (schedule) =>
        "· " + escapeText(schedule.name) + " · " + schedule.agentId + " · " + schedule.cron +
        (schedule.enabled ? "" : " (paused)") +
        (schedule.nextRunAt ? " · next " + new Date(schedule.nextRunAt).toLocaleString() : ""),
    );
    await handle.api.sendMessage(message.chat.id, "<b>Schedules</b>\n" + escapeHtml(lines.join("\n")));
  }

  private async sendGroups(handle: BotHandle, message: TgMessage): Promise<void> {
    const { allSessionRecords } = await import("../../core/src/sessions.ts");
    const rooms = (await allSessionRecords()).filter((record) => record.room && !record.deletedAt);
    if (rooms.length === 0) {
      await handle.api.sendMessage(
        message.chat.id,
        "No groups yet. Create one on the host: dura group create --title <name> --members a,b",
      );
      return;
    }
    const lines = rooms.slice(0, 15).map(
      (room) => "· " + escapeText(room.title) + " — id " + room.id + " · " + (room.room?.mode ?? "-") + " · " + (room.room?.members.join(", ") ?? ""),
    );
    await handle.api.sendMessage(
      message.chat.id,
      "<b>Groups</b>\n" + escapeHtml(lines.join("\n")) + "\n\nIn a group chat, the owner sends /bind <id> to attach it here.",
    );
  }

  private async sendSettings(handle: BotHandle, message: TgMessage, owner: boolean): Promise<void> {
    const config = await readConfig({ fresh: true });
    await handle.api.sendMessage(
      message.chat.id,
      "<b>Settings</b>\n" +
        "model " + escapeText(config.models.default.provider + "/" + config.models.default.modelId) + "\n" +
        "runs " + config.limits.maxConcurrentRuns + " · queued " + config.limits.queuedRuns + "\n" +
        "default bot " + escapeText(config.telegram.defaultBot) + "\n" +
        (owner ? "change model with: dura provider default \nlog: dura logs" : ""),
    );
  }

  /* ----------------------------- chat ----------------------------- */

  /** One bot is one agent: the agent whose home bot is this label, never a fallback to another bot. */
  private async pairedAgent(label: string): Promise<AgentRecord | undefined> {
    const agents = (await listAgents()).filter((agent) => agent.enabled !== false);
    const home = agents.filter((agent) => agent.telegramBot === label);
    if (home.length === 0) return undefined;
    // A legacy duplicate can survive until boot normalisation; prefer the orchestrator deterministically.
    return home.find((agent) => agent.id === orchestratorId()) ?? home[0];
  }

  private async unpairedAgents(): Promise<AgentRecord[]> {
    return (await listAgents()).filter((agent) => agent.enabled !== false && !agent.telegramBot);
  }

  private async offerPairing(handle: BotHandle, message: TgMessage): Promise<void> {
    const owner = this.users.owner === String(message.from?.id);
    const bot = this.registry.bots.find((entry) => entry.label === handle.label);
    if (!owner) {
      await handle.api.sendMessage(message.chat.id, "This bot has no agent. Ask the owner to connect one.");
      return;
    }
    const candidates = await this.unpairedAgents();
    if (candidates.length === 0) {
      await handle.api.sendMessage(
        message.chat.id,
        "This bot (@" + (bot?.username ?? handle.label) + ") has no agent. One bot is one agent. Create one on the host:\n" +
          "dura agent create --name <name> --bot " + handle.label,
        { threadId: message.message_thread_id },
      );
      return;
    }
    const rows = candidates.slice(0, 10).map((agent) => [
      { text: agent.name + " (" + agent.id + ")", data: "botassign:" + handle.label + "|" + agent.id },
    ]);
    await handle.api.sendMessage(
      message.chat.id,
      "This bot (@" + (bot?.username ?? handle.label) + ") has no agent. One bot is one agent. Assign an unpaired agent:",
      { keyboard: buttons(rows), threadId: message.message_thread_id },
    );
  }

  private async handlePrivate(handle: BotHandle, message: TgMessage, text: string): Promise<void> {
    const attachments: AttachmentDraft[] = [];
    try {
      const draft = await attachmentFromMessage(handle.api, message);
      if (draft) attachments.push(draft);
    } catch (error) {
      await handle.api.sendMessage(message.chat.id, error instanceof MediaError ? error.message : "Could not download that file.");
      return;
    }
    if (!text && attachments.length === 0) return;
    await this.deliverPrompt(handle, message, text, attachments);
  }

  /** Resolve (or create) this chat's thread, send the status message and stream the run. */
  private async deliverPrompt(
    handle: BotHandle,
    message: TgMessage,
    text: string,
    attachments: AttachmentDraft[],
    title?: string,
  ): Promise<void> {
    const paired = await this.pairedAgent(handle.label);
    if (!paired) return void (await this.offerPairing(handle, message));
    const key = chatKey(message.chat.id, message.message_thread_id);
    let binding = getChat(this.state, handle.label, key);
    let sessionId = binding?.sessionId;
    if (message.reply_to_message) {
      const replied = sessionForMessage(this.state, handle.label, message.chat.id, message.reply_to_message.message_id);
      if (replied) sessionId = replied;
    }
    if (sessionId) {
      const current = await findSession(sessionId);
      // A pruned thread, or a thread moved to another agent, cannot keep the bot's next message.
      if (!current || current.deletedAt !== undefined || (current.agent !== undefined && current.agent !== paired.id)) {
        sessionId = undefined;
      }
    }
    if (!sessionId) {
      const agentId = paired.id;
      const session = await createSession(title ?? (text.slice(0, 48) || "Telegram thread"), agentId);
      await updateSessionRecord(Number(session.id), {
        channel: {
          kind: "telegram",
          bot: handle.label,
          chatId: String(message.chat.id),
          ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {}),
        },
      });
      binding = {
        kind: message.message_thread_id ? "topic" : "dm",
        agentId,
        sessionId: session.id,
        ...(message.message_thread_id ? { topicId: message.message_thread_id } : {}),
      };
      await setChat(this.state, handle.label, key, binding);
      sessionId = session.id;
    } else if (binding && binding.agentId !== paired.id) {
      binding = { ...binding, agentId: paired.id };
      await setChat(this.state, handle.label, key, binding);
    }

    const busy = activeIds().includes(sessionId);
    const placeholder = await handle.api.sendMessage(
      message.chat.id,
      (busy ? "⏳ queued — " : "⏳ working — ") + escapeText(binding?.agentId ?? "agent"),
      { replyTo: message.message_id, threadId: message.message_thread_id },
    );
    rememberMessage(this.state, handle.label, message.chat.id, placeholder.message_id, sessionId);
    await handle.api.sendChatAction(message.chat.id, "typing").catch(() => undefined);

    const session = await findSession(sessionId);
    void this.runSession({
      handle,
      chatId: message.chat.id,
      threadId: message.message_thread_id,
      sessionId,
      placeholderId: placeholder.message_id,
      agentId: session?.agent ?? "agent",
      text,
      attachments,
      requestId: "tg:" + handle.label + ":" + message.chat.id + ":" + message.message_id,
    });
  }

  private async plan(handle: BotHandle, message: TgMessage, argument: string, _owner: boolean): Promise<void> {
    if (message.chat.type !== "private") {
      await handle.api.sendMessage(
        message.chat.id,
        "/plan runs in a private chat. Send the goal there and the agent plans before acting.",
        { threadId: message.message_thread_id },
      );
      return;
    }
    const binding = getChat(this.state, handle.label, chatKey(message.chat.id, message.message_thread_id));
    let goal = argument.trim();
    if (!goal && binding?.sessionId) {
      const entries = await transcript(binding.sessionId);
      const last = [...entries].reverse().find((entry) => entry.role === "user");
      goal = (last?.text ?? "").trim();
    }
    if (!goal) {
      await handle.api.sendMessage(message.chat.id, "Usage: /plan <goal>. The agent returns a plan and does not execute it.", {
        threadId: message.message_thread_id,
      });
      return;
    }
    const prompt =
      "Plan only. Do not execute yet. Produce a concise plan for: " + goal +
      "\n\nStructure: Goal; Steps (owner, action, done-when); Risks; Open questions.";
    await this.deliverPrompt(handle, message, prompt, [], "Plan: " + goal.slice(0, 40));
  }

  private async prune(handle: BotHandle, message: TgMessage, argument: string, owner: boolean): Promise<void> {
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));
    const days = Number.parseInt(argument, 10);
    const config = await readConfig({ fresh: true });
    const olderThanDays = Number.isFinite(days) && days > 0 ? days : config.storage.pruneAfterDays;
    const { pruneSessions } = await import("../../core/src/sessions.ts");
    const preview = await pruneSessions({ olderThanDays, dryRun: true });
    if (preview.candidates.length === 0) {
      await handle.api.sendMessage(message.chat.id, "No stale threads older than " + olderThanDays + " days.", {
        threadId: message.message_thread_id,
      });
      return;
    }
    const lines = preview.candidates.slice(0, 12).map((candidate) => "· " + escapeText(candidate.title.slice(0, 50)) + " (" + age(Date.now() - candidate.updatedAt) + ")");
    await handle.api.sendMessage(
      message.chat.id,
      "<b>Stale threads</b>\n" + preview.candidates.length + " thread(s) older than " + olderThanDays + " days:\n" +
        lines.join("\n") + (preview.candidates.length > 12 ? "\n… " + (preview.candidates.length - 12) + " more" : "") +
        "\n\nDeleting is recoverable (dura thread restore <id>). Purge is CLI-only.",
      {
        threadId: message.message_thread_id,
        keyboard: buttons([
          [{ text: "Delete " + preview.candidates.length, data: "prune:" + olderThanDays }, { text: "Purge " + preview.candidates.length, data: "prunepurge:" + olderThanDays }],
          [{ text: "Cancel", data: "pruneno" }],
        ]),
      },
    );
  }

  private async mcpCommand(handle: BotHandle, message: TgMessage, argument: string, owner: boolean): Promise<void> {
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));
    const { addMcpServer, mcpStatus, mcpToolInfos, reloadMcp, removeMcpServer } = await import("../../core/src/mcp.ts");
    const [sub, ...rest] = argument.split(/\s+/).filter(Boolean);
    if (sub === "add") {
      const name = rest[0];
      const command = rest[1];
      const args = rest.slice(2);
      if (!name || !command) {
        await handle.api.sendMessage(message.chat.id, "Usage: /mcp add <name> <command> [args…]");
        return;
      }
      try {
        const result = await addMcpServer({ name, command, args });
        await handle.api.sendMessage(
          message.chat.id,
          "MCP <b>" + escapeText(name) + "</b> connected · " + result.tools.length + " tools · " + result.rebound +
            " agents rebound.\nAll agents now have: " + escapeHtml(result.tools.join(", ")),
        );
      } catch (error) {
        await handle.api.sendMessage(message.chat.id, escapeText(error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    if (sub === "remove") {
      const name = rest[0];
      if (!name) return void (await handle.api.sendMessage(message.chat.id, "Usage: /mcp remove <name>"));
      try {
        const result = await removeMcpServer(name);
        await handle.api.sendMessage(message.chat.id, result.removed ? "Removed " + escapeText(name) + " · " + result.rebound + " agents rebound." : "No MCP server " + escapeText(name) + ".");
      } catch (error) {
        await handle.api.sendMessage(message.chat.id, escapeText(error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    if (sub === "reload") {
      const result = await reloadMcp();
      await handle.api.sendMessage(message.chat.id, "MCP reloaded · " + result.servers.length + " servers · " + result.tools.length + " tools.");
      return;
    }
    const servers = mcpStatus();
    const tools = mcpToolInfos();
    if (servers.length === 0) {
      await handle.api.sendMessage(
        message.chat.id,
        "No MCP servers. Add one from the host: dura mcp add <name> -- <command>\n" +
          "or from here: /mcp add <name> <command> [args…]\nMCP tools become available to every agent.",
      );
      return;
    }
    const lines = servers.map(
      (server) => "· " + server.name + " · " + (server.connected ? "connected" : server.error ? "error" : "stopped") + " · " + server.tools.length + " tools" +
        (server.error ? " (" + server.error.slice(0, 80) + ")" : ""),
    );
    await handle.api.sendMessage(
      message.chat.id,
      "<b>MCP</b> (for all agents)\n" + escapeHtml(lines.join("\n")) +
        (tools.length ? "\n\n" + escapeHtml(tools.map((tool) => tool.registeredName).slice(0, 20).join(", ")) : "") +
        "\n\n/mcp add <name> <command> [args…] · /mcp remove <name> · /mcp reload",
    );
  }

  private async reload(handle: BotHandle, message: TgMessage, owner: boolean): Promise<void> {
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));
    const result = await reloadEverything();
    await syncBotCommands(handle.api).catch(() => undefined);
    const { listSessions } = await import("../../core/src/sessions.ts");
    const sessions = await listSessions();
    await handle.api.sendMessage(
      message.chat.id,
      "Reloaded " + result.extensions.length + " extensions · rebound " + result.rebound + " agents · " + sessions.length + " threads visible. Bot commands resynced.",
      { threadId: message.message_thread_id },
    );
    log.info("telegram.reload", { extensions: result.extensions.length, rebound: result.rebound });
  }

  private async restartService(handle: BotHandle, message: TgMessage, owner: boolean): Promise<void> {
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));
    await handle.api.sendMessage(
      message.chat.id,
      "<b>Restart the service?</b>\nThe daemon stops and systemd starts it again. In-flight runs are durable and resume.",
      {
        threadId: message.message_thread_id,
        keyboard: buttons([[{ text: "Restart", data: "svc:restart" }, { text: "Cancel", data: "svc:no" }]]),
      },
    );
  }

  private async runSession(input: {
    handle: BotHandle;
    chatId: number;
    threadId?: number;
    sessionId: string;
    placeholderId: number;
    agentId: string;
    text: string;
    attachments: AttachmentDraft[];
    requestId: string;
  }): Promise<void> {
    const { handle, chatId, threadId, sessionId, placeholderId } = input;
    const config = await readConfig();
    const started = Date.now();
    const before = (await transcript(sessionId)).length;
    let live = "";
    let phase = "starting";
    let calls = 0;
    let finished = false;
    const edit = async (html: string): Promise<void> => {
      try {
        await handle.api.editMessage(chatId, placeholderId, html);
      } catch (error) {
        if (BotApi.isEditableFailure(error)) finished = true;
      }
    };
    const timer = setInterval(() => {
      if (finished) return;
      void edit(renderLive(phase + " · " + age(Date.now() - started) + (calls ? " · " + calls + " tools" : ""), live));
      void handle.api.sendChatAction(chatId, "typing").catch(() => undefined);
    }, Math.max(1000, config.telegram.editIntervalMs));

    let stopStream: (() => Promise<void>) | undefined;
    try {
      const conversation = await harnessInstance().conversation(Number(sessionId) as never, context);
      if (!conversation) throw new Error("conversation not found");
      const stream = await openEventStream(harnessInstance(), conversation.id, context, (frame) => {
        if (frame.type === "delta") live += frame.text;
        else if (frame.type === "message-end" && frame.text) live = frame.text;
        else if (frame.type === "activity") {
          phase = frame.activity.phase ?? "working";
          calls = frame.activity.calls.length;
        }
      });
      stopStream = stream.stop;
    } catch (error) {
      log.debug("telegram.stream_unavailable", { sessionId, ...errorFields(error) });
    }

    try {
      const submission = await sendMessage(sessionId, {
        text: input.text,
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        requestId: input.requestId,
      });
      if (!submission) throw new Error("the thread disappeared");
      const submissionId = submission.submissionId;
      const record = await harnessInstance().submission(Number(submissionId) as never, context);
      if (record) {
        await Promise.race([
          record.wait(context),
          new Promise((_done, reject) => setTimeout(() => reject(new Error("the run did not settle within 30 minutes")), 30 * 60_000)),
        ]);
      }
    } catch (error) {
      finished = true;
      clearInterval(timer);
      await stopStream?.().catch(() => undefined);
      await edit("⚠️ " + escapeText(error instanceof Error ? error.message : String(error)));
      log.error("telegram.run_failed", { sessionId, ...errorFields(error) });
      return;
    }

    finished = true;
    clearInterval(timer);
    await stopStream?.().catch(() => undefined);

    const entries = await transcript(sessionId);
    const fresh = entries.slice(before);
    const question = [...fresh].reverse().find((entry) => entry.kind === "chat.question");
    const answer = [...fresh].reverse().find((entry) => entry.role === "assistant" && entry.text.trim().length > 0);

    if (question) {
      const data = (question.data ?? {}) as { options?: unknown };
      const options = Array.isArray(data.options) ? data.options.filter((value): value is string => typeof value === "string") : [];
      const keyboard = questionKeyboard(sessionId, options);
      const html = "<b>Question</b>\n\n" + markdownToHtml(question.text) + (keyboard ? "" : "\n\nType the answer.");
      // One edit with the keyboard: a plain edit followed by a keyboard edit shows a flicker and gives
      // the fake/Live client two intermediate states to reason about.
      if (keyboard) {
        try {
          await handle.api.editMessage(chatId, placeholderId, html, keyboard);
        } catch {
          await edit(html);
        }
      } else {
        await edit(html);
      }
    } else if (answer) {
      const html = renderAnswer(answer);
      const chunks = splitMessage(html);
      await edit(chunks[0] ?? html);
      for (const chunk of chunks.slice(1)) await handle.api.sendMessage(chatId, chunk, { threadId });
      await this.sendArtifacts(handle, chatId, threadId, fresh);
    } else {
      await edit("(no answer)");
    }

    log.info("telegram.conversation", {
      sessionId,
      agent: input.agentId,
      ms: Date.now() - started,
      entries: fresh.length,
      question: Boolean(question),
    });
  }

  private async sendArtifacts(handle: BotHandle, chatId: number, threadId: number | undefined, entries: WireMsg[]): Promise<void> {
    for (const entry of entries) {
      for (const artifact of entry.artifacts ?? []) {
        const bytes = await readArtifact(entry.id ?? "", artifact.id);
        if (!bytes) continue;
        try {
          await handle.api.sendDocument(chatId, artifact.name, artifact.mimeType, new Uint8Array(bytes), undefined, threadId);
        } catch (error) {
          log.warn("telegram.artifact_failed", { artifact: artifact.name, ...errorFields(error) });
        }
      }
    }
  }

  private async handleGroup(handle: BotHandle, message: TgMessage, text: string): Promise<void> {
    const key = chatKey(message.chat.id, message.message_thread_id);
    const seenKey = handle.label + ":" + message.chat.id + ":" + message.message_id;
    if (this.seen.has(seenKey)) return;
    this.seen.set(seenKey, Date.now());
    for (const [entry, at] of this.seen) if (Date.now() - at > 10 * 60_000) this.seen.delete(entry);

    const binding = getChat(this.state, handle.label, key) ?? getChat(this.state, handle.label, String(message.chat.id));
    if (!binding?.sessionId) {
      if (text.startsWith("/")) return;
      return void (await handle.api.sendMessage(message.chat.id, "This group is not bound. Owner: /bind <group-session-id>"));
    }
    if (binding.speakerBot && binding.speakerBot !== handle.label) {
      const mentioned = text.includes("@") && (this.registry.bots.find((bot) => bot.label === handle.label)?.username ?? "");
      if (!mentioned) return;
    }

    const placeholder = await handle.api.sendMessage(message.chat.id, "⏳ group is thinking…", { threadId: message.message_thread_id });
    const agentNames = new Map((await listAgents()).map((agent) => [agent.id, agent.name]));
    let stopStream: (() => Promise<void>) | undefined;
    try {
      const conversation = await harnessInstance().conversation(Number(binding.sessionId) as never, context);
      if (conversation) {
        const stream = await openEventStream(harnessInstance(), conversation.id, context, (frame) => {
          if (frame.type !== "entry") return;
          const entry = frame.entry;
          const kind = entry.kind ?? "";
          const author = entry.author ?? "agent";
          const name = agentNames.get(author) ?? author;
          if (kind === "chat.agent-message") {
            void handle.api.sendMessage(message.chat.id, "<b>" + escapeText(name) + "</b>\n" + markdownToHtml(entry.text), { threadId: message.message_thread_id });
          } else if (kind === "chat.note") {
            void handle.api.sendMessage(message.chat.id, "<i>" + escapeText(name + " (note)") + "</i>\n" + markdownToHtml(entry.text), { threadId: message.message_thread_id });
          } else if (kind === "room.claim" || kind === "room.no-claim" || kind === "room.error" || kind === "room.no-target") {
            void handle.api.sendMessage(message.chat.id, "<i>" + escapeText(entry.text) + "</i>", { threadId: message.message_thread_id });
          } else if (kind === "room.usage") {
            void handle.api.sendMessage(message.chat.id, "<i>" + escapeText(entry.text) + "</i>", { threadId: message.message_thread_id });
          } else if (kind === "chat.typing") {
            void handle.api.sendChatAction(message.chat.id, "typing").catch(() => undefined);
          }
        });
        stopStream = stream.stop;
      }
    } catch (error) {
      log.debug("telegram.room_stream_unavailable", errorFields(error));
    }

    try {
      await postToRoom(binding.sessionId, { text, requestId: "tg:" + handle.label + ":" + message.chat.id + ":" + message.message_id });
      await handle.api.editMessage(message.chat.id, placeholder.message_id, "<i>group finished</i>").catch(() => undefined);
    } catch (error) {
      await handle.api.editMessage(message.chat.id, placeholder.message_id, "⚠️ " + escapeText(error instanceof Error ? error.message : String(error))).catch(() => undefined);
    } finally {
      await stopStream?.().catch(() => undefined);
    }
  }

  /* ----------------------------- callbacks ----------------------------- */

  private async handleCallback(handle: BotHandle, query: TgCallbackQuery): Promise<void> {
    const userId = String(query.from.id);
    const owner = roleOf(this.users, userId) === "owner";
    const data = query.data ?? "";
    await handle.api.answerCallback(query.id).catch(() => undefined);
    if (!query.message) return;
    const message = query.message;
    const chatId = message.chat.id;
    const key = chatKey(chatId, message.message_thread_id);

    if (!isAllowed(this.users, userId)) {
      await handle.api.sendMessage(chatId, "Not authorized.");
      return;
    }

    if (data.startsWith("ap:") || data.startsWith("no:")) {
      if (!owner) return void (await handle.api.sendMessage(chatId, "Owner only."));
      const id = data.slice(3);
      if (data.startsWith("ap:")) {
        this.users = await approvePending(this.users, id, this.users.owner ?? undefined);
        await handle.api.sendMessage(chatId, "Approved " + id);
      } else {
        this.users = await denyPending(this.users, id);
        await handle.api.sendMessage(chatId, "Blocked " + id);
      }
      return;
    }

    if (data.startsWith("agent:")) {
      await handle.api.sendMessage(chatId, "One bot is one agent. Use /bots to pair a bot with " + escapeText(data.slice(6)) + ".");
      return;
    }

    if (data.startsWith("botmenu:")) {
      if (!owner) return void (await handle.api.sendMessage(chatId, "Owner only."));
      const bot = data.slice(8);
      const candidates = await this.unpairedAgents();
      if (candidates.length === 0) {
        await handle.api.sendMessage(chatId, "No unpaired agents. Create one with: dura agent create --bot " + escapeText(bot));
        return;
      }
      const rows = candidates.slice(0, 10).map((agent) => [
        { text: agent.name + " (" + agent.id + ")", data: "botassign:" + bot + "|" + agent.id },
      ]);
      await handle.api.sendMessage(chatId, "Assign an agent to " + escapeText(bot) + ":", { keyboard: buttons(rows) });
      return;
    }

    if (data.startsWith("botassign:")) {
      if (!owner) return void (await handle.api.sendMessage(chatId, "Owner only."));
      const payload = data.slice(10);
      const split = payload.indexOf("|");
      if (split <= 0) return;
      const bot = payload.slice(0, split);
      const agent = payload.slice(split + 1);
      try {
        const result = await assignBotToAgent(bot, agent, "telegram");
        await handle.api
          .editMessage(chatId, message.message_id, "Bot " + escapeText(bot) + " now belongs to " + escapeText(agent) +
            (result.freed.length ? "; unpaired " + escapeText(result.freed.join(", ")) : "") + ".")
          .catch(() => undefined);
      } catch (error) {
        await handle.api.sendMessage(chatId, escapeText(error instanceof Error ? error.message : String(error)));
      }
      return;
    }

    if (data.startsWith("botrelease:")) {
      if (!owner) return void (await handle.api.sendMessage(chatId, "Owner only."));
      const bot = data.slice(11);
      const freed = await releaseBot(bot, "telegram");
      await handle.api
        .editMessage(chatId, message.message_id, freed.length ? "Unpaired " + escapeText(freed.join(", ")) + " from " + escapeText(bot) + "." : "No agent held " + escapeText(bot) + ".")
        .catch(() => undefined);
      return;
    }

    if (data.startsWith("thread:")) {
      const sessionId = data.slice(7);
      const session = await findSession(sessionId);
      const paired = await this.pairedAgent(handle.label);
      if (!session || !paired || (session.agent !== undefined && session.agent !== paired.id)) {
        return void (await handle.api.sendMessage(chatId, "That thread does not belong to this bot's agent."));
      }
      await setChat(this.state, handle.label, key, {
        kind: message.message_thread_id ? "topic" : "dm",
        agentId: paired.id,
        sessionId,
      });
      await handle.api.sendMessage(chatId, "Thread: " + escapeText(session.title));
      return;
    }

    if (data.startsWith("q:")) {
      const [, sessionId, index] = data.split(":");
      const session = sessionId ? await findSession(sessionId) : undefined;
      if (!session) return void (await handle.api.sendMessage(chatId, "That question expired."));
      const entries = await transcript(sessionId ?? "");
      const question = [...entries].reverse().find((entry) => entry.kind === "chat.question");
      const options = (question?.data as { options?: unknown } | undefined)?.options;
      const list = Array.isArray(options) ? options.filter((value): value is string => typeof value === "string") : [];
      const answer = list[Number(index)];
      if (!answer) return void (await handle.api.sendMessage(chatId, "That option is gone."));
      await sendMessage(sessionId ?? "", { text: answer, requestId: "tg:answer:" + query.id });
      await handle.api.editMessage(chatId, message.message_id, "<i>answer: " + escapeText(answer) + "</i>").catch(() => undefined);
      return;
    }

    if (data.startsWith("orch:")) {
      if (!owner) return void (await handle.api.sendMessage(chatId, "Owner only."));
      try {
        await setOrchestrator(data.slice(5));
        await handle.api.sendMessage(chatId, "Orchestrator: " + escapeText(data.slice(5)));
      } catch (error) {
        await handle.api.sendMessage(chatId, escapeText(String(error)));
      }
      return;
    }

    if (data.startsWith("oc:")) {
      if (!owner) return void (await handle.api.sendMessage(chatId, "Owner only."));
      const agentId = data.slice(3);
      try {
        await setOrchestrator(agentId);
        await handle.api.editMessage(chatId, message.message_id, "Orchestrator: " + escapeText(agentId)).catch(() => undefined);
        log.info("telegram.orchestrator_approved", { agentId });
      } catch (error) {
        await handle.api.sendMessage(chatId, escapeText(error instanceof Error ? error.message : String(error)));
      }
      return;
    }

    if (data.startsWith("ocno:")) {
      if (!owner) return void (await handle.api.sendMessage(chatId, "Owner only."));
      await handle.api.editMessage(chatId, message.message_id, "Orchestrator request denied.").catch(() => undefined);
      return;
    }

    if (data.startsWith("sm:")) {
      if (!owner) return void (await handle.api.sendMessage(chatId, "Owner only."));
      const payload = data.slice(3);
      const split = payload.indexOf("|");
      if (split <= 0) return;
      const provider = payload.slice(0, split);
      const modelId = payload.slice(split + 1);
      const binding = getChat(this.state, handle.label, key);
      if (!binding?.sessionId) return void (await handle.api.sendMessage(chatId, "No active thread."));
      const { setSessionModel } = await import("../../core/src/sessions.ts");
      const result = await setSessionModel(binding.sessionId, { provider, modelId });
      await handle.api
        .editMessage(chatId, message.message_id, result ? "Model: " + escapeText(provider + "/" + modelId) + " (" + result.changed + ")" : "Could not change the model.")
        .catch(() => undefined);
      return;
    }

    if (data === "svc:restart") {
      if (!owner) return void (await handle.api.sendMessage(chatId, "Owner only."));
      await handle.api.editMessage(chatId, message.message_id, "<b>Restarting…</b> The bot reconnects in a few seconds.").catch(() => undefined);
      setTimeout(() => {
        try {
          startOperation("restart");
        } catch (error) {
          log.error("telegram.restart_failed", errorFields(error));
        }
      }, 600);
      return;
    }

    if (data.startsWith("prune:")) {
      if (!owner) return void (await handle.api.sendMessage(chatId, "Owner only."));
      const config = await readConfig({ fresh: true });
      const days = Number.parseInt(data.slice(6), 10) || config.storage.pruneAfterDays;
      const { pruneSessions } = await import("../../core/src/sessions.ts");
      const result = await pruneSessions({ olderThanDays: days });
      await handle.api
        .editMessage(chatId, message.message_id, "Deleted " + result.deleted + " stale thread(s)" + (result.failed.length ? " · " + result.failed.length + " failed" : "") + ".")
        .catch(() => undefined);
      log.info("telegram.threads_pruned", { days, deleted: result.deleted, failed: result.failed.length });
      return;
    }

    if (data.startsWith("prunepurge:")) {
      if (!owner) return void (await handle.api.sendMessage(chatId, "Owner only."));
      const configPurge = await readConfig({ fresh: true });
      const days = Number.parseInt(data.slice(12), 10) || configPurge.storage.pruneAfterDays;
      const { pruneSessions } = await import("../../core/src/sessions.ts");
      const preview = await pruneSessions({ olderThanDays: days, dryRun: true });
      await handle.api
        .editMessage(
          chatId,
          message.message_id,
          "<b>Purge " + preview.candidates.length + " threads?</b>\n" +
            "Transcripts are exported to ~/.dura-file/exports, then the rows and artifacts are deleted. This is irreversible. Soft delete is the other button.",
          buttons([[{ text: "Purge permanently", data: "prunepurge2:" + days }, { text: "Cancel", data: "pruneno" }]]),
        )
        .catch(() => undefined);
      return;
    }

    if (data.startsWith("prunepurge2:")) {
      if (!owner) return void (await handle.api.sendMessage(chatId, "Owner only."));
      const configPurge2 = await readConfig({ fresh: true });
      const days = Number.parseInt(data.slice(13), 10) || configPurge2.storage.pruneAfterDays;
      const { pruneSessions } = await import("../../core/src/sessions.ts");
      const result = await pruneSessions({ olderThanDays: days, purge: true });
      const { cleanupStorage } = await import("../../core/src/storage.ts");
      const cleanup = await cleanupStorage().catch(() => ({ reclaimedBytes: 0 }));
      await handle.api
        .editMessage(
          chatId,
          message.message_id,
          "Purged " + result.purged + " thread(s)" + (result.failed.length ? " · " + result.failed.length + " failed" : "") +
            " · reclaimed " + Math.round(Number(cleanup.reclaimedBytes ?? 0) / 1024) + " KiB.",
        )
        .catch(() => undefined);
      log.info("telegram.threads_purged", { days, purged: result.purged, failed: result.failed.length });
      return;
    }

    if (data === "pruneno") {
      await handle.api.editMessage(chatId, message.message_id, "Prune cancelled.").catch(() => undefined);
      return;
    }

    if (data === "svc:no") {
      await handle.api.editMessage(chatId, message.message_id, "Restart cancelled.").catch(() => undefined);
      return;
    }

    if (data.startsWith("cmd:")) {
      const command = data.slice(4);
      const text = command === "new" ? "/new" : "/" + command;
      await this.handleCommand(handle, { ...message, text }, text, owner);
    }
  }

  private async migrateChat(label: string, fromId: number, toId: number): Promise<void> {
    const botState = stateFor(this.state, label);
    const next: typeof botState.chats = {};
    for (const [key, binding] of Object.entries(botState.chats)) {
      if (key.startsWith(String(fromId))) next[key.replace(String(fromId), String(toId))] = binding;
      else next[key] = binding;
    }
    botState.chats = next;
    await this.persist();
    log.info("telegram.chat_migrated", { bot: label, from: fromId, to: toId });
  }
}
