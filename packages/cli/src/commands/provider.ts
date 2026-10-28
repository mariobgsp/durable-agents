import { type Parsed, flag, has } from "../args.ts";
import { fail, json, paint, print, table } from "../output.ts";
import {
  addProviderKey,
  builtinProviderIds,
  EXTRA_CONFIG_PROVIDERS,
  KEY_ONLY_PROVIDERS,
  providerRows,
  registerProvider,
  removeProviderKey,
  testProvider,
} from "../../../core/src/providers.ts";
import { providerStatus, models, clearApiKey, setApiKey } from "../../../core/src/models.ts";
import { readConfig, updateConfig } from "../../../core/src/config.ts";
import { secret } from "../prompts.ts";

const KNOWN = ["opencode-go", "openai", "anthropic", "google", "deepseek", "openrouter"];

function rowState(row: { configured: boolean; source: string | null; models: number }): string {
  if (!row.configured) return paint("yellow", "no credential");
  return paint("green", "ok") + " · " + row.models + " models" + (row.source ? " · " + row.source : "");
}

export async function runProvider(parsed: Parsed): Promise<void> {
  const [action = "list", target] = parsed.positional;

  if (action === "list") {
    const all = has(parsed, "all");
    const ids = all ? await builtinProviderIds() : (await readConfig({ fresh: true })).models.registered;
    const rows = await providerRows(ids);
    if (has(parsed, "json")) {
      json(rows);
      return;
    }
    table(
      ["provider", "state", "note"],
      rows.map((row) => [
        row.id,
        row.configured ? paint("green", "configured") + (row.source ? " · " + row.source : "") : paint("yellow", "no credential"),
        EXTRA_CONFIG_PROVIDERS.has(row.id)
          ? "needs extra configuration"
          : KEY_ONLY_PROVIDERS.has(row.id)
            ? "key only"
            : "catalog entry",
      ]),
    );
    return;
  }

  if (action === "add") {
    if (!target) fail("usage: dura provider add <provider> [--key | --key-stdin] [--model <id>] [--default]", 2);
    if (EXTRA_CONFIG_PROVIDERS.has(target)) {
      fail(target + " needs an endpoint, region or OAuth and is not supported by the key wizard yet", 4);
    }
    let key = flag(parsed, "key");
    if (!key && has(parsed, "key-stdin")) key = await secret("API key");
    if (!key) key = await secret("API key for " + target);
    const result = await addProviderKey(target, key);
    const config = await readConfig({ fresh: true });
    const registered = [...new Set([...config.models.registered, target])];
    await updateConfig({ models: { registered } });
    if (flag(parsed, "model")) {
      await updateConfig({ models: { default: { provider: target, modelId: flag(parsed, "model") ?? "" } } });
    }
    if (has(parsed, "default") && !flag(parsed, "model")) {
      const available = await models.getAvailable(target);
      const first = (available[0] as { id?: unknown } | undefined)?.id;
      if (typeof first === "string") await updateConfig({ models: { default: { provider: target, modelId: first } } });
    }
    if (has(parsed, "json")) json(result);
    else print(paint("green", "saved and verified") + " " + target + " · " + result.models + " models");
    return;
  }

  if (action === "models") {
    if (!target) fail("usage: dura provider models <provider>", 2);
    registerProvider(target);
    const available = await models.getAvailable(target);
    const rows = available.slice(0, 50).map((model) => {
      const typed = model as { id?: string; contextWindow?: number; input?: string[]; cost?: { input?: number } };
      return [String(typed.id ?? "?"), String(typed.contextWindow ?? "?"), (typed.input ?? []).join(","), String(typed.cost?.input ?? 0)];
    });
    if (has(parsed, "json")) json(available);
    else table(["model", "context", "input", "cost/1M in"], rows);
    return;
  }

  if (action === "test") {
    if (!target) fail("usage: dura provider test <provider> [model]", 2);
    const result = await testProvider(target, parsed.positional[2]);
    if (has(parsed, "json")) json(result);
    else {
      print(paint("green", "ok") + " " + result.provider + " · " + result.models + " models · " + result.ms + "ms");
      if (result.answered) print("answer: " + result.answered);
    }
    return;
  }

  if (action === "remove") {
    if (!target) fail("usage: dura provider remove <provider>", 2);
    const config = await readConfig({ fresh: true });
    if (config.models.default.provider === target) {
      fail(target + " is the default provider; set another default first", 4);
    }
    const result = await removeProviderKey(target);
    if (has(parsed, "json")) json(result);
    else {
      print(result.removed ? "removed the app key for " + target : "no app key for " + target);
      if (result.stillInPiAuth) print(paint("yellow", "a credential still resolves from ~/.pi/agent/auth.json"));
    }
    return;
  }

  if (action === "default") {
    const provider = target ?? fail("usage: dura provider default <provider> [model]", 2);
    registerProvider(provider);
    const available = await models.getAvailable(provider);
    const modelId = parsed.positional[2] ?? (available[0] as { id?: unknown } | undefined)?.id;
    if (typeof modelId !== "string") fail("no model available for " + provider, 1);
    await updateConfig({ models: { default: { provider, modelId } } });
    print("default model: " + provider + "/" + modelId);
    return;
  }

  if (action === "status") {
    const rows = await providerStatus();
    if (has(parsed, "json")) json(rows);
    else table(["provider", "configured", "source"], rows.map((row) => [row.id, row.configured ? "yes" : "no", row.source ?? "-"]));
    return;
  }

  fail("usage: dura provider <list|add|models|test|remove|default|status>", 2);
}

export { KNOWN as PROVIDER_SHORTCUTS, setApiKey, clearApiKey };
