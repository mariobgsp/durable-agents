import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { discordBotsPath } from "../../core/src/paths.ts";

/**
 * The Discord bot registry. A token is the only secret here; every public read masks it.
 *
 * Unlike Telegram, a Discord bot is a connection to the fleet, not an agent's private bot. The optional
 * defaultAgent is where DMs and unbound threads go; a thread can override it with /agent.
 */
export type DiscordBotRecord = {
  label: string;
  token: string;
  applicationId: string;
  botId: string;
  username: string;
  enabled: boolean;
  defaultAgent?: string;
};

export type DiscordRegistry = {
  version: 1;
  default: string;
  bots: DiscordBotRecord[];
};

export class DiscordRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordRegistryError";
  }
}

export function validDiscordLabel(label: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(label);
}

export function maskDiscordToken(token: string): string {
  if (token.length <= 12) return "***";
  return token.slice(0, 5) + "…" + token.slice(-4);
}

export async function loadDiscordRegistry(): Promise<DiscordRegistry> {
  try {
    const parsed = JSON.parse(await readFile(discordBotsPath, "utf8")) as Partial<DiscordRegistry>;
    return {
      version: 1,
      default: typeof parsed.default === "string" ? parsed.default : "",
      bots: Array.isArray(parsed.bots)
        ? parsed.bots.filter(
            (bot): bot is DiscordBotRecord =>
              Boolean(bot) &&
              typeof bot.label === "string" &&
              typeof bot.token === "string" &&
              typeof bot.applicationId === "string" &&
              typeof bot.botId === "string" &&
              typeof bot.username === "string",
          ).map((bot) => ({ ...bot, enabled: bot.enabled !== false }))
        : [],
    };
  } catch {
    return { version: 1, default: "", bots: [] };
  }
}

export async function saveDiscordRegistry(registry: DiscordRegistry): Promise<void> {
  await mkdir(dirname(discordBotsPath), { recursive: true, mode: 0o700 });
  const tmp = discordBotsPath + ".tmp";
  await writeFile(tmp, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, discordBotsPath);
}

export function discordBotByLabel(registry: DiscordRegistry, label: string): DiscordBotRecord | undefined {
  return registry.bots.find((bot) => bot.label === label);
}

export function defaultDiscordBot(registry: DiscordRegistry): DiscordBotRecord | undefined {
  return discordBotByLabel(registry, registry.default) ?? registry.bots[0];
}

export async function addDiscordBot(record: Omit<DiscordBotRecord, "enabled"> & { enabled?: boolean }): Promise<DiscordRegistry> {
  const registry = await loadDiscordRegistry();
  if (!validDiscordLabel(record.label)) throw new DiscordRegistryError("label must be lower-case letters, digits and dashes (max 32)");
  if (registry.bots.some((bot) => bot.label === record.label)) throw new DiscordRegistryError("a bot labelled " + record.label + " already exists");
  if (registry.bots.some((bot) => bot.token === record.token)) throw new DiscordRegistryError("this token is already registered under another label");
  registry.bots.push({ ...record, enabled: record.enabled ?? true });
  if (!registry.default) registry.default = record.label;
  await saveDiscordRegistry(registry);
  return registry;
}

export async function removeDiscordBot(label: string): Promise<DiscordRegistry> {
  const registry = await loadDiscordRegistry();
  if (!discordBotByLabel(registry, label)) throw new DiscordRegistryError("no bot labelled " + label);
  registry.bots = registry.bots.filter((bot) => bot.label !== label);
  if (registry.default === label) registry.default = registry.bots[0]?.label ?? "";
  await saveDiscordRegistry(registry);
  return registry;
}

export async function setDefaultDiscordBot(label: string): Promise<DiscordRegistry> {
  const registry = await loadDiscordRegistry();
  if (!discordBotByLabel(registry, label)) throw new DiscordRegistryError("no bot labelled " + label);
  registry.default = label;
  await saveDiscordRegistry(registry);
  return registry;
}

export async function setDiscordBotEnabled(label: string, enabled: boolean): Promise<DiscordRegistry> {
  const registry = await loadDiscordRegistry();
  const bot = discordBotByLabel(registry, label);
  if (!bot) throw new DiscordRegistryError("no bot labelled " + label);
  bot.enabled = enabled;
  await saveDiscordRegistry(registry);
  return registry;
}

export async function setDiscordBotDefaultAgent(label: string, agentId: string | null): Promise<DiscordRegistry> {
  const registry = await loadDiscordRegistry();
  const bot = discordBotByLabel(registry, label);
  if (!bot) throw new DiscordRegistryError("no bot labelled " + label);
  if (agentId) bot.defaultAgent = agentId;
  else delete bot.defaultAgent;
  await saveDiscordRegistry(registry);
  return registry;
}

export async function updateDiscordBotIdentity(
  label: string,
  identity: { applicationId: string; botId: string; username: string },
): Promise<DiscordRegistry> {
  const registry = await loadDiscordRegistry();
  const bot = discordBotByLabel(registry, label);
  if (!bot) throw new DiscordRegistryError("no bot labelled " + label);
  bot.applicationId = identity.applicationId;
  bot.botId = identity.botId;
  bot.username = identity.username;
  await saveDiscordRegistry(registry);
  return registry;
}

export function publicDiscordRegistry(registry: DiscordRegistry): Omit<DiscordRegistry, "bots"> & {
  bots: Omit<DiscordBotRecord, "token">[];
} {
  return {
    version: 1,
    default: registry.default,
    bots: registry.bots.map((bot) => ({
      label: bot.label,
      applicationId: bot.applicationId,
      botId: bot.botId,
      username: bot.username,
      enabled: bot.enabled,
      ...(bot.defaultAgent ? { defaultAgent: bot.defaultAgent } : {}),
    })),
  };
}
