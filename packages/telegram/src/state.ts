import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { telegramStatePath } from "../../core/src/paths.ts";

/**
 * Per-bot runtime state: the getUpdates offset, poll health, chat bindings and the last bot message
 * per session (so a reply routes to the right thread and an edit can be repaired after a restart).
 * One file, one owner (the poller process), written atomically after each handled batch.
 */
export type ChatBinding = {
  kind: "dm" | "topic" | "group";
  agentId?: string;
  sessionId?: string;
  speakerBot?: string;
  topicId?: number;
};

export type Health = { ok: boolean; checkedAt: number; lastError?: string; username?: string };

/**
 * A run whose answer has not reached its chat yet.
 *
 * Written before the wait starts and cleared only after delivery, because the promise outlives the process:
 * pi-durable reschedules an interrupted run after a restart, and without this record the answer would land
 * in the transcript with nobody left to deliver it — the bubble keeps saying "planning the next step" and
 * the owner is told nothing, which is exactly the "it looks stuck" failure.
 */
export type PendingDelivery = {
  sessionId: string;
  chatId: number;
  threadId?: number;
  placeholderId: number;
  /** Transcript length before the run began: the answer is whatever comes after this index. */
  before: number;
  agentId: string;
  submissionId: string;
  startedAt: number;
};

/**
 * A message that says "the service is going" and is still waiting for the "it is back" edit.
 *
 * Kept on disk because the process that sends it is the one that dies: without this the next process knows the
 * bot went quiet but not where to say that it came back.
 */
export type RestartNoticeRecord = {
  chatId: number;
  threadId?: number;
  messageId: number;
  at: number;
  cause: string;
};

export type BotState = {
  offset: number;
  health: Health;
  chats: Record<string, ChatBinding>;
  lastMessages: Record<string, { sessionId: string; at: number }>;
  /** One entry per unfinished run, keyed by session id. */
  pending: Record<string, PendingDelivery>;
  /** Goodbye messages still waiting for their "back" edit, keyed by chat key. */
  restarts: Record<string, RestartNoticeRecord>;
};

export type TgState = { bots: Record<string, BotState> };

const MESSAGE_HISTORY = 200;

export function emptyBotState(): BotState {
  return {
    offset: 0,
    health: { ok: false, checkedAt: 0 },
    chats: {},
    lastMessages: {},
    pending: {},
    restarts: {},
  };
}

function normalizeRestarts(value: unknown): Record<string, RestartNoticeRecord> {
  const out: Record<string, RestartNoticeRecord> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const entry = raw as Partial<RestartNoticeRecord> | null | undefined;
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.chatId !== "number" || typeof entry.messageId !== "number") continue;
    out[key] = {
      chatId: entry.chatId,
      ...(typeof entry.threadId === "number" ? { threadId: entry.threadId } : {}),
      messageId: entry.messageId,
      at: Number(entry.at ?? Date.now()),
      cause: typeof entry.cause === "string" ? entry.cause : "restart",
    };
  }
  return out;
}

/** Anything a half-written or older state file carries is dropped rather than trusted. */
function normalizePending(value: unknown): Record<string, PendingDelivery> {
  const out: Record<string, PendingDelivery> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const entry = raw as Partial<PendingDelivery> | null | undefined;
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.sessionId !== "string" || typeof entry.chatId !== "number") continue;
    out[key] = {
      sessionId: entry.sessionId,
      chatId: entry.chatId,
      ...(typeof entry.threadId === "number" ? { threadId: entry.threadId } : {}),
      placeholderId: Number(entry.placeholderId ?? 0),
      before: Number(entry.before ?? 0),
      agentId: typeof entry.agentId === "string" ? entry.agentId : "agent",
      submissionId: typeof entry.submissionId === "string" ? entry.submissionId : "",
      startedAt: Number(entry.startedAt ?? Date.now()),
    };
  }
  return out;
}

export async function loadState(): Promise<TgState> {
  try {
    const parsed = JSON.parse(await readFile(telegramStatePath, "utf8")) as Partial<TgState>;
    const bots: Record<string, BotState> = {};
    for (const [label, state] of Object.entries(parsed.bots ?? {})) {
      if (!state || typeof state !== "object") continue;
      bots[label] = {
        offset: typeof state.offset === "number" ? state.offset : 0,
        health: {
          ok: Boolean(state.health?.ok),
          checkedAt: Number(state.health?.checkedAt ?? 0),
          ...(state.health?.lastError ? { lastError: String(state.health.lastError) } : {}),
          ...(state.health?.username ? { username: String(state.health.username) } : {}),
        },
        chats: typeof state.chats === "object" && state.chats ? state.chats : {},
        lastMessages: typeof state.lastMessages === "object" && state.lastMessages ? state.lastMessages : {},
        pending: normalizePending(state.pending),
        restarts: normalizeRestarts(state.restarts),
      };
    }
    return { bots };
  } catch {
    return { bots: {} };
  }
}

export async function saveState(state: TgState): Promise<void> {
  await mkdir(dirname(telegramStatePath), { recursive: true, mode: 0o700 });
  const tmp = telegramStatePath + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, telegramStatePath);
}

export function stateFor(state: TgState, label: string): BotState {
  state.bots[label] ??= emptyBotState();
  return state.bots[label];
}

export function chatKey(chatId: number | string, topicId?: number): string {
  return topicId === undefined ? String(chatId) : String(chatId) + ":" + topicId;
}

export function getChat(state: TgState, label: string, key: string): ChatBinding | undefined {
  return stateFor(state, label).chats[key];
}

export async function setChat(state: TgState, label: string, key: string, binding: ChatBinding): Promise<void> {
  stateFor(state, label).chats[key] = binding;
  await saveState(state);
}

export async function deleteChat(state: TgState, label: string, key: string): Promise<void> {
  delete stateFor(state, label).chats[key];
  await saveState(state);
}

export async function setHealth(state: TgState, label: string, health: Health): Promise<void> {
  stateFor(state, label).health = health;
  await saveState(state);
}

/** Record an unfinished run. The caller persists the state; this only mutates it. */
export function setPending(state: TgState, label: string, value: PendingDelivery): void {
  stateFor(state, label).pending[value.sessionId] = value;
}

/** Forget a delivered run. Returns true when there was something to forget, so a caller can skip a write. */
export function clearPending(state: TgState, label: string, sessionId: string): boolean {
  const bot = stateFor(state, label);
  if (!bot.pending[sessionId]) return false;
  delete bot.pending[sessionId];
  return true;
}

export function pendingDeliveries(state: TgState, label: string): PendingDelivery[] {
  return Object.values(stateFor(state, label).pending);
}

/** Remember where the goodbye went, so the process that comes back can turn it into "back after Ns". */
export function setRestartNotice(state: TgState, label: string, key: string, value: RestartNoticeRecord): void {
  stateFor(state, label).restarts[key] = value;
}

export function restartNotices(state: TgState, label: string): [string, RestartNoticeRecord][] {
  return Object.entries(stateFor(state, label).restarts);
}

export function clearRestartNotice(state: TgState, label: string, key: string): boolean {
  const bot = stateFor(state, label);
  if (!bot.restarts[key]) return false;
  delete bot.restarts[key];
  return true;
}

export function rememberMessage(state: TgState, label: string, chatId: number | string, messageId: number, sessionId: string): void {
  const bot = stateFor(state, label);
  const key = String(chatId) + ":" + messageId;
  bot.lastMessages[key] = { sessionId, at: Date.now() };
  const keys = Object.keys(bot.lastMessages);
  if (keys.length > MESSAGE_HISTORY) {
    for (const old of keys.slice(0, keys.length - MESSAGE_HISTORY)) delete bot.lastMessages[old];
  }
}

export function sessionForMessage(state: TgState, label: string, chatId: number | string, messageId: number): string | undefined {
  return stateFor(state, label).lastMessages[String(chatId) + ":" + messageId]?.sessionId;
}
