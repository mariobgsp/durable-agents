import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { configPath, duraHome } from "./paths.ts";

/**
 * The one configuration file. It holds no secrets: provider keys live in credentials.json and bot
 * tokens in secrets/telegram.json, both mode 0600. Everything here is safe to print.
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
  };
  limits: Limits;
  telegram: TelegramConfig;
  storage: { auto: boolean; pruneAfterDays: number; purgeAfterDays: number; intervalHours: number };
  logging: { level: "debug" | "info" | "warn" | "error"; maxBytes: number; keep: number };
  service: { systemd: boolean };
  tui: { allowCreate: boolean };
  setup: SetupState;
};

export const DEFAULT_TOOLS = [
  "read", "write", "edit", "bash", "terminal", "coding", "codemode",
  "browser", "vault", "question",
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
    },
    limits: {
      maxConcurrentRuns: 5,
      queuedRuns: 20,
      maxAgents: 25,
      maxBots: 10,
      codemodeMemoryMb: 128,
      browserIdleMinutes: 5,
    },
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
  telegram?: Partial<DuraConfig["telegram"]>;
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
    telegram: { ...current.telegram, ...(patch.telegram ?? {}) },
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
