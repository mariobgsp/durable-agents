import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { telegramBotsPath } from "../../core/src/paths.ts";

/**
 * The bot registry: labels, tokens, identity. Tokens live only here (0600); every read path that
 * faces a person or a log masks them. Removing a bot that an agent still names is refused by the
 * admin service, not silently reassigned.
 */
export type BotRecord = {
  label: string;
  token: string;
  botId: string;
  username: string;
  enabled: boolean;
};

export type BotRegistry = {
  version: 1;
  default: string;
  bots: BotRecord[];
};

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export function validLabel(label: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(label);
}

export function maskToken(token: string): string {
  if (token.length <= 10) return "***";
  return token.slice(0, 4) + "…" + token.slice(-4);
}

export async function loadRegistry(): Promise<BotRegistry> {
  try {
    const parsed = JSON.parse(await readFile(telegramBotsPath, "utf8")) as Partial<BotRegistry>;
    return {
      version: 1,
      default: typeof parsed.default === "string" ? parsed.default : "",
      bots: Array.isArray(parsed.bots)
        ? parsed.bots.filter(
            (bot): bot is BotRecord =>
              Boolean(bot) &&
              typeof bot.label === "string" &&
              typeof bot.token === "string" &&
              typeof bot.botId === "string" &&
              typeof bot.username === "string",
          )
        : [],
    };
  } catch {
    return { version: 1, default: "", bots: [] };
  }
}

export async function saveRegistry(registry: BotRegistry): Promise<void> {
  await mkdir(dirname(telegramBotsPath), { recursive: true, mode: 0o700 });
  const tmp = telegramBotsPath + ".tmp";
  await writeFile(tmp, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, telegramBotsPath);
}

export function botByLabel(registry: BotRegistry, label: string): BotRecord | undefined {
  return registry.bots.find((bot) => bot.label === label);
}

export function defaultBot(registry: BotRegistry): BotRecord | undefined {
  return botByLabel(registry, registry.default) ?? registry.bots[0];
}

export async function addBot(record: Omit<BotRecord, "enabled"> & { enabled?: boolean }): Promise<BotRegistry> {
  const registry = await loadRegistry();
  if (!validLabel(record.label)) throw new RegistryError("label must be lower-case letters, digits and dashes (max 32)");
  if (registry.bots.some((bot) => bot.label === record.label)) throw new RegistryError("a bot labelled " + record.label + " already exists");
  if (registry.bots.some((bot) => bot.token === record.token)) throw new RegistryError("this token is already registered under another label");
  registry.bots.push({ ...record, enabled: record.enabled ?? true });
  if (!registry.default) registry.default = record.label;
  await saveRegistry(registry);
  return registry;
}

export async function removeBot(label: string): Promise<BotRegistry> {
  const registry = await loadRegistry();
  if (!botByLabel(registry, label)) throw new RegistryError("no bot labelled " + label);
  registry.bots = registry.bots.filter((bot) => bot.label !== label);
  if (registry.default === label) registry.default = registry.bots[0]?.label ?? "";
  await saveRegistry(registry);
  return registry;
}

export async function setDefaultBot(label: string): Promise<BotRegistry> {
  const registry = await loadRegistry();
  if (!botByLabel(registry, label)) throw new RegistryError("no bot labelled " + label);
  registry.default = label;
  await saveRegistry(registry);
  return registry;
}

export async function setBotEnabled(label: string, enabled: boolean): Promise<BotRegistry> {
  const registry = await loadRegistry();
  const bot = botByLabel(registry, label);
  if (!bot) throw new RegistryError("no bot labelled " + label);
  bot.enabled = enabled;
  await saveRegistry(registry);
  return registry;
}

export async function updateBotIdentity(label: string, identity: { botId: string; username: string }): Promise<BotRegistry> {
  const registry = await loadRegistry();
  const bot = botByLabel(registry, label);
  if (!bot) throw new RegistryError("no bot labelled " + label);
  bot.botId = identity.botId;
  bot.username = identity.username;
  await saveRegistry(registry);
  return registry;
}

/** The registry without tokens, for status output and IPC. */
export function publicRegistry(registry: BotRegistry): Omit<BotRegistry, "bots"> & {
  bots: Omit<BotRecord, "token">[];
} {
  return {
    version: 1,
    default: registry.default,
    bots: registry.bots.map((bot) => ({
      label: bot.label,
      botId: bot.botId,
      username: bot.username,
      enabled: bot.enabled,
    })),
  };
}
