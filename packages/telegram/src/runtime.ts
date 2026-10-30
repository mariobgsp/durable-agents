import { context, harnessInstance } from "../../core/src/harness.ts";
import { activeIds } from "../../core/src/activity.ts";
import { listAgents, readAgent, readMemory, isThinkingLevel, THINKING_LEVELS, applyThinkingLevel, type AgentRecord, type ThinkingLevel } from "../../core/src/agents.ts";
import { readConfig, updateConfig } from "../../core/src/config.ts";
import { models } from "../../core/src/models.ts";
import { reloadEverything } from "../../core/src/reload.ts";
import { bootRestartNotice, onRestart, startOperation, type RestartBrief } from "../../core/src/system.ts";
import { syncBotCommands } from "./command-catalog.ts";
import { errorFields, log } from "../../core/src/logger.ts";
import { orchestratorId, setOrchestrator, subscribeOrchestrator } from "../../core/src/orchestrator.ts";
import { assignBotToAgent, releaseBot, setBotConnector, setBotResolver, subscribeAdmin } from "../../core/src/agent-admin.ts";
import { subscribeDocChanges } from "../../core/src/doc-store.ts";
import { isRoom, postToRoom, updateRoom } from "../../core/src/rooms.ts";
import {
  abortSession,
  compactSession,
  createSession,
  findSession,
  rebindAgent,
  restartSession,
  sendMessage,
  sessionBusy,
  setSessionThinking,
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
  setPending,
  clearPending,
  pendingDeliveries,
  restartNotices,
  setRestartNotice,
  clearRestartNotice,
  type TgState,
  type PendingDelivery,
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
import { escapeHtml, markdownToHtml, questionKeyboard, renderAnswer, renderRichAnswer, splitMessage, buttons } from "./render.ts";
import type { TgCallbackQuery, TgChat, TgMessage, TgUpdate } from "./types.ts";

/**
 * The Telegram runtime: one long poll per bot, one allowlist, one state file. It is deliberately a
 * thin transport over the core services — every durable decision (session, room, schedule, agent)
 * belongs to core. A Telegram failure can stop a poller; it cannot lose a run.
 */

function modelKeyboard(provider: string, ids: string[], page: number): ReturnType<typeof buttons> {
  const perPage = 10;
  const pages = Math.max(1, Math.ceil(ids.length / perPage));
  const current = Math.min(Math.max(0, page), pages - 1);
  const slice = ids.slice(current * perPage, (current + 1) * perPage);
  const rows: { text: string; data: string }[][] = [];
  for (let index = 0; index < slice.length; index += 2) {
    rows.push(
      slice.slice(index, index + 2).map((id) => ({
        text: id.length > 28 ? id.slice(0, 27) + "…" : id,
        data: "sm:" + provider + "|" + id,
      })),
    );
  }
  const nav: { text: string; data: string }[] = [];
  if (current > 0) nav.push({ text: "Prev", data: "smp:" + provider + ":" + (current - 1) });
  if (current < pages - 1) nav.push({ text: "Next", data: "smp:" + provider + ":" + (current + 1) });
  if (nav.length > 0) rows.push(nav);
  return buttons(rows);
}

/** How often the status bubble may be edited. Telegram rate-limits edits per message, so this is a floor. */
const STATUS_EDIT_MS = 1200;

/**
 * How often the typing action is re-sent.
 *
 * Telegram's "typing…" clears itself after about five seconds, so one call at the start of a run is visible
 * for five seconds and then the chat looks idle for the rest of it. Four seconds keeps the indicator alive
 * without a burst of calls.
 */
const TYPING_REFRESH_MS = 4000;

/** How long a wait for a run to end lasts before the status says so and keeps waiting. */
const RUN_CHECKPOINT_MS = 10 * 60_000;

/** How long a placed prompt may take to turn into a busy thread before delivery stops waiting for it. */
const RUN_START_GRACE_MS = 15_000;

/** How long the transcript is re-read after a run ends, in case the commit trails the idle signal. */
const OUTCOME_GRACE_MS = 10_000;

/**
 * One line per call, in the words of the call itself.
 *
 * The summary comes from the tool's own arguments (`bash: git status`, `edit: core/src/live.ts`), so the line
 * says what ran rather than that something ran. Eight words is the budget: a trace the owner reads in a
 * notification, not a log.
 */
function progressLine(tool: string, summary?: string): string {
  const name = tool.toLowerCase();
  const label =
    name === "bash" || name === "terminal" ? "bash"
    : name === "read" ? "read"
    : name === "write" || name === "edit" || name === "create_file" ? name
    : name === "grep" || name === "glob" || name === "find" ? "search"
    : name === "codemode" ? "codemode"
    : name === "coding" ? "coding"
    : name === "browser" ? "browser"
    : name === "question" ? "asking you"
    : name.startsWith("mcp__") ? "mcp: " + tool.split("__").slice(2).join("__")
    : name.startsWith("agents_") ? "team: " + name.replace("agents_", "")
    : tool;
  const detail = (summary ?? "").trim();
  return detail ? label + ": " + detail : label;
}

/**
 * The status message while a run is in flight: the thought, then the calls.
 *
 * It is one message that is edited, not a new message per call, because a burst of twenty notifications for
 * twenty `read`s is noise the owner has to scroll past. Three calls is the window: the latest is the answer
 * to "what is it doing now", and older ones have already left the interesting part of the run.
 */
function liveStatus(input: { thinking?: string; phase: string | null; lines: string[] }): string {
  const head = input.thinking ? "\u{1F9E0} " + escapeHtml(input.thinking) : phaseLabel(input.phase);
  const tail = input.lines.slice(-3).map((line) => "\u2699\uFE0F " + escapeHtml(line));
  return [head, ...tail].filter(Boolean).join("\n");
}

function phaseLabel(phase: string | null): string {
  if (phase === "thinking") return "\u{1F9E0} thinking…";
  if (phase === "writing") return "\u270D\uFE0F writing the answer…";
  if (phase === "compacting") return "\u{1F5DC}\uFE0F compacting the context…";
  if (phase === "retrying") return "\u{1F501} retrying…";
  if (phase === "tool") return "\u2699\uFE0F working…";
  return "starting…";
}

type BotHandle = { label: string; api: BotApi; loop: Promise<void> | undefined; stopping: boolean; abort: AbortController };

const MENU_ROWS = [
  [{ text: "Agents", data: "cmd:agents" }, { text: "New thread", data: "cmd:new" }],
  [{ text: "Threads", data: "cmd:threads" }, { text: "Plan", data: "cmd:plan" }],
  [{ text: "Model", data: "cmd:model" }, { text: "Usage", data: "cmd:usage" }],
  [{ text: "Stop", data: "cmd:stop" }, { text: "Abort", data: "cmd:abort" }],
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
  /** Placeholder messages per session, so /stop can turn every pending card into "stopped." */
  private readonly thinking = new Map<string, Map<number, { chatId: number; threadId?: number; label: string }>>();
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
    setBotConnector((input) => this.connectBotToken(input));

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
    // While the bots are up and before recovery steals the pending records: this is the one moment where the
    // number of interrupted runs is still the truth about what the last process left behind.
    await this.reportRestart().catch((error) => log.warn("telegram.restart_report_failed", errorFields(error)));
    this.unsubscribers.push(onRestart((notice) => {
      if (notice.phase !== "leaving") return;
      return this.announceLeaving(notice.brief);
    }));
    // After the bots are up: the runs that outlived the last process owe an answer to a chat that must exist.
    this.recoverDeliveries();
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
    let failures = 0;
    while (!this.stopping && !handle.stopping) {
      const botState = stateFor(this.state, handle.label);
      try {
        const updates = await handle.api.getUpdates(botState.offset, 20, handle.abort.signal);
        failures = 0;
        // A successful poll with zero updates still proves the connection is up.
        if (!botState.health.ok) {
          botState.health = { ok: true, checkedAt: Date.now(), username: botState.health.username };
          await this.persist();
          log.info("telegram.reconnected", { label: handle.label });
        }
        if (updates.length === 0) continue;
        for (const update of updates) {
          botState.offset = Math.max(botState.offset, update.update_id + 1);
          await this.handleUpdate(handle, update).catch((error) => {
            log.error("telegram.update_failed", { bot: handle.label, update: update.update_id, ...errorFields(error) });
            void this.reportError(handle.label, error);
          });
        }
        await this.persist();
      } catch (error) {
        if (this.stopping || handle.stopping || handle.abort.signal.aborted) return;
        failures += 1;
        const fatal = error instanceof TelegramError && (error.status === 401 || error.status === 409);
        botState.health = {
          ok: false,
          checkedAt: Date.now(),
          lastError: error instanceof Error ? error.message : String(error),
          ...(botState.health.username ? { username: botState.health.username } : {}),
        };
        await this.persist();
        log.error("telegram.poll_failed", { bot: handle.label, fatal, failures, ...errorFields(error) });
        if (fatal) return;
        const delay = Math.min(15_000, 1_000 * 2 ** Math.min(failures - 1, 4));
        await new Promise((done) => setTimeout(done, delay));
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
      platform: "telegram",
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
            "/thinking [level|all level] — reasoning effort for one agent or every agent",
            "/usage — usage report",
            "/agents — switch agent",
            "/memory [agent] — memory notes",
            "/schedules — cron schedules",
            "/status — daemon and connection",
            "/whoami — your id and role",
            "/compact — compact this thread",
            "/abort — abort the current run",
            "/group — group settings · /bind &lt;id&gt; — owner",
            "/connect &lt;agent&gt; &lt;token&gt; — pair a bot from a token, no browser (owner)",
            "/stop — stop the current run and every queued message",
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
      case "stop":
        await this.stopEverything(handle, message);
        return;
      case "connect":
        await this.connectCommand(handle, message, argument, owner);
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
      case "thinking":
        await this.showThinking(handle, message, argument, owner);
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
            .filter((id): id is string => typeof id === "string");
          if (ids.length > 0) {
            await handle.api.sendMessage(
              message.chat.id,
              "Choose a model for this thread · " + provider + " · " + ids.length + " models",
              { threadId: message.message_thread_id, keyboard: modelKeyboard(provider, ids, 0) },
            );
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

  private async showThinking(handle: BotHandle, message: TgMessage, argument: string, owner: boolean): Promise<void> {
    const config = await readConfig({ fresh: true });
    const binding = getChat(this.state, handle.label, chatKey(message.chat.id, message.message_thread_id));
    const session = binding?.sessionId ? await findSession(binding.sessionId) : undefined;
    const agent = session?.agent ?? (await this.pairedAgent(handle.label))?.id;
    const current = (agent ? (await readAgent(agent))?.record.thinkingLevel : undefined) ?? config.defaults.thinkingLevel;

    if (!argument) {
      await handle.api.sendMessage(
        message.chat.id,
        "thinking " + current + (agent ? " \u00b7 " + agent : "") + "\ndefault " + config.defaults.thinkingLevel +
          "\nlevels " + THINKING_LEVELS.join(" ") +
          "\n\u2014 /thinking all &lt;level&gt; sets every agent",
        { threadId: message.message_thread_id },
      );
      return;
    }
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));

    const [first, second] = argument.split(/\s+/);
    const all = (first ?? "").toLowerCase() === "all";
    const level = all ? second : first;
    if (!isThinkingLevel(level)) {
      return void (await handle.api.sendMessage(
        message.chat.id,
        "Use one of: " + THINKING_LEVELS.join(", ") + " \u2014 /thinking all <level> for every agent.",
      ));
    }

    // The thread keeps its own record: an agent thread writes the agent (and rebinds its threads), a plain
    // thread configures itself. `all` is the global switch the owner asked for: one level, every model.
    const result = all || !binding?.sessionId
      ? await this.applyThinkingEverywhere(level)
      : await setSessionThinking(binding.sessionId, level);
    const where = all || !binding?.sessionId ? "all agents" : (result?.changed === "agent" ? "this agent" : "this thread");
    await handle.api.sendMessage(message.chat.id, "thinking \u2192 " + level + " \u00b7 " + where);
    log.info("telegram.thinking", { level, all });
  }

  /** One call to the core: it writes the config default and every agent record, then rebinds them. */
  private async applyThinkingEverywhere(level: ThinkingLevel): Promise<{ changed: "agent" } | null> {
    const result = await applyThinkingLevel(level);
    // Rebound so every open thread runs at the new effort at once, not after a restart.
    for (const id of result.agents) await rebindAgent(id);
    return { changed: "agent" };
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
    if (!binding?.sessionId) return void (await handle.api.sendMessage(message.chat.id, "No group bound here. Owner: /bind &lt;id&gt;"));
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
    await handle.api.sendMessage(message.chat.id, "Usage: /group [mode nyahut|moderator|silent | speaker &lt;label&gt;]");
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
        "No groups yet. Create one on the host: dura group create --title &lt;name&gt; --members a,b",
      );
      return;
    }
    const lines = rooms.slice(0, 15).map(
      (room) => "· " + escapeText(room.title) + " — id " + room.id + " · " + (room.room?.mode ?? "-") + " · " + (room.room?.members.join(", ") ?? ""),
    );
    await handle.api.sendMessage(
      message.chat.id,
      "<b>Groups</b>\n" + escapeHtml(lines.join("\n")) + "\n\nIn a group chat, the owner sends /bind &lt;id&gt; to attach it here.",
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

  private trackThinking(sessionId: string, messageId: number, chatId: number, threadId: number | undefined, label: string): void {
    const map = this.thinking.get(sessionId) ?? new Map();
    map.set(messageId, { chatId, label, ...(threadId ? { threadId } : {}) });
    this.thinking.set(sessionId, map);
  }

  private untrackThinking(sessionId: string, messageId: number): void {
    const map = this.thinking.get(sessionId);
    if (!map) return;
    map.delete(messageId);
    if (map.size === 0) this.thinking.delete(sessionId);
  }

  private async finishThinking(sessionId: string, text: string): Promise<void> {
    const map = this.thinking.get(sessionId);
    if (!map) return;
    this.thinking.delete(sessionId);
    for (const [messageId, entry] of map) {
      await this.apiFor(entry.label).editMessage(entry.chatId, messageId, text).catch(() => undefined);
    }
  }

  /* --------------------------- run bookkeeping --------------------------- */

  /**
   * Keep "typing…" alive for as long as a run lasts.
   *
   * The indicator is a client-side countdown of about five seconds, so this re-sends the action until the
   * returned stop function is called. A failed action is logged at debug and ignored: a chat that cannot
   * show the indicator must not fail the run behind it.
   */
  private startTyping(handle: BotHandle, chatId: number): () => void {
    let stopped = false;
    const beat = (): void => {
      if (stopped) return;
      void handle.api.sendChatAction(chatId, "typing").catch(() => undefined);
    };
    beat();
    const timer = setInterval(beat, TYPING_REFRESH_MS);
    timer.unref();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  /** Persist the promise to answer before waiting on it, so a crash cannot silently break it. */
  private async markPending(input: {
    label: string;
    sessionId: string;
    chatId: number;
    threadId?: number;
    placeholderId: number;
    before: number;
    agentId: string;
    submissionId: string;
  }): Promise<void> {
    const record: PendingDelivery = {
      sessionId: input.sessionId,
      chatId: input.chatId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      placeholderId: input.placeholderId,
      before: input.before,
      agentId: input.agentId,
      submissionId: input.submissionId,
      startedAt: Date.now(),
    };
    setPending(this.state, input.label, record);
    await this.persist();
  }

  private async clearPendingRecord(label: string, sessionId: string): Promise<void> {
    if (clearPending(this.state, label, sessionId)) await this.persist();
  }

  /**
   * Wait for a run to start, then for it to end.
   *
   * The conversation's own busy/idle signal is the only one used, because the submission is not trustworthy
   * here: a follow-up placed into a turn that ended through the question tool settles immediately with the
   * previous verdict, and trusting that reported "finished" for a run that had not begun — the answer was
   * then delivered as "(no answer)" while the turn was still working. So: wait until the thread is busy
   * (bounded, with an early exit when an answer has already landed), then wait for idle, in checkpoints so a
   * long run keeps its card honest instead of being abandoned.
   */
  private async awaitRunEnd(input: {
    sessionId: string;
    before: number;
    assumeStarted?: boolean;
    onCheckpoint?: (elapsedMs: number) => void;
  }): Promise<void> {
    if (!input.assumeStarted && !(await this.waitForStart(input.sessionId, input.before))) return;
    const started = Date.now();
    for (;;) {
      const conversation = await harnessInstance().conversation(Number(input.sessionId) as never, context);
      if (!conversation) return;
      const idle = conversation.waitForIdle(context).then(() => "idle" as const, () => "idle" as const);
      const slice = new Promise<"slice">((resolve) => {
        const timer = setTimeout(() => resolve("slice"), RUN_CHECKPOINT_MS);
        timer.unref();
      });
      const winner = await Promise.race([idle, slice]);
      if (winner === "idle") return;
      input.onCheckpoint?.(Date.now() - started);
    }
  }

  /**
   * Has the turn begun?
   *
   * A prompt is placed a moment before the run picks it up, so a single probe answers "idle" for work that
   * is about to start. Polls until the thread is busy, exits early once an answer is in the transcript, and
   * gives up after the grace window rather than blocking the delivery of whatever exists.
   */
  private async waitForStart(sessionId: string, before: number): Promise<boolean> {
    const deadline = Date.now() + RUN_START_GRACE_MS;
    for (;;) {
      if (await sessionBusy(sessionId)) return true;
      const entries = await transcript(sessionId);
      const fresh = entries.length >= before ? entries.slice(before) : entries;
      if (fresh.some((entry) => entry.role === "assistant" && entry.kind !== "chat.question" && entry.text.trim().length > 0)) return false;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  /** The fresh entries of a run: its question, its answer, and everything a delivery may attach. */
  private async readOutcome(sessionId: string, before: number): Promise<{ question?: WireMsg; answer?: WireMsg; fresh: WireMsg[] }> {
    const entries = await transcript(sessionId);
    // A compacted conversation can be shorter than the index written before the run started; then the whole
    // transcript is the candidate set rather than nothing at all.
    const fresh = entries.length >= before ? entries.slice(before) : entries;
    const question = [...fresh].reverse().find((entry) => entry.kind === "chat.question");
    const answer = [...fresh]
      .reverse()
      .find((entry) => entry.role === "assistant" && entry.kind !== "chat.question" && entry.text.trim().length > 0);
    return {
      ...(question ? { question } : {}),
      ...(answer ? { answer } : {}),
      fresh,
    };
  }

  /**
   * Send what the run produced, or say plainly that it produced nothing.
   *
   * Every path that starts work in a thread ends here, which is what makes "the result is always returned"
   * true rather than likely: the placeholder is edited, the answer is rendered, artifacts are attached, and
   * the bubble is never left on a status line that a later edit cannot reach.
   */
  private async deliverResult(input: {
    handle: BotHandle;
    chatId: number;
    threadId?: number;
    sessionId: string;
    placeholderId: number;
    before: number;
    agentId: string;
    startedAt?: number;
  }): Promise<void> {
    const { handle, chatId, threadId, sessionId, placeholderId } = input;
    const edit = async (html: string): Promise<void> => {
      await handle.api.editMessage(chatId, placeholderId, html).catch(() => undefined);
    };

    let outcome = await this.readOutcome(sessionId, input.before);
    // The commit of the last entry can trail the idle signal by a moment; asking the transcript twice beats
    // telling the owner "(no answer)" for an answer that is about to exist.
    const deadline = Date.now() + OUTCOME_GRACE_MS;
    while (!outcome.question && !outcome.answer && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      outcome = await this.readOutcome(sessionId, input.before);
    }
    const { question, answer, fresh } = outcome;

    const conversation = await harnessInstance().conversation(Number(sessionId) as never, context).catch(() => null);
    const conversationId = conversation?.id;

    if (question) {
      const data = (question.data ?? {}) as { options?: unknown };
      const options = Array.isArray(data.options) ? data.options.filter((value): value is string => typeof value === "string") : [];
      const keyboard = questionKeyboard(sessionId, options);
      const html = "<b>Question</b>\n\n" + markdownToHtml(question.text) + (keyboard ? "" : "\n\nType the answer.");
      // A question is sent, not edited in place. Telegram shows no notification for an edit, so a question
      // written over the status bubble was invisible to a phone that was not already looking at it — the
      // exact failure of "I cannot see the question". The placeholder then says what is being waited for.
      await edit("\u2753 waiting for your answer…");
      try {
        await handle.api.sendMessage(chatId, html, { threadId, ...(keyboard ? { keyboard } : {}) });
      } catch {
        await handle.api.sendMessage(chatId, html, { threadId });
      }
    } else if (answer) {
      let delivered = false;
      const rich = renderRichAnswer(answer);
      if (rich.length <= 30_000) {
        try {
          await handle.api.sendRichMessage(chatId, { markdown: rich }, { threadId });
          await handle.api.deleteMessage(chatId, placeholderId).catch(() => edit("Answered above."));
          delivered = true;
        } catch (error) {
          log.debug("telegram.rich_unavailable", { sessionId, ...errorFields(error) });
        }
      }
      if (!delivered) {
        const html = renderAnswer(answer);
        const chunks = splitMessage(html);
        await edit(chunks[0] ?? html);
        for (const chunk of chunks.slice(1)) await handle.api.sendMessage(chatId, chunk, { threadId });
      }
      await this.sendArtifacts(handle, chatId, threadId, fresh, conversationId);
    } else {
      // Nothing came back: the run was aborted, or it ended without saying anything. Either way the bubble
      // must reach a terminal state, because a card still claiming to work is the bug being fixed.
      await edit("stopped.");
      log.info("telegram.run_stopped", { sessionId });
    }

    log.info("telegram.conversation", {
      sessionId,
      agent: input.agentId,
      ms: Date.now() - (input.startedAt ?? Date.now()),
      entries: fresh.length,
      question: Boolean(question),
      answered: Boolean(answer),
    });
  }

  /**
   * Say what happened to the last process, in the chats that felt it.
   *
   * A restart used to be invisible from the chat: the status bubble simply stopped moving, which reads as a
   * hang, and the only trace was a journal line. The goodbye message sent on the way down is edited into the
   * outcome; when no goodbye survived (a crash, a kill, a stop from a shell) the chats with work in flight
   * still get told why their answer is late.
   */
  private async reportRestart(): Promise<void> {
    const boot = bootRestartNotice();
    // No brief but work in flight: the last process was killed before it could say goodbye. That is still a
    // restart the chats have to hear about, and the pending records are the proof it happened.
    const inFlight = [...this.handles.values()].some((handle) => pendingDeliveries(this.state, handle.label).length > 0);
    if (!boot && !inFlight) return;
    const seconds = boot ? Math.max(0, boot.downtimeMs) / 1000 : null;
    const span = seconds === null ? null : seconds < 1 ? "under a second" : Math.round(seconds) + "s";
    const cause = boot?.brief?.cause ?? "the service stopped unexpectedly";
    const head = span === null
      ? "\u26A0\uFE0F <b>Service came back</b> \u00b7 " + escapeHtml(cause)
      : "\u2705 <b>Back</b> after " + span + " \u00b7 " + escapeHtml(cause);
    let edited = 0;
    let fresh = 0;
    for (const handle of this.handles.values()) {
      const interrupted = pendingDeliveries(this.state, handle.label);
      const covered = new Set<string>();
      for (const [key, record] of boot ? restartNotices(this.state, handle.label) : []) {
        covered.add(key);
        const pendingHere = interrupted.filter((entry) => chatKey(entry.chatId, entry.threadId) === key).length;
        const html =
          head +
          (pendingHere
            ? "\n" + pendingHere + " interrupted run" + (pendingHere === 1 ? "" : "s") + " resuming."
            : "\nEverything is up again.");
        const ok = await handle.api
          .editMessage(record.chatId, record.messageId, html)
          .then(() => true)
          .catch((error) => {
            log.warn("telegram.restart_edit_failed", { label: handle.label, chatId: record.chatId, ...errorFields(error) });
            return false;
          });
        if (ok) edited += 1;
        clearRestartNotice(this.state, handle.label, key);
      }
      for (const pending of interrupted) {
        const key = chatKey(pending.chatId, pending.threadId);
        if (covered.has(key)) continue;
        covered.add(key);
        await handle.api
          .sendMessage(
            pending.chatId,
            head + "\nIts run resumes now.",
            { ...(pending.threadId === undefined ? {} : { threadId: pending.threadId }) },
          )
          .then(() => {
            fresh += 1;
          })
          .catch((error) => log.warn("telegram.restart_notice_failed", { label: handle.label, ...errorFields(error) }));
      }
    }
    await this.persist();
    log.info("telegram.restart_reported", { cause, downtimeMs: boot ? Math.round(boot.downtimeMs) : null, edited, fresh });
  }

  /**
   * Tell the chats that had work in flight that the process is going away.
   *
   * Sent from the stop hook, so the transport is still polling and the message arrives before the socket dies.
   * The message ids are persisted: the process that comes back edits these exact bubbles.
   */
  private async announceLeaving(brief: RestartBrief): Promise<void> {
    const head = brief.planned
      ? "\u{1F504} <b>Restarting</b> \u00b7 " + escapeHtml(brief.cause)
      : "\u{1F6D1} <b>Stopping</b> \u00b7 " + escapeHtml(brief.cause);
    const tail = brief.planned
      ? "Runs are durable; they resume when the service is back."
      : "Runs resume when the service is started again.";
    let sent = 0;
    for (const handle of this.handles.values()) {
      for (const target of this.restartTargets(handle.label, brief)) {
        const message = await handle.api
          .sendMessage(target.chatId, head + "\n" + tail, {
            ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
          })
          .catch((error) => {
            log.warn("telegram.restart_notice_failed", { label: handle.label, chatId: target.chatId, ...errorFields(error) });
            return null;
          });
        if (!message) continue;
        sent += 1;
        setRestartNotice(this.state, handle.label, target.key, {
          chatId: target.chatId,
          ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
          messageId: message.message_id,
          at: Date.now(),
          cause: brief.cause,
        });
      }
    }
    await this.persist();
    log.info("telegram.restart_announced", { cause: brief.cause, planned: brief.planned, sent });
  }

  /** Every chat of this bot that should hear it: a run in flight, or the thread that asked for the restart. */
  private restartTargets(label: string, brief: RestartBrief): { key: string; chatId: number; threadId?: number }[] {
    const targets = new Map<string, { key: string; chatId: number; threadId?: number }>();
    for (const pending of pendingDeliveries(this.state, label)) {
      const key = chatKey(pending.chatId, pending.threadId);
      targets.set(key, {
        key,
        chatId: pending.chatId,
        ...(pending.threadId === undefined ? {} : { threadId: pending.threadId }),
      });
    }
    if (!brief.sessionId) return [...targets.values()];
    for (const [key, binding] of Object.entries(stateFor(this.state, label).chats)) {
      if (binding.sessionId !== brief.sessionId) continue;
      const [chat, topic] = key.split(":");
      const chatId = Number(chat);
      if (!Number.isSafeInteger(chatId) || chatId === 0) continue;
      const topicId = topic === undefined ? undefined : Number(topic);
      targets.set(key, { key, chatId, ...(topicId === undefined ? {} : { threadId: topicId }) });
    }
    return [...targets.values()];
  }

  /**
   * Pick up the runs that the previous process did not finish delivering.
   *
   * boot() calls resume(), which reschedules the durable work; what it cannot do is speak for the transport.
   * Every pending delivery recorded before the restart is re-attached here, so an interrupted turn ends the
   * same way a normal one does — with its answer in the chat.
   */
  private recoverDeliveries(): void {
    for (const [label, handle] of this.handles) {
      for (const pending of pendingDeliveries(this.state, label)) {
        void this.resumeDelivery(handle, pending).catch((error) => {
          log.warn("telegram.recovery_failed", { label, sessionId: pending.sessionId, ...errorFields(error) });
        });
      }
    }
  }

  private async resumeDelivery(handle: BotHandle, pending: PendingDelivery): Promise<void> {
    const conversation = await harnessInstance()
      .conversation(Number(pending.sessionId) as never, context)
      .catch(() => null);
    if (!conversation) {
      await this.clearPendingRecord(handle.label, pending.sessionId);
      return;
    }
    log.info("telegram.recovery", { sessionId: pending.sessionId, bot: handle.label, before: pending.before });
    const stopTyping = this.startTyping(handle, pending.chatId);
    try {
      // The run was busy when this process found it, so the start gate is already satisfied.
      if (await sessionBusy(pending.sessionId)) {
        await this.awaitRunEnd({ sessionId: pending.sessionId, before: pending.before, assumeStarted: true });
      }
    } finally {
      stopTyping();
    }
    await this.deliverResult({
      handle,
      chatId: pending.chatId,
      ...(pending.threadId === undefined ? {} : { threadId: pending.threadId }),
      sessionId: pending.sessionId,
      placeholderId: pending.placeholderId,
      before: pending.before,
      agentId: pending.agentId,
      startedAt: pending.startedAt,
    });
    await this.clearPendingRecord(handle.label, pending.sessionId);
    log.info("telegram.recovered", { sessionId: pending.sessionId, bot: handle.label });
  }

  /**
   * Put a message into a thread and follow it all the way to an answer.
   *
   * Every entry point shares this: a typed prompt, a question answered from a button, a scheduled prompt.
   * Sending without it is how a turn runs with no status bubble, no typing and nobody to deliver the answer —
   * the bug where answering a question looked stuck and then said nothing.
   */
  private async routeText(input: {
    handle: BotHandle;
    chatId: number;
    threadId?: number;
    sessionId: string;
    agentId: string;
    text: string;
    requestId: string;
    attachments?: AttachmentDraft[];
    replyTo?: number;
  }): Promise<void> {
    const { handle, chatId, threadId, sessionId } = input;
    const attachments = input.attachments ?? [];
    const session = await findSession(sessionId);
    if (!session) {
      await handle.api.sendMessage(chatId, "That thread is gone.", { threadId });
      return;
    }

    const busyProbe = activeIds().includes(sessionId) || (await sessionBusy(sessionId));
    log.debug("telegram.route", { sessionId, busy: busyProbe, requestId: input.requestId });
    if (busyProbe) {
      try {
        const submission = await sendMessage(
          sessionId,
          { text: input.text, ...(attachments.length > 0 ? { attachments } : {}), requestId: input.requestId },
          "steer",
        );
        if (!submission) throw new Error("the thread disappeared");
        await handle.api.sendMessage(chatId, "Steer · added to the current run", {
          ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
          threadId,
        });
        log.info("telegram.steer", { sessionId, submission: submission.submissionId });
      } catch (error) {
        await handle.api.sendMessage(chatId, "Steer failed: " + escapeText(error instanceof Error ? error.message : String(error)), { threadId });
      }
      return;
    }

    const placeholder = await handle.api.sendMessage(chatId, "Think · planning the next step", {
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      threadId,
    });
    rememberMessage(this.state, handle.label, chatId, placeholder.message_id, sessionId);
    this.trackThinking(sessionId, placeholder.message_id, chatId, threadId, handle.label);
    try {
      const submission = await sendMessage(
        sessionId,
        { text: input.text, ...(attachments.length > 0 ? { attachments } : {}), requestId: input.requestId },
        "followUp",
      );
      if (!submission) throw new Error("the thread disappeared");
      void this.runSession({
        handle,
        chatId,
        threadId,
        sessionId,
        placeholderId: placeholder.message_id,
        agentId: session.agent ?? input.agentId ?? "agent",
        submissionId: submission.submissionId,
      });
    } catch (error) {
      this.untrackThinking(sessionId, placeholder.message_id);
      await handle.api
        .editMessage(chatId, placeholder.message_id, "⚠️ " + escapeText(error instanceof Error ? error.message : String(error)))
        .catch(() => undefined);
    }
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
          "dura agent create --name &lt;name&gt; --bot " + handle.label,
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

    await this.routeText({
      handle,
      chatId: message.chat.id,
      ...(message.message_thread_id === undefined ? {} : { threadId: message.message_thread_id }),
      sessionId,
      agentId: paired.id,
      text,
      attachments,
      requestId: "tg:" + handle.label + ":" + message.chat.id + ":" + message.message_id,
      replyTo: message.message_id,
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
        "\n\nDeleting is recoverable (dura thread restore &lt;id&gt;). Purge is CLI-only.",
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
        await handle.api.sendMessage(message.chat.id, "Usage: /mcp add &lt;name&gt; &lt;command&gt; [args…]");
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
      if (!name) return void (await handle.api.sendMessage(message.chat.id, "Usage: /mcp remove &lt;name&gt;"));
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
        "No MCP servers. Add one from the host: dura mcp add &lt;name&gt; -- &lt;command&gt;\n" +
          "or from here: /mcp add &lt;name&gt; &lt;command&gt; [args…]\nMCP tools become available to every agent.",
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
        "\n\n/mcp add &lt;name&gt; &lt;command&gt; [args…] · /mcp remove &lt;name&gt; · /mcp reload",
    );
  }

  /** Add a bot from a token and start its poller. The token never reaches the model. */
  private async connectBotToken(input: { token: string; label?: string }): Promise<{ label: string; username: string }> {
    const token = input.token.trim();
    if (!token.includes(":")) throw new Error("that does not look like a bot token");
    const existing = this.registry.bots.find((bot) => bot.token === token);
    if (existing) {
      await this.startBot(existing.label);
      return { label: existing.label, username: existing.username };
    }
    const config = await readConfig();
    const api = new BotApi({ token, apiBase: config.telegram.apiBase });
    const me = await api.getMe();
    if (!me.username) throw new Error("the bot has no username");
    const fallback = me.username.replace(/_?bot$/i, "").replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase().slice(0, 32) || "bot";
    const label = (input.label ?? fallback).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(label)) throw new Error("label must be lower-case letters, digits and dashes");
    if (botByLabel(this.registry, label)) throw new Error("a bot labelled " + label + " already exists");
    this.registry = await addBot({ label, token, botId: String(me.id), username: me.username });
    await this.startBot(label);
    void this.notifyOwner("Bot @" + me.username + " (" + label + ") is connected and ready. One bot is one agent.");
    return { label, username: me.username };
  }

  private async connectCommand(handle: BotHandle, message: TgMessage, argument: string, owner: boolean): Promise<void> {
    if (!owner) return void (await handle.api.sendMessage(message.chat.id, "Owner only."));
    const [agentId, token] = argument.split(/\s+/).filter(Boolean);
    if (!agentId || !token) {
      await handle.api.sendMessage(
        message.chat.id,
        "Usage: /connect &lt;agent-id&gt; &lt;bot-token&gt;\nThe token is used once, the message is deleted, and the bot is paired. No browser opens.",
      );
      return;
    }
    // Remove the token from chat as soon as it has been read.
    const removed = await handle.api.deleteMessage(message.chat.id, message.message_id).then(() => true).catch(() => false);
    try {
      const bot = await this.connectBotToken({ token });
      const result = await assignBotToAgent(bot.label, agentId, "telegram");
      await handle.api.sendMessage(
        message.chat.id,
        "Connected @" + escapeText(bot.username) + " to " + escapeText(agentId) +
          (result.freed.length ? " · unpaired " + escapeText(result.freed.join(", ")) : "") +
          (removed ? " · token message deleted" : " · delete the token message manually"),
      );
      log.info("telegram.bot_connected", { label: bot.label, agentId, freed: result.freed });
    } catch (error) {
      await handle.api.sendMessage(message.chat.id, escapeText(error instanceof Error ? error.message : String(error)));
    }
  }

  private async stopEverything(handle: BotHandle, message: TgMessage): Promise<void> {
    const paired = await this.pairedAgent(handle.label);
    const binding = getChat(this.state, handle.label, chatKey(message.chat.id, message.message_thread_id));
    const active = new Set(activeIds());
    const { listSessions } = await import("../../core/src/sessions.ts");
    const sessions = await listSessions();
    const targets = new Set<string>();
    if (binding?.sessionId) targets.add(binding.sessionId);
    for (const session of sessions) {
      if (paired && session.agent === paired.id && active.has(session.id)) targets.add(session.id);
    }
    // Anything still showing a thinking card in this chat is part of the stop.
    for (const [sessionId, cards] of this.thinking) {
      if ([...cards.values()].some((card) => card.chatId === message.chat.id)) targets.add(sessionId);
    }

    let stopped = 0;
    for (const sessionId of targets) {
      const ok = await abortSession(sessionId).catch(() => false);
      if (ok) stopped += 1;
      await this.finishThinking(sessionId, "stopped.");
    }
    if (binding?.sessionId && (await isRoom(binding.sessionId))) {
      const { abortRoom } = await import("../../core/src/rooms.ts");
      await abortRoom(binding.sessionId).catch(() => undefined);
      await this.finishThinking(binding.sessionId, "stopped.");
    }
    await handle.api.sendMessage(
      message.chat.id,
      stopped > 0
        ? "Stopped " + stopped + " run(s). Queued messages were withdrawn."
        : "Nothing is running here. Every pending thinking card was cleared.",
      { threadId: message.message_thread_id },
    );
    log.info("telegram.stop", { chatId: message.chat.id, sessions: [...targets], stopped });
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
    submissionId: string;
  }): Promise<void> {
    const { handle, chatId, threadId, sessionId, placeholderId } = input;
    const started = Date.now();
    const edit = async (html: string): Promise<void> => {
      await handle.api.editMessage(chatId, placeholderId, html).catch(() => undefined);
    };

    let stopStream: (() => Promise<void>) | undefined;
    const seenCalls = new Set<string>();
    // The status message is edited, never sent: one placeholder carrying the thought and the last calls.
    const lines: string[] = [];
    let thinking = "";
    let phase: string | null = null;
    let lastStatusAt = 0;
    let statusTimer: ReturnType<typeof setTimeout> | undefined;

    const paintStatus = (force: boolean): void => {
      const now = Date.now();
      const html = liveStatus({ thinking, phase, lines });
      const wait = STATUS_EDIT_MS - (now - lastStatusAt);
      if (!force && wait > 0) {
        // Telegram rate-limits edits per message; coalescing keeps the newest state instead of a burst.
        statusTimer ??= setTimeout(() => {
          statusTimer = undefined;
          paintStatus(false);
        }, wait);
        return;
      }
      lastStatusAt = now;
      void edit(html);
    };

    const before = (await transcript(sessionId)).length;
    // Written before the wait begins: if this process dies now, boot recovery still knows which bubble owes
    // an answer, and the answer arrives after the restart instead of never.
    await this.markPending({
      label: handle.label,
      sessionId,
      chatId,
      ...(threadId === undefined ? {} : { threadId }),
      placeholderId,
      before,
      agentId: input.agentId,
      submissionId: input.submissionId,
    });
    // Typing for the whole run, not a five-second flicker: the indicator is what tells the owner the bot is
    // still working while the status bubble is being rate-limited.
    const stopTyping = this.startTyping(handle, chatId);

    try {
      const conversation = await harnessInstance().conversation(Number(sessionId) as never, context);
      if (conversation) {
        const stream = await openEventStream(harnessInstance(), conversation.id, context, (frame) => {
          if (frame.type !== "activity") return;
          const activity = frame.activity;
          thinking = activity.thinking ?? "";
          phase = activity.phase;
          for (const call of activity.calls) {
            if (seenCalls.has(call.callId)) continue;
            seenCalls.add(call.callId);
            if (call.status === "done") continue;
            lines.push(progressLine(call.name, call.summary));
            if (lines.length > 3) lines.shift();
          }
          paintStatus(false);
        });
        stopStream = stream.stop;
      }
    } catch (error) {
      log.debug("telegram.stream_unavailable", { sessionId, ...errorFields(error) });
    }

    try {
      await this.awaitRunEnd({
        sessionId,
        before,
        // A long run keeps its card honest instead of leaving an edit ten minutes old on screen.
        onCheckpoint: (elapsedMs) => {
          lines.push("still running · " + age(elapsedMs));
          if (lines.length > 3) lines.shift();
          paintStatus(true);
        },
      });
    } finally {
      stopTyping();
      await stopStream?.().catch(() => undefined);
      // A coalesced status edit still pending would land after the answer and wipe it.
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = undefined;
      }
    }
    this.untrackThinking(sessionId, placeholderId);

    // Delivery owns the bubble now. A failure here leaves the pending record in place, so the next boot
    // finishes the job rather than the chat waiting forever for an answer that already exists — and it must
    // not escape: a stop that closes the harness mid-delivery threw "Session is closed" out of this await
    // as an unhandled rejection and took the whole daemon down with exit 1, losing every other bot with it.
    try {
      await this.deliverResult({
        handle,
        chatId,
        ...(threadId === undefined ? {} : { threadId }),
        sessionId,
        placeholderId,
        before,
        agentId: input.agentId,
        startedAt: started,
      });
    } catch (error) {
      log.warn("telegram.deliver_failed", { sessionId, label: handle.label, ...errorFields(error) });
      return;
    }
    await this.clearPendingRecord(handle.label, sessionId);
  }

  private async sendArtifacts(
    handle: BotHandle,
    chatId: number,
    threadId: number | undefined,
    entries: WireMsg[],
    conversationId: number | undefined,
  ): Promise<void> {
    if (conversationId === undefined) return;
    for (const entry of entries) {
      for (const artifact of entry.artifacts ?? []) {
        // readArtifact(conversationId, artifactId): the entry id is NOT the conversation id,
        // and passing it looked in a directory that never exists, so every file was dropped
        // without a word. Fail loudly instead.
        const bytes = await readArtifact(String(conversationId), artifact.id);
        if (!bytes) {
          log.warn("telegram.artifact_missing", { artifact: artifact.name, conversationId });
          continue;
        }
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
    // A room run can take minutes: the indicator has to be refreshed, not sent once.
    const stopTyping = this.startTyping(handle, message.chat.id);
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
      stopTyping();
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
      await handle.api.editMessage(chatId, message.message_id, "<i>answer: " + escapeText(answer) + "</i>").catch(() => undefined);
      // The answer is a prompt like any other: it must open a status bubble, show typing and deliver the
      // next answer. Sending it bare left the turn running with nobody watching it, which looked stuck.
      await this.routeText({
        handle,
        chatId,
        ...(message.message_thread_id === undefined ? {} : { threadId: message.message_thread_id }),
        sessionId: sessionId ?? "",
        agentId: session.agent ?? "agent",
        text: answer,
        requestId: "tg:answer:" + query.id,
      });
      log.info("telegram.question_answered", { sessionId, option: Number(index) });
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

    if (data.startsWith("smp:")) {
      if (!owner) return void (await handle.api.sendMessage(chatId, "Owner only."));
      const payload = data.slice(4);
      const split = payload.lastIndexOf(":");
      if (split <= 0) return;
      const provider = payload.slice(0, split);
      const page = Number.parseInt(payload.slice(split + 1), 10) || 0;
      const available = await models.getAvailable(provider);
      const ids = available
        .map((model) => (model as { id?: unknown }).id)
        .filter((id): id is string => typeof id === "string");
      await handle.api
        .editMessage(
          chatId,
          message.message_id,
          "Choose a model for this thread · " + escapeText(provider) + " · " + ids.length + " models",
          modelKeyboard(provider, ids, page),
        )
        .catch(() => undefined);
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
      const binding = getChat(this.state, handle.label, key);
      setTimeout(() => {
        try {
          startOperation("restart", {
            cause: "/restart",
            ...(binding?.sessionId ? { sessionId: binding.sessionId } : {}),
            ...(binding?.agentId ? { agentId: binding.agentId } : {}),
          });
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
