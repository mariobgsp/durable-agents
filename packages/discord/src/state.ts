import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { discordStatePath } from "../../core/src/paths.ts";

/**
 * Per-bot runtime state: the gateway session and seq, health, chat bindings and the last message
 * per session. One file, one owner (the daemon), written atomically.
 */
export type DiscordBinding = {
  kind: "dm" | "channel" | "thread" | "group";
  agentId?: string;
  sessionId?: string;
  speakerBot?: string;
  guildId?: string;
  channelId: string;
  parentId?: string;
  threadId?: string;
};

export type DiscordHealth = {
  ok: boolean;
  checkedAt: number;
  lastError?: string;
  username?: string;
  state: "stopped" | "connecting" | "ready";
};

export type DiscordBotState = {
  sessionId?: string;
  seq: number;
  resumeUrl?: string;
  health: DiscordHealth;
  bindings: Record<string, DiscordBinding>;
};

export type DiscordState = { bots: Record<string, DiscordBotState> };

export function emptyDiscordBotState(): DiscordBotState {
  return { seq: 0, health: { ok: false, checkedAt: 0, state: "stopped" }, bindings: {} };
}

export async function loadDiscordState(): Promise<DiscordState> {
  try {
    const parsed = JSON.parse(await readFile(discordStatePath, "utf8")) as Partial<DiscordState>;
    const bots: Record<string, DiscordBotState> = {};
    for (const [label, state] of Object.entries(parsed.bots ?? {})) {
      if (!state || typeof state !== "object") continue;
      const health = state.health ?? { ok: false, checkedAt: 0, state: "stopped" };
      bots[label] = {
        ...(typeof state.sessionId === "string" ? { sessionId: state.sessionId } : {}),
        seq: Number.isFinite(state.seq) ? Number(state.seq) : 0,
        ...(typeof state.resumeUrl === "string" ? { resumeUrl: state.resumeUrl } : {}),
        health: {
          ok: Boolean(health.ok),
          checkedAt: Number(health.checkedAt ?? 0),
          state: health.state === "ready" || health.state === "connecting" ? health.state : "stopped",
          ...(health.lastError ? { lastError: String(health.lastError) } : {}),
          ...(health.username ? { username: String(health.username) } : {}),
        },
        bindings: typeof state.bindings === "object" && state.bindings ? state.bindings : {},
      };
    }
    return { bots };
  } catch {
    return { bots: {} };
  }
}

export async function saveDiscordState(state: DiscordState): Promise<void> {
  await mkdir(dirname(discordStatePath), { recursive: true, mode: 0o700 });
  const tmp = discordStatePath + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, discordStatePath);
}

export function discordStateFor(state: DiscordState, label: string): DiscordBotState {
  state.bots[label] ??= emptyDiscordBotState();
  return state.bots[label];
}

/** DMs are keyed by user; guild conversations by channel or thread. */
export function discordBindingKey(input: { guildId?: string; channelId: string; userId?: string; dm?: boolean }): string {
  if (input.dm) return "dm:" + (input.userId ?? input.channelId);
  return (input.guildId ?? "guild") + ":" + input.channelId;
}

/**
 * One writer for the file.
 *
 * The mutators below are the only writers, so two of them next to each other cannot interleave two writes of
 * the same file and a burst costs one write. A caller that needs its change on disk awaits the promise.
 */
let writing: Promise<void> = Promise.resolve();
let scheduled = false;

function scheduleSave(state: DiscordState): Promise<void> {
  if (!scheduled) {
    scheduled = true;
    writing = writing
      .then(async () => {
        scheduled = false;
        await saveDiscordState(state);
      })
      .catch(() => undefined);
  }
  return writing;
}

/** Wait for every scheduled write to land. */
export function flushDiscordState(): Promise<void> {
  return writing;
}

/** Write what the state holds now, through the one queue. */
export function persistDiscordState(state: DiscordState): Promise<void> {
  return scheduleSave(state);
}

export async function setDiscordBinding(state: DiscordState, label: string, key: string, binding: DiscordBinding): Promise<void> {
  discordStateFor(state, label).bindings[key] = binding;
  await scheduleSave(state);
}

export async function getDiscordBinding(state: DiscordState, label: string, key: string): Promise<DiscordBinding | undefined> {
  return discordStateFor(state, label).bindings[key];
}

export async function deleteDiscordBinding(state: DiscordState, label: string, key: string): Promise<void> {
  delete discordStateFor(state, label).bindings[key];
  await scheduleSave(state);
}

export async function setDiscordHealth(state: DiscordState, label: string, health: DiscordHealth): Promise<void> {
  discordStateFor(state, label).health = health;
  await scheduleSave(state);
}
