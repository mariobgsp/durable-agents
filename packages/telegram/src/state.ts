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

export type BotState = {
  offset: number;
  health: Health;
  chats: Record<string, ChatBinding>;
  lastMessages: Record<string, { sessionId: string; at: number }>;
};

export type TgState = { bots: Record<string, BotState> };

const MESSAGE_HISTORY = 200;

export function emptyBotState(): BotState {
  return { offset: 0, health: { ok: false, checkedAt: 0 }, chats: {}, lastMessages: {} };
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
