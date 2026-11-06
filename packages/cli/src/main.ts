import { type Parsed, has, parseArgs } from "./args.ts";
import { print } from "./output.ts";

/**
 * One table for the whole CLI: the help text, the aliases and the dispatch all come from it.
 *
 * Keeping them apart is how `dura learn` came to be documented with a long help line and still answer
 * "unknown command", and how `group` and `telegram` came to work without being listed at all. A command is
 * one entry, so it cannot be documented without being dispatchable.
 */
type Command = {
  name: string;
  /** Other names that reach the same command. */
  aliases?: readonly string[];
  /** The `dura help` section it is listed under. */
  section: "Setup" | "Configuration" | "Use";
  /** What the command does, starting with a verb: the order is the reading order in `dura help`. */
  summary: string;
  run: (parsed: Parsed) => Promise<void>;
};

const COMMANDS: readonly Command[] = [
  {
    name: "init",
    section: "Setup",
    summary: "Guided setup: agents, provider, chat surface, service, connection test",
    run: async (parsed) => (await import("./commands/init.ts")).runInit(parsed),
  },
  {
    name: "chat",
    section: "Setup",
    summary: "Show or switch the active surface: show, use, status",
    run: async (parsed) => (await import("./commands/chat.ts")).runChat(parsed),
  },
  {
    name: "verify",
    section: "Setup",
    summary: "Run the connection test against a running daemon",
    run: async (parsed) => (await import("./commands/verify.ts")).runVerify(parsed),
  },
  {
    name: "start",
    section: "Setup",
    summary: "Start the daemon (foreground on a terminal, background otherwise)",
    run: async (parsed) => (await import("./commands/start.ts")).runStart(parsed),
  },
  {
    name: "stop",
    section: "Setup",
    summary: "Stop the daemon",
    run: async (parsed) => (await import("./commands/stop.ts")).runStop(parsed),
  },
  {
    name: "restart",
    section: "Setup",
    summary: "Stop then start the daemon",
    run: async (parsed) => (await import("./commands/restart.ts")).runRestart(parsed),
  },
  {
    name: "status",
    section: "Setup",
    summary: "Daemon, bots, providers, runs and memory",
    run: async (parsed) => (await import("./commands/status.ts")).runStatus(parsed),
  },
  {
    name: "logs",
    section: "Setup",
    summary: "Read or follow the daemon log",
    run: async (parsed) => (await import("./commands/logs.ts")).runLogs(parsed),
  },
  {
    name: "config",
    section: "Configuration",
    summary: "get, set, edit or validate config.json",
    run: async (parsed) => (await import("./commands/config.ts")).runConfig(parsed),
  },
  {
    name: "bot",
    section: "Configuration",
    summary: "Active chat bot registry: add, list, remove, test, default",
    run: async (parsed) => (await import("./commands/bot.ts")).runBot(parsed),
  },
  {
    name: "discord",
    section: "Configuration",
    summary: "Discord-specific: whoami, test, invite, threads, mod, commands",
    run: async (parsed) => (await import("./commands/discord.ts")).runDiscord(parsed),
  },
  {
    name: "telegram",
    section: "Configuration",
    summary: "Telegram-specific: whoami, test",
    run: async (parsed) => (await import("./commands/telegram.ts")).runTelegram(parsed),
  },
  {
    name: "provider",
    section: "Configuration",
    summary: "Providers: list, add, models, test, remove, default",
    run: async (parsed) => (await import("./commands/provider.ts")).runProvider(parsed),
  },
  {
    name: "agent",
    section: "Configuration",
    summary: "Agents: list, show, create, set, enable, disable, delete, docs",
    run: async (parsed) => (await import("./commands/agent.ts")).runAgent(parsed),
  },
  {
    name: "orchestrator",
    section: "Configuration",
    summary: "Show, set, create or replace the orchestrator",
    run: async (parsed) => (await import("./commands/orchestrator.ts")).runOrchestrator(parsed),
  },
  {
    name: "group",
    section: "Configuration",
    summary: "Durable groups: list, create, show, mode",
    run: async (parsed) => (await import("./commands/group.ts")).runGroup(parsed),
  },
  {
    name: "user",
    section: "Configuration",
    summary: "Allowlist: list, add, remove, pending, approve, invite",
    run: async (parsed) => (await import("./commands/user.ts")).runUser(parsed),
  },
  {
    name: "service",
    section: "Configuration",
    summary: "Install, remove or inspect the systemd user unit",
    run: async (parsed) => (await import("./commands/service.ts")).runService(parsed),
  },
  {
    name: "sudo",
    section: "Configuration",
    summary: "Privileged maintenance helper: install, uninstall, status",
    run: async (parsed) => (await import("./commands/sudo.ts")).runSudoCommand(parsed),
  },
  {
    name: "tune",
    section: "Configuration",
    summary: "Report or apply zram/sysctl tuning",
    run: async (parsed) => (await import("./commands/tune.ts")).runTune(parsed),
  },
  {
    name: "migrate",
    section: "Configuration",
    summary: "Copy an older data directory into DURA_HOME",
    run: async (parsed) => (await import("./commands/migrate.ts")).runMigrate(parsed),
  },
  {
    name: "mcp",
    section: "Use",
    summary: "Global MCP servers: list, add, remove, reload, tools, enable, disable, stop",
    run: async (parsed) => (await import("./commands/mcp.ts")).runMcp(parsed),
  },
  {
    name: "thread",
    section: "Use",
    summary: "List, prune, restore or purge threads (--purge --vacuum to reclaim space)",
    run: async (parsed) => (await import("./commands/thread.ts")).runThread(parsed),
  },
  {
    name: "monitor",
    aliases: ["fleet"],
    section: "Use",
    summary: "Fleet TUI (read-only, plus an explicit add-agent form)",
    run: async (parsed) => (await import("./commands/monitor.ts")).runMonitor(parsed),
  },
  {
    name: "usage",
    section: "Use",
    summary: "Usage report",
    run: async (parsed) => (await import("./commands/usage.ts")).runUsage(parsed),
  },
  {
    name: "memory",
    section: "Use",
    summary: "Agent memory notes",
    run: async (parsed) => (await import("./commands/memory.ts")).runMemory(parsed),
  },
  {
    name: "learn",
    section: "Use",
    summary: "Distill threads into preferences, memory and lessons: learn [thread|prefs|sweep] [--recent N] [--all]",
    run: async (parsed) => (await import("./commands/learn.ts")).runLearn(parsed),
  },
  {
    name: "schedule",
    section: "Use",
    summary: "Cron schedules",
    run: async (parsed) => (await import("./commands/schedule.ts")).runSchedule(parsed),
  },
  {
    name: "storage",
    section: "Use",
    summary: "Size report, cleanup, purge",
    run: async (parsed) => (await import("./commands/storage.ts")).runStorage(parsed),
  },
  {
    name: "vault",
    section: "Use",
    summary: "Secret vault names and values",
    run: async (parsed) => (await import("./commands/vault.ts")).runVault(parsed),
  },
  {
    name: "doctor",
    section: "Use",
    summary: "Diagnostics",
    run: async (parsed) => (await import("./commands/doctor.ts")).runDoctor(parsed),
  },
  {
    name: "update",
    section: "Use",
    summary: "Update packages and reload tools",
    run: async (parsed) => (await import("./commands/update.ts")).runUpdate(parsed),
  },
  {
    name: "bench",
    section: "Use",
    summary: "Five-agent memory benchmark",
    run: async (parsed) => (await import("./commands/bench.ts")).runBench(parsed),
  },
];

const SECTIONS = ["Setup", "Configuration", "Use"] as const;
const NAME_COLUMN = 21;

function helpText(): string {
  const lines = ["dura-agents CLI", "", "Usage: dura <command> [options]", ""];
  for (const section of SECTIONS) {
    lines.push(section);
    for (const command of COMMANDS.filter((entry) => entry.section === section)) {
      lines.push("  " + command.name.padEnd(NAME_COLUMN) + command.summary);
    }
    lines.push("");
  }
  lines.push("Global: --json, --help, --version, --home <path>");
  return lines.join("\n");
}

/** The entry a typed name reaches, following aliases. */
function findCommand(name: string): Command | undefined {
  const lowered = name.toLowerCase();
  return COMMANDS.find((entry) => entry.name === lowered || entry.aliases?.includes(lowered) === true);
}

export async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (has(parsed, "version")) {
    print("dura-agents 0.1.0");
    return;
  }
  const name = parsed.positional.shift() ?? "help";
  const command = findCommand(name);

  if (name === "help" || name === "--help" || (has(parsed, "help") && name !== "help")) {
    print(helpText());
    return;
  }
  if (!command) {
    print("unknown command: " + name);
    print("");
    print(helpText());
    process.exit(2);
  }
  await command.run(parsed);
}
