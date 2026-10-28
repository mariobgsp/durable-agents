import { stdin, stdout } from "node:process";
import { type Parsed, flag, has, numberFlag } from "../args.ts";
import { bytes, duration, json, paint, print } from "../output.ts";
import { DaemonClient, DaemonUnavailable } from "../client.ts";
import { useBotRegistry } from "../bots.ts";
import { createAgent } from "../../../core/src/agent-admin.ts";
import { readConfig } from "../../../core/src/config.ts";
import { ask, choose, confirm, interactive } from "../prompts.ts";

type FleetAgent = {
  id: string;
  name: string;
  model: { provider: string; modelId: string };
  enabled: boolean;
  status: "working" | "idle" | "disabled";
  since: number | null;
  currentThread: { id: string; title: string } | null;
  threadCount: number;
  links: { inbound: number; outbound: number; active: number };
  schedules: { total: number; nextRunAt?: number; nextName?: string };
  lastActiveAt: number | null;
};
type Fleet = {
  generatedAt: number;
  timezone: string;
  agents: FleetAgent[];
  links: { from: string; to: string; kind: string; status: string; createdAt: number }[];
  schedules: { id: string; agentId: string; name: string; cron: string; enabled: boolean; nextRunAt?: number }[];
  totals: { agents: number; working: number; idle: number; disabled: number; activeLinks: number };
};

type Status = {
  memory: { rss: number };
  runs: { active: number; queued: number; max: number };
  channels?: { bots?: { label: string; username?: string; ok?: boolean }[] };
};

const ALT_ON = "\u001b[?1049h";
const ALT_OFF = "\u001b[?1049l";
const HIDE = "\u001b[?25l";
const SHOW = "\u001b[?25h";
const HOME = "\u001b[H\u001b[2J";

function clip(value: string, width: number): string {
  return value.length <= width ? value : value.slice(0, Math.max(0, width - 1)) + "…";
}

function render(fleet: Fleet, status: Status, width: number): string {
  const lines: string[] = [];
  const bots = status.channels?.bots ?? [];
  lines.push(
    paint("bold", "dura-agents monitor") +
      "  " + new Date().toLocaleTimeString() +
      "  runs " + status.runs.active + "/" + status.runs.max + (status.runs.queued ? " +" + status.runs.queued + " queued" : "") +
      "  rss " + bytes(status.memory.rss),
  );
  lines.push(
    paint("dim", "agents " + fleet.totals.agents + " · working " + fleet.totals.working + " · idle " + fleet.totals.idle + " · disabled " + fleet.totals.disabled + " · links " + fleet.totals.activeLinks),
  );
  lines.push(paint("dim", "bots " + (bots.map((bot) => bot.label + (bot.ok ? "●" : "○")).join(" ") || "none")));
  lines.push("");
  const headers = ["", "agent", "bot", "model", "state", "thread", "links", "next"];
  const rows = fleet.agents.map((agent) => {
    const dot = agent.status === "working" ? paint("green", "◉") : agent.status === "disabled" ? paint("dim", "○") : "○";
    const since = agent.status === "working" && agent.since ? " " + duration(Date.now() - agent.since) : "";
    const next = agent.schedules.nextRunAt ? new Date(agent.schedules.nextRunAt).toLocaleTimeString() : "-";
    return [
      dot,
      agent.name,
      (agent as FleetAgent & { telegramBot?: string }).telegramBot ?? "-",
      agent.model.provider + "/" + agent.model.modelId,
      agent.status + since,
      agent.currentThread?.title ?? "-",
      agent.links.inbound + "/" + agent.links.outbound,
      next,
    ];
  });
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)));
  const line = (cells: string[]): string =>
    cells.map((cell, column) => clip(cell, Math.max(6, widths[column] ?? 6)).padEnd(Math.max(6, widths[column] ?? 6))).join(" ").slice(0, width);
  lines.push(paint("dim", line(headers)));
  for (const row of rows) lines.push(line(row));
  lines.push("");
  lines.push(paint("dim", "Last links:"));
  for (const link of fleet.links.slice(0, 5)) {
    lines.push("  " + link.from + " → " + link.to + " · " + link.kind + " · " + link.status);
  }
  lines.push("");
  lines.push(paint("dim", "q quit · r refresh · a add agent · ? help" + (fleet.timezone ? " · " + fleet.timezone : "")));
  return HOME + lines.map((entry) => entry + "\n").join("");
}

async function addAgentForm(): Promise<void> {
  const labels = await useBotRegistry();
  if (labels.length === 0) {
    print("No Telegram bot configured; run dura init step 3 or dura bot add.");
    return;
  }
  const name = await ask("Agent name");
  if (!name.trim()) return;
  const bot = await choose("Which Telegram bot?", labels.map((label) => ({ label: "@" + label, value: label })));
  const responsibility = await ask("Responsibility (optional)", "");
  const config = await readConfig({ fresh: true });
  if (!(await confirm("Create " + name + " on " + bot + " with " + config.models.default.provider + "/" + config.models.default.modelId + "?", true))) return;
  const files = await createAgent({
    name,
    telegramBot: bot,
    responsibility: responsibility || undefined,
    caller: "tui",
  });
  print(paint("green", "created") + " " + files.record.id);
}

export async function runMonitor(parsed: Parsed): Promise<void> {
  let client: DaemonClient;
  try {
    client = await DaemonClient.connect();
  } catch (error) {
    if (!(error instanceof DaemonUnavailable)) throw error;
    if (has(parsed, "json")) json({ running: false });
    else print("the daemon is not running; start it with: dura start");
    process.exit(3);
  }

  if (has(parsed, "json")) {
    try {
      json(await client.request("fleet.snapshot"));
    } finally {
      client.close();
    }
    return;
  }

  let fleet = (await client.request<Fleet>("fleet.snapshot")) as Fleet;
  let status = (await client.request<Status>("status")) as Status;
  const readOnly = has(parsed, "read-only") || !(await readConfig().then((config) => config.tui.allowCreate).catch(() => true));
  const interval = Math.max(500, numberFlag(parsed, "interval") ?? 1000);

  const draw = (): void => {
    stdout.write(render(fleet, status, stdout.columns ?? 120));
  };

  const off = await client.subscribeFleet<Fleet>((snapshot) => {
    fleet = snapshot;
    draw();
  });
  stdout.write(ALT_ON + HIDE + HOME);
  draw();

  const tick = setInterval(async () => {
    status = (await client.request<Status>("status").catch(() => status)) as Status;
    draw();
  }, interval);

  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  const cleanup = (): void => {
    clearInterval(tick);
    void off();
    if (stdin.isRaw) stdin.setRawMode(wasRaw ?? false);
    stdin.pause();
    stdout.write(SHOW + ALT_OFF);
    client.close();
  };

  await new Promise<void>((done) => {
    const onData = (chunk: Buffer): void => {
      const key = chunk.toString("utf8");
      if (key === "q" || key === "\u0003") {
        stdin.off("data", onData);
        cleanup();
        done();
        return;
      }
      if (key === "r") {
        void client.request<Fleet>("fleet.snapshot").then((snapshot) => {
          fleet = snapshot;
          draw();
        });
        return;
      }
      if (key === "?" || key === "d") {
        stdout.write(HOME + paint("bold", "Help") + "\n\nq quit · r refresh · a add agent" +
          (readOnly ? " (disabled by --read-only)" : "") + "\n\nThe fleet view is read-only; the only write is the add-agent form.\n");
        return;
      }
      if (key === "a" && !readOnly) {
        stdin.off("data", onData);
        stdout.write(SHOW + ALT_OFF);
        stdin.setRawMode(false);
        stdin.pause();
        void addAgentForm().then(() => {
          stdin.setRawMode(true);
          stdin.resume();
          stdout.write(ALT_ON + HIDE + HOME);
          draw();
          stdin.on("data", onData);
        });
      }
    };
    stdin.on("data", onData);
  });
}
