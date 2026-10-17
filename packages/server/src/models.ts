import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createModels, type Credential, type CredentialStore } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { credentialsPath, piAuthPath } from "./paths.ts";

type CredentialFile = Record<string, Credential>;

async function readCredentials(path: string): Promise<CredentialFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as CredentialFile) : {};
  } catch {
    return {};
  }
}

async function writeCredentials(path: string, value: CredentialFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Layered credentials: the app's own file first (the only writable one), then pi's auth.json.
 * When both are empty, pi-ai falls back to the provider's environment variable.
 */
function layeredCredentials(): CredentialStore {
  const layers = [credentialsPath, piAuthPath];
  return {
    async read(providerId) {
      for (const path of layers) {
        const file = await readCredentials(path);
        const credential = file[providerId];
        if (credential) return credential;
      }
      return undefined;
    },
    async list() {
      const seen = new Map<string, Credential["type"]>();
      for (const path of layers) {
        const file = await readCredentials(path);
        for (const [providerId, credential] of Object.entries(file)) {
          if (!seen.has(providerId) && credential) seen.set(providerId, credential.type);
        }
      }
      return [...seen].map(([providerId, type]) => ({ providerId, type }));
    },
    async modify(providerId, update) {
      const file = await readCredentials(credentialsPath);
      const next = await update(file[providerId]);
      if (next) file[providerId] = next;
      else delete file[providerId];
      await writeCredentials(credentialsPath, file);
      return next;
    },
    async delete(providerId) {
      const file = await readCredentials(credentialsPath);
      delete file[providerId];
      await writeCredentials(credentialsPath, file);
    },
  };
}

export const models = createModels({ credentials: layeredCredentials() });

for (const provider of [
  opencodeGoProvider,
  openaiProvider,
  anthropicProvider,
  googleProvider,
  deepseekProvider,
  openrouterProvider,
]) {
  models.setProvider(provider());
}

export type ModelRef = { provider: string; modelId: string };

export const DEFAULT_PROVIDER = "opencode-go";
export const DEFAULT_MODEL_ID = process.env.PI_DEFAULT_MODEL ?? "deepseek-v4.1-flash";

function idOf(model: unknown): string | undefined {
  if (typeof model !== "object" || model === null || !("id" in model)) return undefined;
  const id: unknown = model.id;
  return typeof id === "string" ? id : undefined;
}

/** Providers registered in this process. */
export const KNOWN_PROVIDERS = [
  "opencode-go",
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "openrouter",
] as const;

/** Credential status plus available models, for the Provider screen. */
export async function providerStatus(): Promise<
  { id: string; configured: boolean; source: string | null; models: string[] }[]
> {
  const rows: { id: string; configured: boolean; source: string | null; models: string[] }[] = [];
  for (const id of KNOWN_PROVIDERS) {
    let configured = false;
    let source: string | null = null;
    try {
      const auth = await models.getAuth(id);
      configured = Boolean(auth);
      source = auth?.source ?? null;
    } catch {
      configured = false;
    }
    let ids: string[] = [];
    try {
      const available = await models.getAvailable(id);
      ids = available
        .map((model) => (model as { id?: unknown }).id)
        .filter((value): value is string => typeof value === "string")
        .slice(0, 12);
    } catch {
      ids = [];
    }
    rows.push({ id, configured, source, models: ids });
  }
  return rows;
}

/** Save an API key to data/credentials.json (the first CredentialStore layer). */
export async function setApiKey(providerId: string, key: string): Promise<void> {
  const file = await readCredentials(credentialsPath);
  file[providerId] = { type: "api_key", key };
  await writeCredentials(credentialsPath, file);
}

/** Remove the app's API key (pi's auth.json is never touched). */
export async function clearApiKey(providerId: string): Promise<void> {
  const file = await readCredentials(credentialsPath);
  delete file[providerId];
  await writeCredentials(credentialsPath, file);
}

/** Default model: use the requested one when the provider knows it, otherwise the first available. */
export async function resolveDefaultModel(): Promise<ModelRef> {
  // E2E runs against the faux provider only, so a test can never reach the network.
  if (process.env.PI_E2E === "1") {
    return { provider: "e2e", modelId: process.env.PI_E2E_MODEL ?? "faux-vision" };
  }
  const preferred: ModelRef = { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL_ID };
  try {
    const available = await models.getAvailable(DEFAULT_PROVIDER);
    const ids = available.map(idOf).filter((id): id is string => Boolean(id));
    if (ids.includes(preferred.modelId)) return preferred;
    const first = ids[0];
    if (first) {
      console.warn(
        "model " + preferred.modelId + " is not in " + DEFAULT_PROVIDER + "; using " + first,
      );
      return { provider: DEFAULT_PROVIDER, modelId: first };
    }
    console.warn("no model available for " + DEFAULT_PROVIDER + " (no credentials yet?)");
  } catch (error) {
    console.warn("failed to read the model list " + DEFAULT_PROVIDER + ": " + String(error));
  }
  return preferred;
}
