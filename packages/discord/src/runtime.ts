import { randomUUID } from "node:crypto";
import { context, harnessInstance, installExtensions } from "../../core/src/harness.ts";
import { activeIds } from "../../core/src/activity.ts";
import { applyThinkingLevel, isThinkingLevel, listAgents, readAgent, readMemory, THINKING_LEVELS } from "../../core/src/agents.ts";
import { readConfig, updateConfig } from "../../core/src/config.ts";
import { models } from "../../core/src/models.ts";
import { reloadEverything } from "../../core/src/reload.ts";
import { startOperation } from "../../core/src/system.ts";
import { errorFields, log } from "../../core/src/logger.ts";
import { orchestratorId, setOrchestrator, subscribeOrchestrator } from "../../core/src/orchestrator.ts";
import { approveSudoRequest, denySudoRequest } from "../../core/src/sudo.ts";
import { assignBotToAgent, releaseBot, setBotConnector, setBotResolver, subscribeAdmin } from "../../core/src/agent-admin.ts";
import { subscribeDocChanges } from "../../core/src/doc-store.ts";
import {
  abortSession,
  compactSession,
  createSession,
  findSession,
  listSessions,
  moveSession,
  renameSession,
  sendMessage,
  sessionBusy,
  setSessionModel,
  setSessionThinking,
  transcript,
  updateSessionRecord,
} from "../../core/src/sessions.ts";
import { pruneSessions } from "../../core/src/sessions.ts";
import { usageReport } from "../../core/src/usage.ts";
import { openEventStream } from "../../core/src/stream.ts";
import type { WireFrame, WireMsg } from "../../core/src/wire.ts";
import { readArtifact } from "../../core/src/artifacts.ts";
import type { Check } from "../../core/src/verify.ts";
import type { AttachmentDraft } from "../../core/src/attachments.ts";
import { createDiscordToolsExtension } from "../../core/src/discord-tool.ts";
import { DiscordApi } from "./client.ts";
import { DISCORD_INTENTS, DiscordGateway, type GatewayEvent } from "./gateway.ts";
import {
  addDiscordBot,
  defaultDiscordBot,
  discordBotByLabel,
  loadDiscordRegistry,
  publicDiscordRegistry,
  removeDiscordBot,
  setDefaultDiscordBot,
  setDiscordBotDefaultAgent,
  setDiscordBotEnabled,
  updateDiscordBotIdentity,
  type DiscordBotRecord,
  type DiscordRegistry,
} from "./registry.ts";
import {
  loadDiscordUsers,
  discordRoleOf,
  noteDiscordPending,
  approveDiscordPending,
  denyDiscordPending,
  type DiscordUsers,
} from "./users.ts";
import {
  discordBindingKey,
  getDiscordBinding,
  loadDiscordState,
  rememberDiscordMessage,
  saveDiscordState,
  setDiscordBinding,
  setDiscordHealth,
  deleteDiscordBinding,
  type DiscordBinding,
  type DiscordState,
} from "./state.ts";
import { moderate, warningsFor, type ModerationInput } from "./moderation.ts";
import { buttonRow, progressLine, questionComponents, splitDiscordMessage, toDiscordMarkdown } from "./render.ts";
import { downloadDiscordAttachments } from "./media.ts";
import { syncDiscordCommands } from "./command-catalog.ts";
import type { DiscordAttachment, DiscordChannel, DiscordInteraction, DiscordMessage, DiscordUser, ReadyData } from "./types.ts";

type BotHandle = {
  bot: DiscordBotRecord;
  api: DiscordApi;
  gateway: DiscordGateway;
  guilds: number;
};

type PendingQuestion = {
  sessionId: string;
  channelId: string;
  options: string[];
  expiresAt: number;
  approval?: { kind: "sudo"; digest: string; action?: string };
};
type PendingConfirmation = { input: ModerationInput; expiresAt: number };
type CommandContext = {
  bot: BotHandle;
  channelId: string;
  guildId?: string;
  userId: string;
  username: string;
  isOwner: boolean;
  interaction?: DiscordInteraction;
  message?: DiscordMessage;
  channel?: DiscordChannel;
  replied?: boolean;
};

const QUESTION_TTL_MS = 15 * 60_000;
const CONFIRM_TTL_MS = 5 * 60_000;
const SEEN_LIMIT = 2000;

function phaseLabel(phase: string | null): string {
  if (phase === "thinking") return "🧠 thinking…";
  if (phase === "writing") return "✍️ writing…";
  if (phase === "compacting") return "🗜️ compacting…";
  if (phase === "retrying") return "🔁 retrying…";
  if (phase === "tool") return "⚙️ working…";
  return "starting…";
}

function statusText(input: { phase: string | null; thinking?: string; lines: string[] }): string {
  const head = input.thinking ? "🧠 " + input.thinking : phaseLabel(input.phase);
  return [head, ...input.lines.slice(-3).map((line) => "⚙️ " + line)].filter(Boolean).join("\n").slice(0, 1900);
}

function cleanContent(value: string): string {
  return value.replace(/<@!?\d+>/g, "").replace(/\s+/g, " ").trim();
}

function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.round(seconds / 60) + "m";
  if (seconds < 86_400) return Math.round(seconds / 3600) + "h";
  return Math.round(seconds / 86_400) + "d";
}

function permissionInteger(): string {
  const bits: bigint[] = [1n << 10n, 1n << 11n, 1n << 38n, 1n << 35n, 1n << 34n, 1n << 16n, 1n << 15n, 1n << 14n, 1n << 6n, 1n << 13n, 1n << 40n, 1n << 1n, 1n << 2n, 1n << 7n];
  return bits.reduce((sum, bit) => sum | bit, 0n).toString();
}

function inviteUrl(applicationId: string): string {
  return "https://discord.com/oauth2/authorize?client_id=" + applicationId + "&permissions=" + permissionInteger() + "&scope=bot%20applications.commands";
}

function helpText(): string {
  return [
    "**dura-agents on Discord**",
    "Talk to the bot in a DM, or use /new in a server channel to create a thread for one durable session.",
    "A thread is one conversation; /threads lists them, /agent moves one, /archive closes the Discord thread.",
    "",
    "**Threads:** /new, /threads, /rename, /archive, /agent, /bind, /unbind",
    "**Run:** /stop, /abort, /compact, /plan, /model, /thinking, /usage",
    "**Data:** /agents, /memory, /status, /whoami",
    "**Owner:** /bots, /orchestrator, /settings, /prune, /reload, /restart, /approve, /mod",
    "",
    "Text fallbacks: !help, !new, !stop, !status, !threads.",
  ].join("\n");
}

export class DiscordRuntime {
  private registry!: DiscordRegistry;
  private users!: DiscordUsers;
  private state!: DiscordState;
  private readonly handles = new Map<string, BotHandle>();
  private readonly seen = new Map<string, number>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly confirmations = new Map<string, PendingConfirmation>();
  private readonly channelCache = new Map<string, { channel: DiscordChannel; at: number }>();
  private readonly unknownNotified = new Map<string, number>();
  private stopping = false;
  private stateQueue: Promise<void> = Promise.resolve();
  private readonly unsubscribers: (() => void)[] = [];

  async start(): Promise<void> {
    this.registry = await loadDiscordRegistry();
    this.users = await loadDiscordUsers();
    this.state = await loadDiscordState();

    setBotResolver({
      platform: "discord",
      perAgent: false,
      validate: async (label) => this.registry.bots.some((bot) => bot.label === label),
      list: async () => this.registry.bots.map((bot) => bot.label),
      holder: async (label) => discordBotByLabel(this.registry, label)?.defaultAgent,
      bind: async (label, agentId) => {
        this.registry = await setDiscordBotDefaultAgent(label, agentId);
        return { freed: [] };
      },
      release: async (label) => {
        const previous = discordBotByLabel(this.registry, label)?.defaultAgent;
        this.registry = await setDiscordBotDefaultAgent(label, null);
        return previous ? [previous] : [];
      },
    });
    setBotConnector((input) => this.connectBotToken(input));

    if ((await readConfig({ fresh: true })).discord.agentTools) {
      installExtensions([createDiscordToolsExtension(this.toolBridge())]);
    }

    this.unsubscribers.push(
      subscribeDocChanges((event) => {
        void this.notifyOwner("✍️ " + event.agentId + " " + (event.doc === "agent" ? "AGENT.md" : "SOUL.md") + " updated by " + event.caller + " · " + event.sha256.slice(0, 8));
      }),
      subscribeAdmin((event) => {
        if (event.kind === "doc") return;
        const verb = event.kind === "create" ? "created" : event.kind === "delete" ? "deleted" : "updated";
        void this.notifyOwner("🧩 agent " + event.agentId + " " + verb + " by " + event.caller);
      }),
      subscribeOrchestrator((event) => {
        if (event.kind === "requested") {
          void this.notifyOwner("🔑 " + event.agentId + " asks to become the orchestrator (current: " + (event.current ?? "none") + ").", [
            buttonRow([
              { text: "Approve", data: "oc:" + event.agentId, style: 3 },
              { text: "Deny", data: "ocno:" + event.agentId, style: 4 },
            ]),
          ]);
        } else if (event.kind === "claimed") {
          void this.notifyOwner("🔑 " + event.agentId + " is now the orchestrator.");
        }
      }),
    );

    for (const bot of this.registry.bots.filter((entry) => entry.enabled)) {
      await this.startBot(bot.label).catch((error) => log.error("discord.bot_start_failed", { label: bot.label, ...errorFields(error) }));
    }
    log.info("discord.started", { bots: [...this.handles.keys()] });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const handle of this.handles.values()) await handle.gateway.stop().catch(() => undefined);
    this.handles.clear();
    await this.persist();
  }

  private async persist(): Promise<void> {
    this.stateQueue = this.stateQueue.then(() => saveDiscordState(this.state)).catch(() => undefined);
    await this.stateQueue;
  }

  private async startBot(label: string): Promise<void> {
    const bot = discordBotByLabel(this.registry, label);
    if (!bot) throw new Error("unknown Discord bot: " + label);
    if (this.handles.has(label)) return;
    const config = await readConfig();
    const api = new DiscordApi({ token: bot.token, apiBase: config.discord.apiBase, label });
    let me: DiscordUser;
    try {
      me = await api.getMe();
    } catch (error) {
      await this.markHealth(label, false, "stopped", error instanceof Error ? error.message : String(error));
      log.error("discord.identity_failed", { label, ...errorFields(error) });
      return;
    }
    let applicationId = bot.applicationId;
    try {
      applicationId = (await api.getApplication()).id;
    } catch {
      /* bot user id is the application id for normal bots */
    }
    if (applicationId !== bot.applicationId || me.username !== bot.username || me.id !== bot.botId) {
      this.registry = await updateDiscordBotIdentity(label, { applicationId, botId: me.id, username: me.username });
    }
    const gateway = new DiscordGateway({
      token: bot.token,
      gatewayUrl: config.discord.gatewayUrl,
      intents: DISCORD_INTENTS,
      onEvent: (event) => this.onGatewayEvent(label, event),
      onReady: (data) => this.onReady(label, api, data),
      onFatal: (message) => this.onFatal(label, message),
      onHealth: (health) => this.markHealth(label, health.ok, health.state, health.error),
    });
    const handle: BotHandle = { bot: { ...bot, applicationId, botId: me.id, username: me.username }, api, gateway, guilds: 0 };
    this.handles.set(label, handle);
    await this.markHealth(label, false, "connecting");
    void gateway.start(20_000).catch((error) => log.warn("discord.gateway_start_failed", { label, ...errorFields(error) }));
  }

  private async markHealth(label: string, ok: boolean, state: "stopped" | "connecting" | "ready", error?: string): Promise<void> {
    const current = this.state.bots[label]?.health;
    if (current && current.ok === ok && current.state === state && current.lastError === error) return;
    const username = discordBotByLabel(this.registry, label)?.username;
    await setDiscordHealth(this.state, label, {
      ok,
      checkedAt: Date.now(),
      state,
      ...(username ? { username } : {}),
      ...(error ? { lastError: error } : {}),
    });
  }

  private async onReady(label: string, api: DiscordApi, data: ReadyData): Promise<void> {
    const handle = this.handles.get(label);
    if (handle) handle.guilds = data.guilds?.length ?? 0;
    const applicationId = data.application?.id ?? handle?.bot.applicationId ?? "";
    if (applicationId) await syncDiscordCommands(api, applicationId).catch((error) => log.warn("discord.commands_failed", { label, ...errorFields(error) }));
    await this.markHealth(label, true, "ready");
    log.info("discord.ready", { label, user: data.user?.username, guilds: handle?.guilds ?? 0 });
  }

  private async onFatal(label: string, message: string): Promise<void> {
    await this.markHealth(label, false, "stopped", message);
    await this.notifyOwner("⚠️ Discord bot " + label + ": " + message);
    log.error("discord.fatal", { label, message });
  }

  private async onGatewayEvent(label: string, event: GatewayEvent): Promise<void> {
    const handle = this.handles.get(label);
    if (!handle || this.stopping) return;
    if (event.type === "MESSAGE_CREATE") {
      await this.handleMessage(handle, event.data as DiscordMessage).catch((error) => log.error("discord.message_failed", { label, ...errorFields(error) }));
    } else if (event.type === "INTERACTION_CREATE") {
      await this.handleInteraction(handle, event.data as DiscordInteraction).catch((error) => log.error("discord.interaction_failed", { label, ...errorFields(error) }));
    }
  }

  private async channelOf(api: DiscordApi, channelId: string): Promise<DiscordChannel> {
    const cached = this.channelCache.get(channelId);
    if (cached && Date.now() - cached.at < 300_000) return cached.channel;
    try {
      const channel = await api.getChannel(channelId);
      this.channelCache.set(channelId, { channel, at: Date.now() });
      return channel;
    } catch {
      const synthetic: DiscordChannel = { id: channelId, type: 0 };
      this.channelCache.set(channelId, { channel: synthetic, at: Date.now() });
      return synthetic;
    }
  }

  private isThread(channel: DiscordChannel): boolean {
    return channel.type === 10 || channel.type === 11 || channel.type === 12;
  }

  private async handleMessage(handle: BotHandle, message: DiscordMessage): Promise<void> {
    if (!message?.author || message.author.bot || message.webhook_id) return;
    if (this.seen.has(message.id)) return;
    this.seen.set(message.id, Date.now());
    if (this.seen.size > SEEN_LIMIT) {
      const cutoff = Date.now() - 86_400_000;
      for (const [id, at] of this.seen) if (at < cutoff) this.seen.delete(id);
    }
    const userId = message.author.id;
    const role = discordRoleOf(this.users, userId);
    if (!role) return void (await this.refuseUnknown(handle, message));
    const channel = await this.channelOf(handle.api, message.channel_id);
    const dm = !message.guild_id;
    const text = cleanContent(message.content ?? "");
    const mentioned = Boolean(message.mentions?.some((user) => user.id === handle.bot.botId));
    if (!text && message.attachments.length === 0) return;

    if (text.startsWith("!")) {
      const ctx: CommandContext = {
        bot: handle,
        channelId: message.channel_id,
        ...(message.guild_id ? { guildId: message.guild_id } : {}),
        userId,
        username: message.author.username,
        isOwner: role === "owner",
        message,
        channel,
      };
      return void (await this.handleTextCommand(ctx, text.slice(1)));
    }

    if (dm) {
      const key = discordBindingKey({ channelId: message.channel_id, userId, dm: true });
      const result = await this.ensureSession(handle, key, { kind: "dm", channelId: message.channel_id }, text, channel);
      return void (await this.deliverPrompt(handle, message.channel_id, result.sessionId, text, message.attachments, message.id, result.agentId));
    }

    const config = await readConfig({ fresh: true });
    if (!config.discord.allowGuilds) return;
    const key = this.isThread(channel) ? "thread:" + message.channel_id : "channel:" + message.channel_id;
    let binding = await getDiscordBinding(this.state, handle.bot.label, key);
    if (!binding && this.isThread(channel) && channel.parent_id) {
      binding = await getDiscordBinding(this.state, handle.bot.label, "channel:" + channel.parent_id);
      if (binding) {
        binding = { ...binding, kind: "thread", channelId: message.channel_id, threadId: message.channel_id, parentId: channel.parent_id };
        await setDiscordBinding(this.state, handle.bot.label, key, binding);
      }
    }
    if (binding) {
      if (binding.speakerBot && binding.speakerBot !== handle.bot.label) return;
      if (channel.thread_metadata?.archived) {
        await handle.api.editThread(message.channel_id, { archived: false }).catch(() => undefined);
      }
      const result = await this.ensureSession(handle, key, binding, text, channel);
      return void (await this.deliverPrompt(handle, message.channel_id, result.sessionId, text, message.attachments, message.id, result.agentId));
    }
    if (mentioned) {
      if (this.isThread(channel)) {
        const result = await this.ensureSession(
          handle,
          key,
          {
            kind: "thread",
            channelId: message.channel_id,
            threadId: message.channel_id,
            speakerBot: handle.bot.label,
            ...(channel.parent_id ? { parentId: channel.parent_id } : {}),
            ...(message.guild_id ? { guildId: message.guild_id } : {}),
          },
          text || "Discord thread",
          channel,
        );
        return void (await this.deliverPrompt(handle, message.channel_id, result.sessionId, text, message.attachments, message.id, result.agentId));
      }
      const thread = await handle.api.createThreadFromMessage(message.channel_id, message.id, { name: (text || "Discord thread").slice(0, 90) });
      await handle.api.joinThread(thread.id).catch(() => undefined);
      const result = await this.ensureSession(
        handle,
        "thread:" + thread.id,
        {
          kind: "thread",
          channelId: thread.id,
          threadId: thread.id,
          parentId: message.channel_id,
          speakerBot: handle.bot.label,
          ...(message.guild_id ? { guildId: message.guild_id } : {}),
        },
        text || "Discord thread",
        thread,
      );
      await handle.api.sendMessage(thread.id, { content: "Continuing here so the channel stays clean.", allowed_mentions: { parse: [] } });
      return void (await this.deliverPrompt(handle, thread.id, result.sessionId, text, message.attachments, message.id, result.agentId));
    }
    if (!config.discord.requireMention) {
      const result = await this.ensureSession(
        handle,
        key,
        { kind: "channel", channelId: message.channel_id, speakerBot: handle.bot.label, ...(message.guild_id ? { guildId: message.guild_id } : {}) },
        text,
        channel,
      );
      await this.deliverPrompt(handle, message.channel_id, result.sessionId, text, message.attachments, message.id, result.agentId);
    }
  }

  private async refuseUnknown(handle: BotHandle, message: DiscordMessage): Promise<void> {
    const userId = message.author.id;
    this.users = await noteDiscordPending(this.users, userId, message.author.username, (message.content ?? "").slice(0, 120));
    const last = this.unknownNotified.get(userId) ?? 0;
    if (Date.now() - last > 10 * 60_000) {
      this.unknownNotified.set(userId, Date.now());
      await handle.api.sendMessage(message.channel_id, { content: "This bot is private. The owner has been notified.", allowed_mentions: { parse: [] } }).catch(() => undefined);
      await this.notifyOwner("🚪 " + (message.author.username ? "@" + message.author.username : userId) + " tried to use the Discord bot.", [
        buttonRow([
          { text: "Approve", data: "ap:" + userId, style: 3 },
          { text: "Block", data: "no:" + userId, style: 4 },
        ]),
      ]);
    }
  }

  private async ensureSession(handle: BotHandle, key: string, binding: DiscordBinding, text: string, channel?: DiscordChannel): Promise<{ sessionId: string; agentId: string }> {
    if (binding.sessionId) {
      const existing = await findSession(binding.sessionId);
      if (existing && existing.deletedAt === undefined) {
        const agentId = existing.agent ?? binding.agentId ?? (await this.resolveAgent(handle, binding));
        if (binding.agentId !== agentId) {
          binding = { ...binding, agentId };
          await setDiscordBinding(this.state, handle.bot.label, key, binding);
        }
        return { sessionId: String(existing.id), agentId };
      }
    }
    const agentId = await this.resolveAgent(handle, binding);
    const clean = text.trim();
    const title = channel?.name && (!clean || clean === channel.name)
      ? channel.name
      : (clean.slice(0, 48) || channel?.name || "Discord thread");
    const session = await createSession(title.slice(0, 120), agentId);
    await updateSessionRecord(Number(session.id), {
      channel: {
        kind: "discord",
        bot: handle.bot.label,
        ...(binding.guildId ? { guildId: binding.guildId } : {}),
        channelId: binding.channelId,
        ...(binding.threadId ? { threadId: binding.threadId } : {}),
        ...(binding.parentId ? { parentId: binding.parentId } : {}),
      },
    });
    const next: DiscordBinding = { ...binding, agentId, sessionId: session.id, speakerBot: handle.bot.label };
    await setDiscordBinding(this.state, handle.bot.label, key, next);
    return { sessionId: session.id, agentId };
  }

  private async resolveAgent(handle: BotHandle, binding: DiscordBinding): Promise<string> {
    for (const candidate of [binding.agentId, handle.bot.defaultAgent, orchestratorId()]) {
      if (!candidate) continue;
      const files = await readAgent(candidate);
      if (files && files.record.enabled !== false) return candidate;
    }
    const first = (await listAgents()).find((agent) => agent.enabled !== false);
    if (!first) throw new Error("no agent is configured; create one with dura agent create");
    return first.id;
  }

  private async deliverPrompt(handle: BotHandle, channelId: string, sessionId: string, text: string, attachments: DiscordAttachment[], replyTo?: string, agentId?: string): Promise<void> {
    let drafts: AttachmentDraft[] = [];
    if (attachments.length > 0) {
      try {
        drafts = await downloadDiscordAttachments(attachments);
      } catch (error) {
        await handle.api.sendMessage(channelId, { content: "⚠️ " + (error instanceof Error ? error.message : String(error)), allowed_mentions: { parse: [] } }).catch(() => undefined);
        return;
      }
    }
    const busy = activeIds().includes(sessionId) || (await sessionBusy(sessionId));
    const requestId = "dc:" + handle.bot.label + ":" + channelId + ":" + (replyTo ?? Date.now());
    if (busy) {
      try {
        await sendMessage(sessionId, { text, ...(drafts.length ? { attachments: drafts } : {}), requestId }, "steer");
        await handle.api.sendMessage(channelId, { content: "Steer · added to the current run", ...(replyTo ? { message_reference: { message_id: replyTo } } : {}), allowed_mentions: { parse: [] } });
      } catch (error) {
        await handle.api.sendMessage(channelId, { content: "⚠️ " + (error instanceof Error ? error.message : String(error)), allowed_mentions: { parse: [] } }).catch(() => undefined);
      }
      return;
    }
    const placeholder = await handle.api.sendMessage(channelId, { content: "Think · planning the next step", ...(replyTo ? { message_reference: { message_id: replyTo } } : {}), allowed_mentions: { parse: [] } });
    rememberDiscordMessage(this.state, handle.bot.label, channelId, placeholder.id, sessionId);
    try {
      const submission = await sendMessage(sessionId, { text, ...(drafts.length ? { attachments: drafts } : {}), requestId }, "followUp");
      if (!submission) throw new Error("the thread disappeared");
      void this.runSession({ handle, channelId, sessionId, placeholderId: placeholder.id, submissionId: submission.submissionId, agentId: agentId ?? "agent" });
    } catch (error) {
      await handle.api.editMessage(channelId, placeholder.id, { content: "⚠️ " + (error instanceof Error ? error.message : String(error)), allowed_mentions: { parse: [] } }).catch(() => undefined);
    }
  }

  private async runSession(input: {
    handle: BotHandle;
    channelId: string;
    sessionId: string;
    placeholderId: string;
    submissionId: string;
    agentId: string;
  }): Promise<void> {
    const { handle, channelId, sessionId, placeholderId } = input;
    const started = Date.now();
    const config = await readConfig({ fresh: true });
    const editInterval = Math.max(1000, config.discord.editIntervalMs);
    const edit = async (content: string, components?: unknown[]): Promise<void> => {
      await handle.api
        .editMessage(channelId, placeholderId, {
          content: content.slice(0, 2000),
          ...(components?.length ? { components } : {}),
          allowed_mentions: { parse: [] },
        })
        .catch(() => undefined);
    };
    let stopStream: (() => Promise<void>) | undefined;
    let unanswered = false;
    const seenCalls = new Set<string>();
    const lines: string[] = [];
    let thinking = "";
    let phase: string | null = null;
    let lastStatusAt = 0;
    let statusTimer: ReturnType<typeof setTimeout> | undefined;

    const paintStatus = (force: boolean): void => {
      const now = Date.now();
      const text = statusText({ phase, thinking, lines });
      const wait = editInterval - (now - lastStatusAt);
      if (!force && wait > 0) {
        statusTimer ??= setTimeout(() => {
          statusTimer = undefined;
          paintStatus(false);
        }, wait);
        return;
      }
      lastStatusAt = now;
      void edit(text);
    };

    const before = (await transcript(sessionId)).length;
    try {
      const conversation = await harnessInstance().conversation(Number(sessionId) as never, context);
      if (conversation) {
        const stream = await openEventStream(harnessInstance(), conversation.id, context, (frame: WireFrame) => {
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
      log.debug("discord.stream_unavailable", { sessionId, ...errorFields(error) });
    }

    try {
      const record = await harnessInstance().submission(Number(input.submissionId) as never, context);
      if (!record) throw new Error("the submission disappeared");
      const settled = await Promise.race([
        record.wait(context),
        new Promise<never>((_done, reject) => setTimeout(() => reject(new Error("the run did not settle within 30 minutes")), 30 * 60_000)),
      ]);
      unanswered = (settled as { status?: unknown }).status === "unanswered";
    } catch (error) {
      await stopStream?.().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      await edit(/abort|cancel/i.test(message) ? "stopped." : "⚠️ " + message);
      if (!/abort|cancel/i.test(message)) log.error("discord.run_failed", { sessionId, ...errorFields(error) });
      return;
    }
    await stopStream?.().catch(() => undefined);
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = undefined;
    }

    const entries = await transcript(sessionId);
    const fresh = entries.slice(before);
    const question = [...fresh].reverse().find((entry) => entry.kind === "chat.question");
    const answer = [...fresh].reverse().find((entry) => entry.role === "assistant" && entry.text.trim().length > 0);

    if (question) {
      const data = (question.data ?? {}) as { options?: unknown; approval?: unknown };
      const options = Array.isArray(data.options) ? data.options.filter((value): value is string => typeof value === "string") : [];
      const approvalData = data.approval as { kind?: unknown; digest?: unknown; action?: unknown } | undefined;
      const approval =
        approvalData && approvalData.kind === "sudo" && typeof approvalData.digest === "string"
          ? {
              kind: "sudo" as const,
              digest: approvalData.digest,
              ...(typeof approvalData.action === "string" ? { action: approvalData.action } : {}),
            }
          : undefined;
      const nonce = randomUUID().slice(0, 10);
      this.questions.set(nonce, {
        sessionId,
        channelId,
        options,
        expiresAt: Date.now() + QUESTION_TTL_MS,
        ...(approval ? { approval } : {}),
      });
      const components = questionComponents(options, nonce);
      await edit("❓ waiting for your answer…");
      await handle.api.sendMessage(channelId, {
        content: "**Question**\n\n" + toDiscordMarkdown(question.text) + (options.length === 0 ? "\n\nType the answer." : ""),
        ...(components.length ? { components } : {}),
        allowed_mentions: { parse: [] },
      });
    } else if (answer) {
      const chunks = splitDiscordMessage(answer.text);
      if (chunks.length === 0) {
        await edit("(no answer)");
      } else if (chunks.length > 8) {
        await edit(chunks[0] ?? "");
        await handle.api.sendMessage(channelId, {
          content: "The full answer is attached.",
          files: [{ name: "answer.md", data: Buffer.from(answer.text, "utf8"), mimeType: "text/markdown; charset=utf-8" }],
          allowed_mentions: { parse: [] },
        });
      } else {
        await edit(chunks[0] ?? "");
        for (const chunk of chunks.slice(1)) {
          await handle.api.sendMessage(channelId, { content: chunk, allowed_mentions: { parse: [] } });
        }
      }
      await this.sendArtifacts(handle, channelId, fresh, Number(sessionId));
    } else {
      await edit(unanswered ? "stopped." : "(no answer)");
      if (unanswered) log.info("discord.run_stopped", { sessionId });
    }

    log.info("discord.conversation", { sessionId, agent: input.agentId, ms: Date.now() - started, entries: fresh.length, question: Boolean(question) });
  }

  private async sendArtifacts(handle: BotHandle, channelId: string, entries: WireMsg[], conversationId: number): Promise<void> {
    for (const entry of entries) {
      for (const artifact of entry.artifacts ?? []) {
        const bytes = await readArtifact(String(conversationId), artifact.id);
        if (!bytes) continue;
        if (bytes.byteLength > 25 * 1024 * 1024) {
          await handle.api.sendMessage(channelId, { content: "⚠️ " + artifact.name + " is larger than Discord's 25 MB upload limit.", allowed_mentions: { parse: [] } });
          continue;
        }
        await handle.api
          .sendMessage(channelId, {
            content: "📎 " + artifact.name,
            files: [{ name: artifact.name, data: bytes, mimeType: artifact.mimeType }],
            allowed_mentions: { parse: [] },
          })
          .catch((error) => log.warn("discord.artifact_failed", { name: artifact.name, ...errorFields(error) }));
      }
    }
  }

  private async handleInteraction(handle: BotHandle, interaction: DiscordInteraction): Promise<void> {
    const user = interaction.member?.user ?? interaction.user;
    if (!user) return;
    const role = discordRoleOf(this.users, user.id);
    if (interaction.type === 2) {
      if (!role) {
        await this.respond(interaction, "This bot is private. The owner has been notified.", true);
        this.users = await noteDiscordPending(this.users, user.id, user.username, "/" + (interaction.data?.name ?? ""));
        return;
      }
      const channel = interaction.channel_id ? await this.channelOf(handle.api, interaction.channel_id) : undefined;
      const ctx: CommandContext = {
        bot: handle,
        channelId: interaction.channel_id ?? "",
        ...(interaction.guild_id ? { guildId: interaction.guild_id } : {}),
        userId: user.id,
        username: user.username,
        isOwner: role === "owner",
        interaction,
        ...(channel ? { channel } : {}),
      };
      await this.runCommand(ctx, interaction.data?.name ?? "", interaction.data?.options ?? []);
      return;
    }
    if (interaction.type === 3) {
      await this.handleComponent(handle, interaction, user.id, role === "owner");
      return;
    }
    if (interaction.type === 4) {
      await this.respondInteraction(interaction, { type: 8, data: { choices: [] } });
    }
  }

  private async respondInteraction(interaction: DiscordInteraction, data: unknown): Promise<void> {
    const handle = this.handles.get(this.registry.bots.find((bot) => bot.applicationId === interaction.application_id)?.label ?? this.registry.default);
    if (!handle) return;
    await handle.api.interactionCallback(interaction.id, interaction.token, data).catch((error) => log.warn("discord.interaction_response_failed", { ...errorFields(error) }));
  }

  private async respond(interaction: DiscordInteraction, content: string, ephemeral: boolean, components?: unknown[]): Promise<void> {
    await this.respondInteraction(interaction, {
      type: 4,
      data: {
        content: content.slice(0, 2000),
        ...(ephemeral ? { flags: 64 } : {}),
        ...(components?.length ? { components } : {}),
        allowed_mentions: { parse: [] },
      },
    });
  }

  private async reply(ctx: CommandContext, content: string, options: { ephemeral?: boolean; components?: unknown[] } = {}): Promise<void> {
    if (ctx.interaction && !ctx.replied) {
      ctx.replied = true;
      await this.respond(ctx.interaction, content, options.ephemeral !== false, options.components);
      return;
    }
    await ctx.bot.api.sendMessage(ctx.channelId, {
      content: content.slice(0, 2000),
      ...(options.components?.length ? { components: options.components } : {}),
      allowed_mentions: { parse: [] },
    });
  }

  private async handleTextCommand(ctx: CommandContext, line: string): Promise<void> {
    const [name = "", ...rest] = line.trim().split(/\s+/);
    const options = rest.map((value) => ({ name: "arg", type: 3, value }));
    await this.runCommand(ctx, name.toLowerCase(), options);
  }

  private async runCommand(ctx: CommandContext, name: string, options: { name: string; type: number; value?: string | number | boolean }[]): Promise<void> {
    const option = (key: string): string | undefined => {
      const found = options.find((entry) => entry.name === key);
      return found?.value === undefined ? undefined : String(found.value);
    };
    const positionals = options.filter((entry) => entry.name === "arg").map((entry) => String(entry.value ?? ""));
    const first = positionals[0];
    const text = positionals.join(" ").trim();

    try {
      switch (name) {
        case "help":
        case "menu":
          return void (await this.reply(ctx, helpText(), { ephemeral: true }));
        case "whoami":
          return void (await this.reply(ctx, "id " + ctx.userId + " · " + (ctx.isOwner ? "owner" : "user") + " · bot " + ctx.bot.bot.label, { ephemeral: true }));
        case "ping": {
          const started = Date.now();
          await ctx.bot.api.getMe();
          return void (await this.reply(ctx, "gateway " + (ctx.bot.gateway.isReady ? "ready" : "not ready") + " · REST " + (Date.now() - started) + "ms", { ephemeral: true }));
        }
        case "status":
          return void (await this.reply(ctx, await this.statusText(), { ephemeral: true }));
        case "new":
          return void (await this.newThread(ctx, option("title") ?? first, option("agent")));
        case "threads":
          return void (await this.listThreads(ctx));
        case "rename":
          return void (await this.renameCurrent(ctx, option("title") ?? text));
        case "archive":
          return void (await this.archiveCurrent(ctx));
        case "agent":
          return void (await this.switchAgent(ctx, option("agent") ?? first));
        case "agents":
          return void (await this.listAgents(ctx));
        case "model":
          return void (await this.modelCommand(ctx, option("model") ?? first));
        case "thinking":
          return void (await this.thinkingCommand(ctx, option("level") ?? first));
        case "usage":
          return void (await this.reply(ctx, JSON.stringify(usageReport(false), null, 2).slice(0, 1900), { ephemeral: true }));
        case "plan":
          return void (await this.plan(ctx, option("goal") ?? text));
        case "compact":
          return void (await this.compact(ctx));
        case "abort":
        case "stop":
          return void (await this.stopCommand(ctx));
        case "bind":
          return void (await this.bind(ctx, option("agent") ?? first, option("group")));
        case "unbind":
          return void (await this.unbind(ctx));
        case "memory":
          return void (await this.memory(ctx, option("agent") ?? first));
        case "schedules": {
          const { listSchedules } = await import("../../core/src/schedules.ts");
          const list = await listSchedules();
          const lines = list.slice(0, 20).map((schedule) => "· " + schedule.id + " · " + schedule.name + " · " + schedule.cron + " · " + (schedule.enabled === false ? "disabled" : "enabled"));
          return void (await this.reply(ctx, "**Schedules**\n" + (lines.join("\n") || "none"), { ephemeral: true }));
        }
        case "bots":
          return void (await this.bots(ctx));
        case "orchestrator":
          return void (await this.orchestrator(ctx, option("agent") ?? first));
        case "settings":
          return void (await this.settings(ctx));
        case "mcp":
          return void (await this.mcpCommand(ctx, option("action") ?? first, options));
        case "prune":
          return void (await this.pruneCommand(ctx, option("days") ?? first));
        case "reload":
          return void (await this.reload(ctx));
        case "restart":
          return void (await this.restart(ctx));
        case "connect":
          return void (await this.connectCommand(ctx, option("token") ?? "", option("label"), option("agent")));
        case "approve":
          return void (await this.approve(ctx, option("user") ?? first));
        case "invite":
          return void (await this.reply(ctx, "Invite: " + inviteUrl(ctx.bot.bot.applicationId), { ephemeral: true }));
        case "server":
          return void (await this.server(ctx));
        case "mod":
          return void (await this.moderationCommand(ctx, options));
        default:
          return void (await this.reply(ctx, "Unknown command. /help lists the ones that exist.", { ephemeral: true }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("discord.command_failed", { name, ...errorFields(error) });
      await this.reply(ctx, "⚠️ " + message, { ephemeral: true }).catch(() => undefined);
    }
  }

  private async statusText(): Promise<string> {
    const status = await this.status();
    const bots = (status.bots as { label: string; username?: string; ok: boolean; gateway: string }[])
      .map((bot) => (bot.username ? "@" + bot.username : bot.label) + " " + (bot.ok ? "ok" : bot.gateway))
      .join(" · ");
    return [
      "**Status**",
      "agents " + String(status.agents ?? 0) + " · orchestrator " + (status.orchestrator ?? "none") + " · owner " + (status.owner ?? "none"),
      "bots " + (bots || "none"),
      "active runs " + activeIds().length,
    ].join("\n");
  }

  private async newThread(ctx: CommandContext, title: string | undefined, agentArg: string | undefined): Promise<void> {
    const agentId = agentArg ? (await readAgent(agentArg))?.record.id : undefined;
    if (agentArg && !agentId) return void (await this.reply(ctx, "Unknown agent: " + agentArg, { ephemeral: true }));
    const channel = ctx.channel ?? (await this.channelOf(ctx.bot.api, ctx.channelId));
    if (!ctx.guildId) {
      const key = discordBindingKey({ channelId: ctx.channelId, userId: ctx.userId, dm: true });
      const result = await this.ensureSession(ctx.bot, key, { kind: "dm", channelId: ctx.channelId, ...(agentId ? { agentId } : {}) }, title ?? "New thread", channel);
      return void (await this.reply(ctx, "New thread: " + ((await findSession(result.sessionId))?.title ?? "thread"), { ephemeral: true }));
    }
    if (this.isThread(channel)) {
      return void (await this.reply(ctx, "This channel is already a thread. Use /agent to move it or /rename to rename it.", { ephemeral: true }));
    }
    const name = (title || "New thread").slice(0, 90);
    const thread = await ctx.bot.api.createThread(ctx.channelId, { name });
    await ctx.bot.api.joinThread(thread.id).catch(() => undefined);
    const result = await this.ensureSession(
      ctx.bot,
      "thread:" + thread.id,
      {
        kind: "thread",
        channelId: thread.id,
        threadId: thread.id,
        parentId: ctx.channelId,
        speakerBot: ctx.bot.bot.label,
        ...(ctx.guildId ? { guildId: ctx.guildId } : {}),
        ...(agentId ? { agentId } : {}),
      },
      name,
      thread,
    );
    await ctx.bot.api.sendMessage(thread.id, { content: "Thread ready. Send the first message here.", allowed_mentions: { parse: [] } });
    const link = ctx.guildId ? "https://discord.com/channels/" + ctx.guildId + "/" + thread.id : thread.id;
    await this.reply(ctx, "New thread: " + link + " · agent " + result.agentId, { ephemeral: true });
  }

  private async currentBinding(ctx: CommandContext): Promise<{ key: string; binding: DiscordBinding | undefined }> {
    const channel = ctx.channel ?? (await this.channelOf(ctx.bot.api, ctx.channelId));
    const key = !ctx.guildId
      ? discordBindingKey({ channelId: ctx.channelId, userId: ctx.userId, dm: true })
      : this.isThread(channel)
        ? "thread:" + ctx.channelId
        : "channel:" + ctx.channelId;
    return { key, binding: await getDiscordBinding(this.state, ctx.bot.bot.label, key) };
  }

  private async listThreads(ctx: CommandContext): Promise<void> {
    const sessions = (await listSessions()).slice(0, 15);
    if (sessions.length === 0) return void (await this.reply(ctx, "No threads yet. /new starts one.", { ephemeral: true }));
    const lines = sessions.map((session) => {
      const channel = session.channel;
      const link = channel?.kind === "discord" && channel.guildId && channel.threadId
        ? "https://discord.com/channels/" + channel.guildId + "/" + channel.threadId
        : undefined;
      return "· " + session.title.slice(0, 60) + " · " + (session.agent ?? "no agent") + " · " + age(Date.now() - session.updatedAt) + (link ? " · " + link : "");
    });
    await this.reply(ctx, "**Threads**\n" + lines.join("\n"), { ephemeral: true });
  }

  private async renameCurrent(ctx: CommandContext, title: string): Promise<void> {
    if (!title.trim()) return void (await this.reply(ctx, "Usage: /rename <title>", { ephemeral: true }));
    const { binding } = await this.currentBinding(ctx);
    if (!binding?.sessionId) return void (await this.reply(ctx, "No active thread here. Use /new first.", { ephemeral: true }));
    await renameSession(binding.sessionId, title);
    if (binding.threadId) await ctx.bot.api.editThread(binding.threadId, { name: title }).catch(() => undefined);
    await this.reply(ctx, "Renamed to: " + title, { ephemeral: true });
  }

  private async archiveCurrent(ctx: CommandContext): Promise<void> {
    const { binding } = await this.currentBinding(ctx);
    if (!binding?.threadId) return void (await this.reply(ctx, "This is not a Discord thread.", { ephemeral: true }));
    await ctx.bot.api.editThread(binding.threadId, { archived: true });
    await this.reply(ctx, "Archived this thread. Send a message to unarchive it.", { ephemeral: true });
  }

  private async switchAgent(ctx: CommandContext, agentId: string | undefined): Promise<void> {
    if (!agentId) return void (await this.reply(ctx, "Usage: /agent <agent-id>", { ephemeral: true }));
    if (!(await readAgent(agentId))) return void (await this.reply(ctx, "Unknown agent: " + agentId, { ephemeral: true }));
    const { key, binding } = await this.currentBinding(ctx);
    if (!binding?.sessionId) {
      const channel = ctx.channel ?? (await this.channelOf(ctx.bot.api, ctx.channelId));
      await setDiscordBinding(this.state, ctx.bot.bot.label, key, {
        kind: !ctx.guildId ? "dm" : this.isThread(channel) ? "thread" : "channel",
        channelId: ctx.channelId,
        agentId,
        speakerBot: ctx.bot.bot.label,
        ...(ctx.guildId ? { guildId: ctx.guildId } : {}),
        ...(this.isThread(channel) ? { threadId: ctx.channelId } : {}),
      });
      return void (await this.reply(ctx, "This channel now routes to " + agentId + ".", { ephemeral: true }));
    }
    const moved = await moveSession(binding.sessionId, agentId);
    if (!moved) return void (await this.reply(ctx, "That thread cannot be moved.", { ephemeral: true }));
    await setDiscordBinding(this.state, ctx.bot.bot.label, key, { ...binding, agentId });
    await this.reply(ctx, "Moved this thread to " + agentId + ".", { ephemeral: true });
  }

  private async listAgents(ctx: CommandContext): Promise<void> {
    const agents = await listAgents();
    const lines = agents.map((agent) => "· " + agent.id + " · " + agent.name + " · " + agent.provider + "/" + agent.modelId + (agent.enabled === false ? " · disabled" : ""));
    await this.reply(ctx, "**Agents**\n" + (lines.join("\n") || "none"), { ephemeral: true });
  }

  private async sessionForCommand(ctx: CommandContext): Promise<string | undefined> {
    return (await this.currentBinding(ctx)).binding?.sessionId;
  }

  private async modelCommand(ctx: CommandContext, value: string | undefined): Promise<void> {
    const sessionId = await this.sessionForCommand(ctx);
    if (!sessionId) return void (await this.reply(ctx, "No active thread. Use /new first.", { ephemeral: true }));
    const session = await findSession(sessionId);
    if (!value) return void (await this.reply(ctx, "model " + (session?.model ? session.model.provider + "/" + session.model.modelId : "agent default"), { ephemeral: true }));
    const [provider, modelId] = value.includes("/") ? value.split("/", 2) : [undefined, value];
    const agent = session?.agent ? await readAgent(session.agent) : undefined;
    const result = await setSessionModel(sessionId, { provider: provider ?? agent?.record.provider ?? "", modelId: modelId ?? value });
    if (!result) return void (await this.reply(ctx, "That model could not be set.", { ephemeral: true }));
    await this.reply(ctx, "Model changed for " + result.changed + ".", { ephemeral: true });
  }

  private async thinkingCommand(ctx: CommandContext, value: string | undefined): Promise<void> {
    if (!value) {
      const sessionId = await this.sessionForCommand(ctx);
      const session = sessionId ? await findSession(sessionId) : undefined;
      return void (await this.reply(ctx, "thinking " + (session?.thinkingLevel ?? "agent default") + " · levels: " + THINKING_LEVELS.join(", "), { ephemeral: true }));
    }
    if (!isThinkingLevel(value)) return void (await this.reply(ctx, "Level must be one of " + THINKING_LEVELS.join(", "), { ephemeral: true }));
    const sessionId = await this.sessionForCommand(ctx);
    if (!sessionId) return void (await this.reply(ctx, "No active thread. Use /new first.", { ephemeral: true }));
    const result = await setSessionThinking(sessionId, value);
    await this.reply(ctx, result ? "Thinking set to " + value + " for this " + result.changed + "." : "Could not change thinking.", { ephemeral: true });
  }

  private async plan(ctx: CommandContext, goal: string): Promise<void> {
    const promptGoal = goal || "the last request in this thread";
    const sessionId = await this.ensureCommandSession(ctx, "Plan: " + promptGoal.slice(0, 40));
    await this.reply(ctx, "Planning…", { ephemeral: true });
    await this.runPrompt(ctx, sessionId, "Plan only. Do not execute yet. Produce a concise plan for: " + promptGoal + "\n\nStructure: Goal; Steps (owner, action, done-when); Risks; Open questions.");
  }

  private async ensureCommandSession(ctx: CommandContext, title: string): Promise<string> {
    const { key, binding } = await this.currentBinding(ctx);
    if (binding?.sessionId) {
      const existing = await findSession(binding.sessionId);
      if (existing && existing.deletedAt === undefined) return binding.sessionId;
    }
    const channel = ctx.channel ?? (await this.channelOf(ctx.bot.api, ctx.channelId));
    const result = await this.ensureSession(
      ctx.bot,
      key,
      binding ?? {
        kind: !ctx.guildId ? "dm" : this.isThread(channel) ? "thread" : "channel",
        channelId: ctx.channelId,
        speakerBot: ctx.bot.bot.label,
        ...(ctx.guildId ? { guildId: ctx.guildId } : {}),
        ...(this.isThread(channel) ? { threadId: ctx.channelId } : {}),
      },
      title,
      channel,
    );
    return result.sessionId;
  }

  private async runPrompt(ctx: CommandContext, sessionId: string, text: string): Promise<void> {
    const placeholder = await ctx.bot.api.sendMessage(ctx.channelId, { content: "Think · planning the next step", allowed_mentions: { parse: [] } });
    const requestId = "dc:" + ctx.bot.bot.label + ":" + ctx.channelId + ":cmd:" + Date.now();
    const submission = await sendMessage(sessionId, { text, requestId }, "followUp");
    if (!submission) throw new Error("the thread disappeared");
    void this.runSession({ handle: ctx.bot, channelId: ctx.channelId, sessionId, placeholderId: placeholder.id, submissionId: submission.submissionId, agentId: "agent" });
  }

  private async compact(ctx: CommandContext): Promise<void> {
    const sessionId = await this.sessionForCommand(ctx);
    if (!sessionId) return void (await this.reply(ctx, "No active thread.", { ephemeral: true }));
    await compactSession(sessionId);
    await this.reply(ctx, "Compacting this thread's context.", { ephemeral: true });
  }

  private async stopCommand(ctx: CommandContext): Promise<void> {
    const sessionId = await this.sessionForCommand(ctx);
    if (!sessionId) return void (await this.reply(ctx, "Nothing is running here.", { ephemeral: true }));
    const stopped = await abortSession(sessionId).catch(() => false);
    await this.reply(ctx, stopped ? "Stopped the active run." : "Nothing is running here.", { ephemeral: true });
  }

  private async bind(ctx: CommandContext, agentId: string | undefined, groupId: string | undefined): Promise<void> {
    if (!ctx.isOwner) return void (await this.reply(ctx, "Owner only.", { ephemeral: true }));
    if (groupId) return void (await this.reply(ctx, "Group bindings are managed with dura group; /bind agent:<id> binds this channel to an agent.", { ephemeral: true }));
    if (!agentId) return void (await this.reply(ctx, "Usage: /bind agent:<id>", { ephemeral: true }));
    if (!(await readAgent(agentId))) return void (await this.reply(ctx, "Unknown agent: " + agentId, { ephemeral: true }));
    const channel = ctx.channel ?? (await this.channelOf(ctx.bot.api, ctx.channelId));
    const key = this.isThread(channel) ? "thread:" + ctx.channelId : "channel:" + ctx.channelId;
    const existing = await getDiscordBinding(this.state, ctx.bot.bot.label, key);
    if (existing?.sessionId) await moveSession(existing.sessionId, agentId).catch(() => undefined);
    await setDiscordBinding(this.state, ctx.bot.bot.label, key, {
      ...(existing ?? { kind: this.isThread(channel) ? "thread" : "channel", channelId: ctx.channelId }),
      kind: this.isThread(channel) ? "thread" : "channel",
      channelId: ctx.channelId,
      agentId,
      speakerBot: ctx.bot.bot.label,
      ...(ctx.guildId ? { guildId: ctx.guildId } : {}),
      ...(this.isThread(channel) ? { threadId: ctx.channelId, ...(channel.parent_id ? { parentId: channel.parent_id } : {}) } : {}),
    });
    await this.reply(ctx, "This channel routes to " + agentId + ".", { ephemeral: true });
  }

  private async unbind(ctx: CommandContext): Promise<void> {
    if (!ctx.isOwner) return void (await this.reply(ctx, "Owner only.", { ephemeral: true }));
    const { key } = await this.currentBinding(ctx);
    await deleteDiscordBinding(this.state, ctx.bot.bot.label, key);
    await this.reply(ctx, "Binding removed.", { ephemeral: true });
  }

  private async memory(ctx: CommandContext, agentArg: string | undefined): Promise<void> {
    const sessionId = await this.sessionForCommand(ctx);
    const session = sessionId ? await findSession(sessionId) : undefined;
    const id = agentArg ?? session?.agent;
    if (!id) return void (await this.reply(ctx, "No agent for this thread.", { ephemeral: true }));
    const memory = await readMemory(id);
    await this.reply(ctx, "**Memory: " + id + "**\n" + (memory.slice(0, 1800) || "(empty)"), { ephemeral: true });
  }

  private async bots(ctx: CommandContext): Promise<void> {
    if (!ctx.isOwner) return void (await this.reply(ctx, "Owner only.", { ephemeral: true }));
    const lines = this.registry.bots.map((bot) => {
      const health = this.state.bots[bot.label]?.health;
      return "· " + bot.label + " · @" + bot.username + " · " + (health?.ok ? "ready" : health?.state ?? "stopped") + " · default " + (bot.defaultAgent ?? "none");
    });
    await this.reply(ctx, "**Discord bots**\n" + (lines.join("\n") || "none"), { ephemeral: true });
  }

  private async orchestrator(ctx: CommandContext, agentId: string | undefined): Promise<void> {
    if (!ctx.isOwner) return void (await this.reply(ctx, "Owner only.", { ephemeral: true }));
    if (!agentId) return void (await this.reply(ctx, "orchestrator " + (orchestratorId() ?? "none"), { ephemeral: true }));
    if (!(await readAgent(agentId))) return void (await this.reply(ctx, "Unknown agent: " + agentId, { ephemeral: true }));
    await setOrchestrator(agentId);
    await this.reply(ctx, "Orchestrator: " + agentId, { ephemeral: true });
  }

  private async settings(ctx: CommandContext): Promise<void> {
    if (!ctx.isOwner) return void (await this.reply(ctx, "Owner only.", { ephemeral: true }));
    const config = await readConfig({ fresh: true });
    await this.reply(
      ctx,
      [
        "platform " + config.chat.active,
        "default bot " + (this.registry.default || "none"),
        "edit interval " + config.discord.editIntervalMs + "ms",
        "guilds " + (config.discord.allowGuilds ? "enabled" : "disabled") + " · require mention " + (config.discord.requireMention ? "yes" : "no"),
        "agent tools " + (config.discord.agentTools ? "on" : "off") + " · agent moderation " + (config.discord.moderation.agentTools ? "on" : "off"),
        "audit channel " + (config.discord.moderation.auditChannelId ?? "none"),
      ].join("\n"),
      { ephemeral: true },
    );
  }

  private async mcpCommand(ctx: CommandContext, action: string | undefined, options: { name: string; type: number; value?: string | number | boolean }[]): Promise<void> {
    if (!ctx.isOwner) return void (await this.reply(ctx, "Owner only.", { ephemeral: true }));
    const { addMcpServer, removeMcpServer, reloadMcp, mcpStatus, mcpToolInfos } = await import("../../core/src/mcp.ts");
    const name = options.find((entry) => entry.name === "name")?.value;
    const command = options.find((entry) => entry.name === "command")?.value;
    const act = action ?? "list";
    if (act === "add") {
      if (!name || !command) return void (await this.reply(ctx, "Usage: /mcp add name:<name> command:<command>", { ephemeral: true }));
      const [bin, ...args] = String(command).split(/\s+/);
      if (!bin) return void (await this.reply(ctx, "A command is required.", { ephemeral: true }));
      const result = await addMcpServer({ name: String(name), command: bin, args });
      return void (await this.reply(ctx, "MCP " + name + " connected · " + result.tools.length + " tools · " + result.rebound + " agents rebound.", { ephemeral: true }));
    }
    if (act === "remove") {
      if (!name) return void (await this.reply(ctx, "Usage: /mcp remove name:<name>", { ephemeral: true }));
      const result = await removeMcpServer(String(name));
      return void (await this.reply(ctx, result.removed ? "Removed " + name + "." : "No server " + name + ".", { ephemeral: true }));
    }
    if (act === "reload") {
      const result = await reloadMcp();
      return void (await this.reply(ctx, "MCP reloaded · " + result.servers.length + " servers · " + result.tools.length + " tools.", { ephemeral: true }));
    }
    const servers = mcpStatus();
    const tools = mcpToolInfos();
    await this.reply(
      ctx,
      "**MCP**\n" + (servers.map((server) => "· " + server.name + " · " + (server.connected ? "connected" : server.error ?? "stopped") + " · " + server.tools.length + " tools").join("\n") || "none") +
        (tools.length ? "\n" + tools.map((tool) => tool.registeredName).slice(0, 20).join(", ") : ""),
      { ephemeral: true },
    );
  }

  private async pruneCommand(ctx: CommandContext, value: string | undefined): Promise<void> {
    if (!ctx.isOwner) return void (await this.reply(ctx, "Owner only.", { ephemeral: true }));
    const days = Number.parseInt(value ?? "", 10);
    const config = await readConfig({ fresh: true });
    const olderThanDays = Number.isFinite(days) && days > 0 ? days : config.storage.pruneAfterDays;
    const preview = await pruneSessions({ olderThanDays, dryRun: true });
    if (preview.candidates.length === 0) return void (await this.reply(ctx, "No stale threads older than " + olderThanDays + " days.", { ephemeral: true }));
    const lines = preview.candidates.slice(0, 12).map((candidate) => "· " + candidate.title.slice(0, 60));
    await this.reply(
      ctx,
      "**Stale threads**\n" + preview.candidates.length + " older than " + olderThanDays + " days:\n" + lines.join("\n") + "\n\nRun dura thread prune --days " + olderThanDays + " --yes to delete them.",
      { ephemeral: true },
    );
  }

  private async reload(ctx: CommandContext): Promise<void> {
    if (!ctx.isOwner) return void (await this.reply(ctx, "Owner only.", { ephemeral: true }));
    const result = await reloadEverything();
    await syncDiscordCommands(ctx.bot.api, ctx.bot.bot.applicationId).catch(() => undefined);
    await this.reply(ctx, "Reloaded " + result.extensions.length + " extensions · rebound " + result.rebound + " agents.", { ephemeral: true });
  }

  private async restart(ctx: CommandContext): Promise<void> {
    if (!ctx.isOwner) return void (await this.reply(ctx, "Owner only.", { ephemeral: true }));
    await startOperation("restart");
    await this.reply(ctx, "Restart requested. The daemon stops and systemd starts it again.", { ephemeral: true });
  }

  private async connectCommand(ctx: CommandContext, token: string, label?: string, agent?: string): Promise<void> {
    if (!ctx.isOwner) return void (await this.reply(ctx, "Owner only.", { ephemeral: true }));
    if (!token) return void (await this.reply(ctx, "Usage: /connect token:<token> [label] [agent]", { ephemeral: true }));
    const result = await this.connectBotToken({ token, ...(label ? { label } : {}) });
    if (agent) {
      if (!(await readAgent(agent))) return void (await this.reply(ctx, "Connected " + result.label + ", but unknown agent " + agent + ".", { ephemeral: true }));
      await setDiscordBotDefaultAgent(result.label, agent);
    }
    await this.reply(ctx, "Connected @" + result.username + " (" + result.label + ").", { ephemeral: true });
  }

  private async approve(ctx: CommandContext, userId: string | undefined): Promise<void> {
    if (!ctx.isOwner) return void (await this.reply(ctx, "Owner only.", { ephemeral: true }));
    if (!userId) return void (await this.reply(ctx, "Usage: /approve user:<id>", { ephemeral: true }));
    this.users = await approveDiscordPending(this.users, userId, ctx.userId);
    await this.reply(ctx, "Approved " + userId + ".", { ephemeral: true });
  }

  private async server(ctx: CommandContext): Promise<void> {
    if (!ctx.isOwner) return void (await this.reply(ctx, "Owner only.", { ephemeral: true }));
    if (!ctx.guildId) return void (await this.reply(ctx, "This is a DM.", { ephemeral: true }));
    const guild = await ctx.bot.api.getGuild(ctx.guildId);
    const channel = ctx.channel ?? (await this.channelOf(ctx.bot.api, ctx.channelId));
    await this.reply(
      ctx,
      "**" + guild.name + "** · " + guild.id + "\nchannel " + (channel.name ?? channel.id) + " · type " + channel.type +
        (channel.parent_id ? " · parent " + channel.parent_id : "") +
        (channel.thread_metadata ? " · archived " + Boolean(channel.thread_metadata.archived) : ""),
      { ephemeral: true },
    );
  }

  private async moderationCommand(ctx: CommandContext, options: { name: string; type: number; value?: string | number | boolean }[]): Promise<void> {
    if (!ctx.isOwner) return void (await this.reply(ctx, "Owner only.", { ephemeral: true }));
    if (!ctx.guildId) return void (await this.reply(ctx, "Moderation works in a guild only.", { ephemeral: true }));
    const sub = options.find((entry) => entry.type === 1) as unknown as { name?: string; options?: { name: string; value?: string | number | boolean }[] } | undefined;
    if (!sub?.name) return void (await this.reply(ctx, "Usage: /mod timeout|kick|ban|unban|warn|warnings|audit", { ephemeral: true }));
    const values = sub.options ?? [];
    const value = (key: string): string | undefined => {
      const found = values.find((entry) => entry.name === key);
      return found?.value === undefined ? undefined : String(found.value);
    };
    const userId = value("user");
    const reason = value("reason") ?? "";
    if (sub.name === "audit") {
      const channelId = value("channel");
      if (!channelId) return void (await this.reply(ctx, "A channel is required.", { ephemeral: true }));
      const current = await readConfig({ fresh: true });
      await updateConfig({ discord: { moderation: { ...current.discord.moderation, auditChannelId: channelId } } });
      return void (await this.reply(ctx, "Audit channel set to <#" + channelId + ">.", { ephemeral: true }));
    }
    if (sub.name === "warnings") {
      if (!userId) return void (await this.reply(ctx, "A member is required.", { ephemeral: true }));
      const list = await warningsFor(ctx.guildId, userId);
      const lines = list.slice(-10).map((warning) => "· " + new Date(warning.at).toISOString().slice(0, 10) + " · " + warning.reason + " · by " + warning.moderatorId);
      return void (await this.reply(ctx, "**Warnings**\n" + (lines.join("\n") || "none"), { ephemeral: true }));
    }
    if (!userId || !reason.trim()) return void (await this.reply(ctx, "A member and a reason are required.", { ephemeral: true }));
    const action = sub.name;
    if (action !== "timeout" && action !== "kick" && action !== "ban" && action !== "unban" && action !== "warn") {
      return void (await this.reply(ctx, "Unknown moderation action.", { ephemeral: true }));
    }
    const input: ModerationInput = {
      action,
      guildId: ctx.guildId,
      userId,
      moderatorId: ctx.userId,
      botId: ctx.bot.bot.botId,
      reason,
      ...(action === "timeout" ? { minutes: Number(value("minutes") ?? 10) } : {}),
      ...(action === "ban" ? { deleteDays: Number(value("delete_days") ?? 0) } : {}),
    };
    if (action === "kick" || action === "ban") {
      const nonce = randomUUID().slice(0, 10);
      this.confirmations.set(nonce, { input, expiresAt: Date.now() + CONFIRM_TTL_MS });
      return void (await this.reply(ctx, "**Confirm " + action + "**\n<@" + userId + "> · " + reason, {
        ephemeral: true,
        components: [
          buttonRow([
            { text: "Confirm " + action, data: "modc:" + nonce, style: 4 },
            { text: "Cancel", data: "modx:" + nonce, style: 2 },
          ]),
        ],
      }));
    }
    const result = await moderate(ctx.bot.api, input);
    await this.reply(ctx, result.ok ? "🛡️ " + result.text : "⚠️ " + result.error, { ephemeral: true });
  }

  private async handleComponent(handle: BotHandle, interaction: DiscordInteraction, userId: string, owner: boolean): Promise<void> {
    const custom = interaction.data?.custom_id ?? interaction.data?.values?.[0] ?? "";
    if (custom.startsWith("q:")) {
      const [, nonce = "", index] = custom.split(":");
      const pending = this.questions.get(nonce);
      if (!pending || pending.expiresAt < Date.now()) {
        this.questions.delete(nonce);
        return void (await this.respondInteraction(interaction, { type: 7, data: { content: "This question expired.", components: [] } }));
      }
      if (pending.approval) {
        if (!owner) {
          return void (await this.respondInteraction(interaction, { type: 4, data: { content: "Owner only.", flags: 64 } }));
        }
        const choice = Number(index);
        if (choice !== 0 && choice !== 1) {
          return void (await this.respondInteraction(interaction, { type: 7, data: { content: "Unknown option.", components: [] } }));
        }
        this.questions.delete(nonce);
        const result =
          choice === 0
            ? await approveSudoRequest(pending.sessionId, pending.approval.digest)
            : denySudoRequest(pending.sessionId, pending.approval.digest);
        if (!result.ok) {
          return void (await this.respondInteraction(interaction, { type: 7, data: { content: result.message, components: [] } }));
        }
        await this.respondInteraction(interaction, {
          type: 7,
          data: { content: result.message.slice(0, 1900), components: [] },
        });
        await this.submitAnswer(handle, pending.channelId, pending.sessionId, result.message);
        log.info("discord.sudo_answered", {
          sessionId: pending.sessionId,
          action: pending.approval.action ?? "",
          approved: choice === 0,
        });
        return;
      }
      const option = pending.options[Number(index)];
      if (option === undefined) return void (await this.respondInteraction(interaction, { type: 7, data: { content: "Unknown option.", components: [] } }));
      this.questions.delete(nonce);
      await this.respondInteraction(interaction, { type: 7, data: { content: "Answer: " + option, components: [] } });
      await this.submitAnswer(handle, pending.channelId, pending.sessionId, option);
      return;
    }
    if (custom.startsWith("ap:") || custom.startsWith("no:")) {
      if (!owner) return void (await this.respondInteraction(interaction, { type: 4, data: { content: "Owner only.", flags: 64 } }));
      const id = custom.slice(custom.indexOf(":") + 1);
      this.users = custom.startsWith("ap:") ? await approveDiscordPending(this.users, id, userId) : await denyDiscordPending(this.users, id);
      return void (await this.respondInteraction(interaction, { type: 7, data: { content: (custom.startsWith("ap:") ? "Approved " : "Blocked ") + id, components: [] } }));
    }
    if (custom.startsWith("oc:") || custom.startsWith("ocno:")) {
      if (!owner) return void (await this.respondInteraction(interaction, { type: 4, data: { content: "Owner only.", flags: 64 } }));
      const agentId = custom.slice(custom.indexOf(":") + 1);
      if (custom.startsWith("oc:")) await setOrchestrator(agentId).catch(() => undefined);
      return void (await this.respondInteraction(interaction, { type: 7, data: { content: custom.startsWith("oc:") ? "Orchestrator updated." : "Request denied.", components: [] } }));
    }
    if (custom.startsWith("modc:") || custom.startsWith("modx:")) {
      if (!owner) return void (await this.respondInteraction(interaction, { type: 4, data: { content: "Owner only.", flags: 64 } }));
      const nonce = custom.slice(custom.indexOf(":") + 1);
      const pending = this.confirmations.get(nonce);
      this.confirmations.delete(nonce);
      if (!pending || pending.expiresAt < Date.now()) return void (await this.respondInteraction(interaction, { type: 7, data: { content: "This confirmation expired.", components: [] } }));
      if (custom.startsWith("modx:")) return void (await this.respondInteraction(interaction, { type: 7, data: { content: "Cancelled.", components: [] } }));
      const result = await moderate(handle.api, pending.input);
      return void (await this.respondInteraction(interaction, { type: 7, data: { content: result.ok ? "🛡️ " + result.text : "⚠️ " + result.error, components: [] } }));
    }
    await this.respondInteraction(interaction, { type: 4, data: { content: "Unknown component.", flags: 64 } });
  }

  private async submitAnswer(handle: BotHandle, channelId: string, sessionId: string, text: string): Promise<void> {
    const placeholder = await handle.api.sendMessage(channelId, { content: "Think · planning the next step", allowed_mentions: { parse: [] } });
    try {
      const submission = await sendMessage(sessionId, { text, requestId: "dc:answer:" + Date.now() }, "followUp");
      if (!submission) throw new Error("the thread disappeared");
      void this.runSession({ handle, channelId, sessionId, placeholderId: placeholder.id, submissionId: submission.submissionId, agentId: "agent" });
    } catch (error) {
      await handle.api.editMessage(channelId, placeholder.id, { content: "⚠️ " + (error instanceof Error ? error.message : String(error)), allowed_mentions: { parse: [] } }).catch(() => undefined);
    }
  }

  private async notifyOwner(text: string, components?: unknown[]): Promise<void> {
    if (!this.users.owner) return;
    const bot = defaultDiscordBot(this.registry);
    if (!bot) return;
    const config = await readConfig().catch(() => undefined);
    const api = this.handles.get(bot.label)?.api ?? new DiscordApi({ token: bot.token, apiBase: config?.discord.apiBase, label: bot.label });
    try {
      const dm = await api.createDM(this.users.owner);
      await api.sendMessage(dm.id, { content: text.slice(0, 1900), ...(components?.length ? { components } : {}), allowed_mentions: { parse: [] } });
      return;
    } catch (error) {
      log.warn("discord.owner_dm_failed", errorFields(error));
    }
    if (!config?.discord.ownerChannelId) return;
    try {
      await api.sendMessage(config.discord.ownerChannelId, { content: text.slice(0, 1900), ...(components?.length ? { components } : {}), allowed_mentions: { parse: [] } });
    } catch (error) {
      log.warn("discord.owner_channel_failed", errorFields(error));
    }
  }

  private async connectBotToken(input: { token: string; label?: string }): Promise<{ label: string; username: string }> {
    const token = input.token.trim();
    if (!token) throw new Error("a bot token is required");
    const existing = this.registry.bots.find((bot) => bot.token === token);
    if (existing) {
      await this.startBot(existing.label);
      return { label: existing.label, username: existing.username };
    }
    const config = await readConfig();
    const api = new DiscordApi({ token, apiBase: config.discord.apiBase });
    const me = await api.getMe();
    const application = await api.getApplication().catch(() => undefined);
    const applicationId = application?.id ?? me.id;
    const base = me.username.replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase().slice(0, 32) || "bot";
    const label = (input.label ?? base).toLowerCase();
    this.registry = await addDiscordBot({
      label,
      token,
      applicationId,
      botId: me.id,
      username: me.username,
      ...(orchestratorId() ? { defaultAgent: orchestratorId() as string } : {}),
    });
    await this.startBot(label);
    await this.notifyOwner("Bot @" + me.username + " (" + label + ") is connected.");
    return { label, username: me.username };
  }

  private toolBridge() {
    const pick = async () => {
      const bot = defaultDiscordBot(this.registry);
      if (!bot) throw new Error("no Discord bot is configured");
      const handle = this.handles.get(bot.label);
      return { bot, api: handle?.api ?? new DiscordApi({ token: bot.token, apiBase: (await readConfig()).discord.apiBase, label: bot.label }) };
    };
    return {
      sendMessage: async (input: { channelId: string; content: string }) => {
        const { api } = await pick();
        const message = await api.sendMessage(input.channelId, { content: input.content, allowed_mentions: { parse: [] } });
        return { messageId: message.id };
      },
      createThread: async (input: { channelId: string; name: string }) => {
        const { api } = await pick();
        const thread = await api.createThread(input.channelId, { name: input.name });
        await api.joinThread(thread.id).catch(() => undefined);
        return { threadId: thread.id };
      },
      archiveThread: async (input: { threadId: string }) => {
        const { api } = await pick();
        await api.editThread(input.threadId, { archived: true });
      },
      listThreads: async (input: { guildId: string; channelId?: string }) => {
        const { api } = await pick();
        const threads = await api.listActiveThreads(input.guildId);
        return threads
          .filter((thread) => !input.channelId || thread.parent_id === input.channelId)
          .map((thread) => ({
            id: thread.id,
            name: thread.name ?? thread.id,
            ...(thread.parent_id ? { parentId: thread.parent_id } : {}),
            archived: Boolean(thread.thread_metadata?.archived),
          }));
      },
      serverInfo: async (input: { guildId: string }) => {
        const { api } = await pick();
        const guild = await api.getGuild(input.guildId);
        return { id: guild.id, name: guild.name, ...(guild.owner_id ? { ownerId: guild.owner_id } : {}) };
      },
      moderate: async (input: { guildId: string; userId: string; action: "timeout" | "kick" | "ban" | "warn"; reason: string; minutes?: number }) => {
        const config = await readConfig({ fresh: true });
        if (!config.discord.moderation.agentTools) return { ok: false as const, error: "Agent moderation is disabled; the owner can enable discord.moderation.agentTools." };
        const { bot, api } = await pick();
        return moderate(api, {
          action: input.action,
          guildId: input.guildId,
          userId: input.userId,
          moderatorId: "agent",
          botId: bot.botId,
          reason: input.reason,
          ...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
        });
      },
    };
  }

  async status(): Promise<Record<string, unknown>> {
    const agents = await listAgents();
    return {
      platform: "discord",
      bots: this.registry.bots.map((bot) => ({
        label: bot.label,
        username: bot.username,
        enabled: bot.enabled,
        default: bot.label === this.registry.default,
        ok: this.state.bots[bot.label]?.health.ok ?? false,
        gateway: this.handles.get(bot.label)?.gateway.isReady ? "ready" : this.state.bots[bot.label]?.health.state ?? "stopped",
        defaultAgent: bot.defaultAgent ?? null,
        guilds: this.handles.get(bot.label)?.guilds ?? 0,
        lastError: this.state.bots[bot.label]?.health.lastError,
      })),
      owner: this.users.owner,
      pending: this.users.pending.length,
      default: this.registry.default,
      agents: agents.length,
      orchestrator: orchestratorId(),
    };
  }

  async verifyExtra(): Promise<Check[]> {
    const checks: Check[] = [];
    for (const bot of this.registry.bots.filter((entry) => entry.enabled)) {
      const started = Date.now();
      try {
        const config = await readConfig();
        const api = new DiscordApi({ token: bot.token, apiBase: config.discord.apiBase, label: bot.label });
        const me = await api.getMe();
        checks.push({ name: "discord " + bot.label, ok: true, detail: "@" + me.username + " · token valid", required: true, ms: Date.now() - started });
        checks.push({
          name: "discord gateway " + bot.label,
          ok: Boolean(this.handles.get(bot.label)?.gateway.isReady),
          detail: this.handles.get(bot.label)?.gateway.isReady ? "READY" : this.state.bots[bot.label]?.health.lastError ?? "not ready",
          required: true,
        });
        try {
          const commands = await api.getCommands(bot.applicationId);
          checks.push({ name: "discord commands " + bot.label, ok: commands.length > 0, detail: commands.length + " registered", required: true });
        } catch (error) {
          checks.push({ name: "discord commands " + bot.label, ok: false, detail: String(error), required: false });
        }
      } catch (error) {
        checks.push({ name: "discord " + bot.label, ok: false, detail: String(error), required: true });
      }
    }
    if (this.users.owner) {
      const started = Date.now();
      try {
        const bot = defaultDiscordBot(this.registry);
        if (!bot) throw new Error("no bot configured");
        const api = new DiscordApi({ token: bot.token, apiBase: (await readConfig()).discord.apiBase, label: bot.label });
        const dm = await api.createDM(this.users.owner);
        const message = await api.sendMessage(dm.id, { content: "dura connected · " + new Date().toISOString(), allowed_mentions: { parse: [] } });
        checks.push({ name: "owner-message", ok: Boolean(message.id), detail: "delivered DM " + message.id + " via " + bot.label, required: true, ms: Date.now() - started });
      } catch (error) {
        checks.push({ name: "owner-message", ok: false, detail: String(error), required: true });
      }
    }
    return checks;
  }

  methods(): Record<string, (params: Record<string, unknown>, connection: never) => Promise<unknown>> {
    return {
      "bots.list": async () => ({ ...publicDiscordRegistry(this.registry), status: await this.status() }),
      "bots.add": async (params) => this.ipcAddBot(params),
      "bots.remove": async (params) => this.ipcRemoveBot(String(params.label ?? "")),
      "bots.default": async (params) => {
        this.registry = await setDefaultDiscordBot(String(params.label ?? ""));
        return publicDiscordRegistry(this.registry);
      },
      "bots.enable": async (params) => {
        const label = String(params.label ?? "");
        this.registry = await setDiscordBotEnabled(label, true);
        await this.startBot(label);
        return publicDiscordRegistry(this.registry);
      },
      "bots.disable": async (params) => {
        const label = String(params.label ?? "");
        this.registry = await setDiscordBotEnabled(label, false);
        const handle = this.handles.get(label);
        if (handle) {
          await handle.gateway.stop();
          this.handles.delete(label);
        }
        return publicDiscordRegistry(this.registry);
      },
      "bots.test": async (params) => {
        const label = String(params.label ?? this.registry.default);
        const bot = discordBotByLabel(this.registry, label);
        if (!bot) throw new Error("unknown Discord bot: " + label);
        const config = await readConfig();
        const me = await new DiscordApi({ token: bot.token, apiBase: config.discord.apiBase, label }).getMe();
        return { label, username: me.username, id: me.id, applicationId: bot.applicationId };
      },
      "discord.status": async () => this.status(),
      "discord.test": async () => {
        if (!this.users.owner) throw new Error("no owner configured");
        const bot = defaultDiscordBot(this.registry);
        if (!bot) throw new Error("no bot configured");
        const api = new DiscordApi({ token: bot.token, apiBase: (await readConfig()).discord.apiBase, label: bot.label });
        const dm = await api.createDM(this.users.owner);
        const message = await api.sendMessage(dm.id, { content: "dura test · " + new Date().toISOString(), allowed_mentions: { parse: [] } });
        return { messageId: message.id, bot: bot.label, channelId: dm.id };
      },
      "discord.invite": async (params) => {
        const bot = discordBotByLabel(this.registry, String(params.label ?? this.registry.default)) ?? defaultDiscordBot(this.registry);
        if (!bot) throw new Error("no bot configured");
        return { url: inviteUrl(bot.applicationId), applicationId: bot.applicationId };
      },
      "discord.commands": async (params) => {
        const bot = discordBotByLabel(this.registry, String(params.label ?? this.registry.default)) ?? defaultDiscordBot(this.registry);
        if (!bot) throw new Error("no bot configured");
        const handle = this.handles.get(bot.label);
        const api = handle?.api ?? new DiscordApi({ token: bot.token, apiBase: (await readConfig()).discord.apiBase, label: bot.label });
        return syncDiscordCommands(api, bot.applicationId);
      },
      "discord.threads": async (params) => {
        const bot = defaultDiscordBot(this.registry);
        if (!bot) throw new Error("no bot configured");
        const guildId = String(params.guildId ?? "");
        if (!guildId) throw new Error("guildId is required");
        const api = new DiscordApi({ token: bot.token, apiBase: (await readConfig()).discord.apiBase, label: bot.label });
        const threads = await api.listActiveThreads(guildId);
        return threads.map((thread) => ({ id: thread.id, name: thread.name, parentId: thread.parent_id, archived: thread.thread_metadata?.archived ?? false }));
      },
      "discord.mod": async (params) => {
        const bot = defaultDiscordBot(this.registry);
        if (!bot) throw new Error("no bot configured");
        const action = String(params.action ?? "") as ModerationInput["action"];
        if (!["timeout", "kick", "ban", "unban", "warn"].includes(action)) throw new Error("action must be timeout, kick, ban, unban or warn");
        const api = new DiscordApi({ token: bot.token, apiBase: (await readConfig()).discord.apiBase, label: bot.label });
        return moderate(api, {
          action,
          guildId: String(params.guildId ?? ""),
          userId: String(params.userId ?? ""),
          moderatorId: "cli",
          botId: bot.botId,
          reason: String(params.reason ?? ""),
          ...(params.minutes !== undefined ? { minutes: Number(params.minutes) } : {}),
          ...(params.deleteDays !== undefined ? { deleteDays: Number(params.deleteDays) } : {}),
        });
      },
    };
  }

  private async ipcAddBot(params: Record<string, unknown>): Promise<unknown> {
    const token = String(params.token ?? "");
    const label = params.label ? String(params.label) : undefined;
    const result = await this.connectBotToken({ token, ...(label ? { label } : {}) });
    const agent = params.agent ? String(params.agent) : undefined;
    if (agent) {
      if (!(await readAgent(agent))) throw new Error("unknown agent: " + agent);
      this.registry = await setDiscordBotDefaultAgent(result.label, agent);
    }
    return { ...result, agent: agent ?? null };
  }

  private async ipcRemoveBot(label: string): Promise<unknown> {
    const handle = this.handles.get(label);
    if (handle) {
      await handle.gateway.stop();
      this.handles.delete(label);
    }
    this.registry = await removeDiscordBot(label);
    return publicDiscordRegistry(this.registry);
  }
}

