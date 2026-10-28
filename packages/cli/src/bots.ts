import { loadRegistry } from "../../telegram/src/registry.ts";
import { setBotResolver } from "../../core/src/agent-admin.ts";

/** Wire the admin service to the real registry before a CLI mutation. */
export async function useBotRegistry(): Promise<string[]> {
  const registry = await loadRegistry();
  const labels = registry.bots.map((bot) => bot.label);
  setBotResolver({
    validate: async (label) => labels.includes(label),
    list: async () => labels,
  });
  return labels;
}

export async function botLabels(): Promise<string[]> {
  return (await loadRegistry()).bots.map((bot) => bot.label);
}
