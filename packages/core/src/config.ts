import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { configPath, duraHome } from "./paths.ts";
import type { ThinkingLevel } from "./agents.ts";

/**
 * The one configuration file. It holds no secrets: provider keys live in credentials.json and bot
 * tokens in secrets/telegram.json or secrets/discord.json, both mode 0600. Everything here is safe to print.
 *
 * Writes are temp-file + rename so a crash cannot leave a half-written config, and unknown keys are
 * preserved so a newer build's field is not deleted by an older one.
 */

export type ModelRef = { provider: string; modelId: string };

export type Limits = {
  maxConcurrentRuns: number;
  queuedRuns: number;
  maxAgents: number;
  maxBots: number;
  codemodeMemoryMb: number;
  browserIdleMinutes: number;
};

export type TelegramConfig = {
  apiBase: string;
  defaultBot: string;
  allowGroups: boolean;
  topics: boolean;
  editIntervalMs: number;
  broadcastBoot: boolean;
  notifyOnAgentDocChange: boolean;
  askBotOnAgentCreate: boolean;
};

/** The one chat surface a daemon starts. Telegram and Discord are deliberately exclusive. */
export type ChatPlatform = "telegram" | "discord";

export const CHAT_PLATFORMS: readonly ChatPlatform[] = ["telegram", "discord"];

export function isChatPlatform(value: unknown): value is ChatPlatform {
  return value === "telegram" || value === "discord";
}

export type DiscordConfig = {
  apiBase: string;
  gatewayUrl: string;
  defaultBot: string;
  /** Refuse guild channels entirely; DMs still work. */
  allowGuilds: boolean;
  /** In an unbound guild channel, answer only to commands and @mentions. */
  requireMention: boolean;
  editIntervalMs: number;
  /** Fallback notification target when the owner cannot be DM'd. */
  ownerChannelId: string | null;
  /** Install the agent-facing discord tool while Discord is active. */
  agentTools: boolean;
  moderation: {
    auditChannelId: string | null;
    dmTargets: boolean;
    /** Allow agents to call the destructive moderate action. */
    agentTools: boolean;
  };
};

export type SetupState = {
  completed: string[];
  verifiedAt: number | null;
};

export type DuraConfig = {
  version: 1;
  orchestrator: { agentId: string | null };
  models: { registered: string[]; default: ModelRef };
  defaults: {
    cwd: string;
    permissions: "standard" | "custom" | "full";
    telegramBot: string;
    tools: string[];
    /**
     * Reasoning effort every agent inherits, whatever model it runs.
     *
     * It is one setting rather than a per-model table because the level names are shared: a model that does
     * not support a level clamps it in the provider, so "xhigh" on a model with only low/medium/high is a
     * request the provider narrows, not an error the daemon has to pre-empt.
     */
    thinkingLevel: ThinkingLevel;
  };
  limits: Limits;
  /** Exactly one chat surface is active; the other platform's config stays on disk but is not started. */
  chat: { active: ChatPlatform };
  telegram: TelegramConfig;
  discord: DiscordConfig;
  storage: { auto: boolean; pruneAfterDays: number; purgeAfterDays: number; intervalHours: number };
  logging: { level: "debug" | "info" | "warn" | "error"; maxBytes: number; keep: number };
  service: { systemd: boolean };
  tui: { allowCreate: boolean };
  setup: SetupState;
};

export const DEFAULT_TOOLS = [
  "read", "write", "edit", "bash", "terminal", "coding", "codemode",
  "browser", "vault", "question", "discord",
  "create_file", "create_pdf", "publish_file",
];

export function defaultConfig(): DuraConfig {
  return {
    version: 1,
    orchestrator: { agentId: null },
    models: {
      registered: ["opencode-go"],
      default: {
        provider: process.env.DURA_DEFAULT_PROVIDER ?? "opencode-go",
        modelId: process.env.DURA_DEFAULT_MODEL ?? "deepseek-v4.1-flash",
      },
    },
    defaults: {
      cwd: "~",
      permissions: "full",
      telegramBot: "main",
      tools: [...DEFAULT_TOOLS],
      thinkingLevel: "medium",
    },
    limits: {
      maxConcurrentRuns: 5,
      queuedRuns: 20,
      maxAgents: 25,
      maxBots: 10,
      codemodeMemoryMb: 128,
      browserIdleMinutes: 5,
    },
    chat: { active: "telegram" },
    telegram: {
      apiBase: process.env.DURA_TELEGRAM_API_BASE ?? "https://api.telegram.org",
      defaultBot: "main",
      allowGroups: true,
      topics: true,
      editIntervalMs: 1500,
      broadcastBoot: true,
      notifyOnAgentDocChange: true,
      askBotOnAgentCreate: true,
    },
    discord: {
      apiBase: process.env.DURA_DISCORD_API_BASE ?? "https://discord.com/api/v10",
      gatewayUrl: process.env.DURA_DISCORD_GATEWAY_URL ?? "wss://gateway.discord.gg",
      defaultBot: "main",
      allowGuilds: true,
      requireMention: true,
      editIntervalMs: 2500,
      ownerChannelId: null,
      agentTools: true,
      moderation: { auditChannelId: null, dmTargets: true, agentTools: false },
    },
    logging: { level: "info", maxBytes: 5 * 1024 * 1024, keep: 3 },
    storage: { auto: true, pruneAfterDays: 3, purgeAfterDays: 3, intervalHours: 6 },
    service: { systemd: true },
    tui: { allowCreate: true },
    setup: { completed: [], verifiedAt: null },
  };
}

export class ConfigError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.path = path;
  }
}

/** Expand a leading ~ against the current user's home. */
export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge a saved object over the defaults, recursively, so a new field always has a value. */
function merge(base: unknown, saved: unknown): unknown {
  if (!isObject(base) || !isObject(saved)) return saved ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(saved)) {
    const current = out[key];
    out[key] = isObject(current) && isObject(value) ? merge(current, value) : value;
  }
  return out;
}

let cached: DuraConfig | undefined;
let cachedAt = 0;

/** Read the config, creating it with defaults on first use. Throws ConfigError on malformed JSON. */
export async function readConfig(options: { fresh?: boolean } = {}): Promise<DuraConfig> {
  if (!options.fresh && cached && Date.now() - cachedAt < 1000) return cached;
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    const created = defaultConfig();
    await writeConfig(created);
    return created;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(configPath, "cannot parse " + configPath + ": " + String(error));
  }
  if (!isObject(parsed)) throw new ConfigError(configPath, configPath + " must contain a JSON object");
  const merged = merge(defaultConfig(), parsed) as DuraConfig;
  merged.version = 1;
  merged.setup ??= { completed: [], verifiedAt: null };
  merged.setup.completed ??= [];
  // A hand-edited file may have lost a section; restore the shape without overriding a bad active value
  // (validateConfig reports that, so the operator can still read the file to fix it).
  merged.chat ??= { active: "telegram" };
  merged.discord ??= defaultConfig().discord;
  merged.discord.moderation ??= defaultConfig().discord.moderation;
  cached = merged;
  cachedAt = Date.now();
  return merged;
}

/** Write the whole config atomically (0600). */
export async function writeConfig(config: DuraConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const tmp = configPath + ".tmp";
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, configPath);
  cached = config;
  cachedAt = Date.now();
}

export type ConfigPatch = {
  orchestrator?: Partial<DuraConfig["orchestrator"]>;
  models?: Partial<DuraConfig["models"]>;
  defaults?: Partial<DuraConfig["defaults"]>;
  limits?: Partial<DuraConfig["limits"]>;
  chat?: Partial<DuraConfig["chat"]>;
  telegram?: Partial<DuraConfig["telegram"]>;
  discord?: Partial<DuraConfig["discord"]> & {
    moderation?: Partial<DuraConfig["discord"]["moderation"]>;
  };
  logging?: Partial<DuraConfig["logging"]>;
  storage?: Partial<DuraConfig["storage"]>;
  service?: Partial<DuraConfig["service"]>;
  tui?: Partial<DuraConfig["tui"]>;
  setup?: Partial<DuraConfig["setup"]>;
};

/** Patch one or more sections and save. Returns the new config. */
export async function updateConfig(patch: ConfigPatch): Promise<DuraConfig> {
  const current = await readConfig({ fresh: true });
  const next: DuraConfig = {
    ...current,
    orchestrator: { ...current.orchestrator, ...(patch.orchestrator ?? {}) },
    models: { ...current.models, ...(patch.models ?? {}) },
    defaults: { ...current.defaults, ...(patch.defaults ?? {}) },
    limits: { ...current.limits, ...(patch.limits ?? {}) },
    chat: { ...current.chat, ...(patch.chat ?? {}) },
    telegram: { ...current.telegram, ...(patch.telegram ?? {}) },
    discord: {
      ...current.discord,
      ...(patch.discord ?? {}),
      moderation: { ...current.discord.moderation, ...(patch.discord?.moderation ?? {}) },
    },
    logging: { ...current.logging, ...(patch.logging ?? {}) },
    storage: { ...current.storage, ...(patch.storage ?? {}) },
    service: { ...current.service, ...(patch.service ?? {}) },
    tui: { ...current.tui, ...(patch.tui ?? {}) },
    setup: { ...current.setup, ...(patch.setup ?? {}) },
  };
  await writeConfig(next);
  return next;
}

/** Mark one wizard step complete (idempotent). */
export async function completeStep(step: string): Promise<DuraConfig> {
  const current = await readConfig({ fresh: true });
  if (current.setup.completed.includes(step)) return current;
  return updateConfig({
    setup: { completed: [...current.setup.completed, step], verifiedAt: current.setup.verifiedAt },
  });
}

/** Forget one wizard step so the wizard runs it again. */
export async function resetStep(step: string): Promise<DuraConfig> {
  const current = await readConfig({ fresh: true });
  return updateConfig({
    setup: {
      completed: current.setup.completed.filter((entry) => entry !== step),
      verifiedAt: current.setup.verifiedAt,
    },
  });
}

export function isComplete(config: DuraConfig, step: string): boolean {
  return config.setup.completed.includes(step);
}

/** The configured home, resolved for display. */
export function home(): string {
  return duraHome;
}

/** Resolve the default working directory (a leading ~ is expanded). */
export function defaultCwd(config: DuraConfig): string {
  return expandHome(config.defaults.cwd);
}

/** The completion key for one chat surface. Telegram's legacy key is still accepted when it is active. */
export function surfaceStep(platform: ChatPlatform): string {
  return "chat:" + platform;
}

export function isSurfaceComplete(config: DuraConfig, platform: ChatPlatform): boolean {
  if (config.setup.completed.includes(surfaceStep(platform))) return true;
  return platform === "telegram" && config.setup.completed.includes("telegram");
}

/** The platform the daemon should start. Always exactly one. */
export function activeChatPlatform(config: DuraConfig): ChatPlatform {
  return config.chat.active;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function urlProblem(value: string, protocols: readonly string[], label: string, allowLoopbackWs = false): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return label + " is not a valid URL: " + value;
  }
  if (!protocols.includes(parsed.protocol)) {
    return label + " must use " + protocols.join(" or ") + ": " + value;
  }
  if (allowLoopbackWs && parsed.protocol === "ws:" && !isLoopbackHost(parsed.hostname)) {
    return label + " must use wss:// outside loopback tests: " + value;
  }
  return undefined;
}

/**
 * Structural validation for the settings that select a transport. Kept separate from readConfig so a
 * broken edit can still be inspected with `dura config get`, while start/verify refuse to run on it.
 */
export function validateConfig(config: DuraConfig): string[] {
  const problems: string[] = [];
  if (!isChatPlatform(config.chat?.active)) {
    problems.push("chat.active must be telegram or discord (got " + JSON.stringify(config.chat?.active) + ")");
  }
  const discord = config.discord;
  if (!discord || typeof discord !== "object") {
    problems.push("discord must be an object");
    return problems;
  }
  const api = urlProblem(discord.apiBase, ["http:", "https:"], "discord.apiBase");
  if (api) problems.push(api);
  const gateway = urlProblem(discord.gatewayUrl, ["ws:", "wss:"], "discord.gatewayUrl", true);
  if (gateway) problems.push(gateway);
  if (!Number.isFinite(discord.editIntervalMs) || discord.editIntervalMs <= 0) {
    problems.push("discord.editIntervalMs must be a positive number");
  }
  for (const [key, value] of Object.entries(config.limits ?? {})) {
    if (!Number.isFinite(value) || value <= 0) problems.push("limits." + key + " must be a positive number");
  }
  if (!Array.isArray(config.setup?.completed)) problems.push("setup.completed must be an array");
  return problems;
}
