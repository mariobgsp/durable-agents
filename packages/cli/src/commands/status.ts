import { type Parsed, has } from "../args.ts";
import { bytes, duration, json, kv, paint, print } from "../output.ts";
import { DaemonClient, DaemonUnavailable } from "../client.ts";
import { readConfig } from "../../../core/src/config.ts";
import { duraHome } from "../../../core/src/paths.ts";

type BotStatus = { label: string; username?: string; ok?: boolean; enabled?: boolean; lastError?: string; gateway?: string; defaultAgent?: string | null };
type Status = {
  pid: number;
  home: string;
  uptimeMs: number;
  node: string;
  memory: { rss: number; heapUsed: number };
  runs: { active: number; queued: number; max: number };
  counts: { agents: number; sessions: number; groups: number };
  model: { provider: string; modelId: string };
  orchestrator: string | null;
  verifiedAt?: number | null;
  channels?: { platform?: string; bots?: BotStatus[] } | null;
};

export async function runStatus(parsed: Parsed): Promise<void> {
  let client: DaemonClient;
  try {
    client = await DaemonClient.connect();
  } catch (error) {
    if (!(error instanceof DaemonUnavailable)) throw error;
    const config = await readConfig().catch(() => undefined);
    if (has(parsed, "json")) {
      json({ running: false, home: duraHome, config });
      process.exit(3);
    }
    print(paint("yellow", "daemon is not running"));
    print("home " + duraHome);
    if (config) print("model " + config.models.default.provider + "/" + config.models.default.modelId);
    print("start it with: dura start");
    process.exit(3);
  }

  try {
    const status = await client.request<Status>("status");
    if (has(parsed, "json")) {
      json({ running: true, ...status });
      return;
    }
    const config = await readConfig().catch(() => undefined);
    const platform = status.channels?.platform ?? "none";
    const mismatch = Boolean(config && platform !== "none" && config.chat.active !== platform);
    const bots = status.channels?.bots ?? [];
    const botLine =
      bots.length === 0
        ? "none"
        : bots
            .map((bot) => {
              const state = bot.ok === false ? paint("red", "error") : bot.enabled === false ? "disabled" : paint("green", "ok");
              return (bot.username ? "@" + bot.username : bot.label) + " " + state;
            })
            .join(" · ");
    kv([
      ["daemon", "running · pid " + status.pid + " · uptime " + duration(status.uptimeMs)],
      ["chat", platform + (mismatch ? paint("yellow", " · config says " + config?.chat.active + "; restart") : "")],
      ["home", status.home],
      ["model", status.model.provider + "/" + status.model.modelId],
      ["orchestrator", status.orchestrator ?? paint("yellow", "none")],
      ["agents", String(status.counts.agents) + " · sessions " + status.counts.sessions + " · groups " + status.counts.groups],
      ["runs", status.runs.active + " active · " + status.runs.queued + " queued · max " + status.runs.max],
      ["memory", bytes(status.memory.rss) + " rss · " + bytes(status.memory.heapUsed) + " heap"],
      ["bots", botLine],
      ["verified", status.verifiedAt ? new Date(status.verifiedAt).toLocaleString() : paint("yellow", "not yet (dura verify)")],
    ]);
  } finally {
    client.close();
  }
}
