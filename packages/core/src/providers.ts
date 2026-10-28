import { createRequire } from "node:module";
import { listAgents } from "./agents.ts";
import { models, setApiKey, clearApiKey } from "./models.ts";

/**
 * The provider catalog and lazy registration.
 *
 * pi-ai ships a generated catalog of every built-in provider (42 at this version). Importing the
 * whole catalog belongs to the short-lived CLI: the daemon must only load the modules it is actually
 * configured to use, or the startup cost becomes the memory budget's problem.
 *
 * A provider module exports a factory whose name ends in "Provider" (openaiProvider, groqProvider,
 * opencodeGoProvider). That convention is what makes one registration path serve all of them.
 */

export const KEY_ONLY_PROVIDERS = new Set([
  "opencode-go",
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "openrouter",
  "groq",
  "mistral",
  "xai",
  "nvidia",
  "cerebras",
  "fireworks",
  "together",
  "baseten",
  "huggingface",
  "minimax",
  "minimax-cn",
  "moonshotai",
  "moonshotai-cn",
  "zai",
  "zai-coding-cn",
  "kimi-coding",
  "ant-ling",
  "meta",
  "xiaomi",
  "opencode",
]);

/** Providers that need more than a key (endpoint, region, role, OAuth). Listed, not half-configured. */
export const EXTRA_CONFIG_PROVIDERS = new Set([
  "amazon-bedrock",
  "azure",
  "google-vertex",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "github-copilot",
  "openai-codex",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "radius",
  "typesafe",
  "vercel-ai-gateway",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
]);

const require = createRequire(import.meta.url);
const registered = new Set<string>(["opencode-go", "openai", "anthropic", "google", "deepseek", "openrouter"]);

/** The full built-in catalog. CLI-only: it imports the generated model data. */
export async function builtinProviderIds(): Promise<string[]> {
  try {
    const module = (await import("@earendil-works/pi-ai/providers/all")) as { getBuiltinProviders(): string[] };
    return module.getBuiltinProviders();
  } catch {
    return [...new Set([...registered, ...KEY_ONLY_PROVIDERS, ...EXTRA_CONFIG_PROVIDERS])].sort();
  }
}

/** Register one built-in provider module in this process. Idempotent. */
export function registerProvider(id: string): void {
  if (registered.has(id)) return;
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("invalid provider id: " + id);
  const specifier = "@earendil-works/pi-ai/providers/" + id;
  let module: Record<string, unknown>;
  try {
    module = require(specifier) as Record<string, unknown>;
  } catch (error) {
    throw new Error("provider module " + id + " is not available: " + String(error));
  }
  const factoryName = Object.keys(module).find(
    (key) => key.endsWith("Provider") && typeof module[key] === "function",
  );
  if (!factoryName) throw new Error("provider module " + id + " exports no Provider factory");
  const factory = module[factoryName] as () => unknown;
  models.setProvider(factory() as never);
  registered.add(id);
}

export function isRegistered(id: string): boolean {
  return registered.has(id);
}

export type ProviderRow = {
  id: string;
  configured: boolean;
  source: string | null;
  models: number;
  keyOnly: boolean;
  registered: boolean;
};

export async function providerRows(ids: string[]): Promise<ProviderRow[]> {
  // Credential state comes from the credential store, not from the network: init, doctor and the
  // catalog listing must work offline. Model counts are a separate, explicit request.
  return Promise.all(
    ids.map(async (id) => {
      const auth = await models.getAuth(id).catch(() => undefined);
      return {
        id,
        configured: Boolean(auth),
        source: auth?.source ?? null,
        models: 0,
        keyOnly: KEY_ONLY_PROVIDERS.has(id),
        registered: registered.has(id),
      };
    }),
  );
}

export type AddProviderResult = {
  id: string;
  models: number;
  source: string | null;
  wroteKey: boolean;
};

/**
 * Store a key, register the provider, and prove the credential works before declaring success.
 *
 * In E2E the network is never touched: a key beginning test-invalid is refused and test-offline
 * simulates an unreachable provider, so the wizard's failure paths are tested deterministically.
 */
export async function addProviderKey(id: string, key: string): Promise<AddProviderResult> {
  if (!KEY_ONLY_PROVIDERS.has(id)) {
    throw new Error(id + " needs additional configuration (endpoint, region or OAuth); the key wizard does not support it yet");
  }
  if (key.trim().length < 8) throw new Error("the key looks too short");
  const e2e = process.env.DURA_E2E === "1" || process.env.PI_E2E === "1";
  if (e2e) {
    if (key.startsWith("test-invalid")) throw new Error("the provider rejected this key (401)");
    if (key.startsWith("test-offline")) throw new Error("the provider is unreachable (network)");
  }
  const wroteKey = true;
  await setApiKey(id, key.trim());
  try {
    registerProvider(id);
    const available = await models.getAvailable(id);
    if (available.length === 0) throw new Error("the provider accepted the key but lists no models");
    return { id, models: available.length, source: "credentials.json", wroteKey };
  } catch (error) {
    await clearApiKey(id).catch(() => undefined);
    throw new Error("could not verify " + id + ": " + (error instanceof Error ? error.message : String(error)));
  }
}

export async function removeProviderKey(id: string): Promise<{ removed: boolean; stillInPiAuth: boolean }> {
  const before = await models.getAuth(id).catch(() => undefined);
  await clearApiKey(id);
  const after = await models.getAuth(id).catch(() => undefined);
  return { removed: Boolean(before), stillInPiAuth: Boolean(after) };
}

export type TestResult = { provider: string; modelId?: string; models: number; answered?: string; ms: number };

/** Prove a provider works: list its models, and optionally ask one for a one-word answer. */
export async function testProvider(id: string, modelId?: string): Promise<TestResult> {
  const started = Date.now();
  registerProvider(id);
  const available = await models.getAvailable(id);
  if (available.length === 0) throw new Error("no models available for " + id);
  if (!modelId) return { provider: id, models: available.length, ms: Date.now() - started };
  const model = models.getModel(id, modelId);
  if (!model) throw new Error("model not found: " + id + "/" + modelId);
  const answer = await models.completeSimple(
    model,
    {
      systemPrompt: "Reply with exactly: OK",
      messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }],
    },
    { sessionId: "dura-provider-test" },
  );
  const content = Array.isArray((answer as { content?: unknown }).content)
    ? ((answer as { content: { text?: unknown }[] }).content).map((block) => (typeof block.text === "string" ? block.text : "")).join("")
    : "";
  return { provider: id, modelId, models: available.length, answered: content.trim().slice(0, 80), ms: Date.now() - started };
}

/** Agent ids whose home bot is this label (or the default when unset). */
export async function agentsOnBot(label: string): Promise<string[]> {
  const agents = await listAgents();
  return agents.filter((agent) => agent.telegramBot === label).map((agent) => agent.id);
}
