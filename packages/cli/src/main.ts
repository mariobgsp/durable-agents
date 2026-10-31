import { parseArgs, has, flag } from "./args.ts";
import { paint, print } from "./output.ts";

const HELP = [
  "dura-agents CLI",
  "",
  "Usage: dura <command> [options]",
  "",
  "Setup",
  "  init                 Guided setup: agents, provider, chat surface, service, connection test",
  "  chat                 Show or switch the active surface: show, use, status",
  "  verify               Run the connection test against a running daemon",
  "  start                Start the daemon (foreground on a terminal, background otherwise)",
  "  stop                 Stop the daemon",
  "  restart              Stop then start the daemon",
  "  status               Daemon, bots, providers, runs and memory",
  "  logs                 Read or follow the daemon log",
  "",
  "Configuration",
  "  config               get, set, edit or validate config.json",
  "  bot                  Active chat bot registry: add, list, remove, test, default",
  "  discord              Discord-specific: whoami, test, invite, threads, mod, commands",
  "  provider             Providers: list, add, models, test, remove, default",
  "  agent                Agents: list, show, create, set, enable, disable, delete, docs",
  "  orchestrator         Show, set, create or replace the orchestrator",
  "  user                 Allowlist: list, add, remove, pending, approve, invite",
  "  service              Install, remove or inspect the systemd user unit",
  "  sudo                 Privileged maintenance helper: install, uninstall, status",
  "  tune                 Report or apply zram/sysctl tuning",
  "  migrate              Copy an older data directory into DURA_HOME",
  "",
  "Use",
  "  mcp                  Global MCP servers: list, add, remove, reload, tools",
  "  thread               List, prune, restore or purge threads (--purge --vacuum to reclaim space)",
  "  monitor              Fleet TUI (read-only, plus an explicit add-agent form)",
  "  usage                Usage report",
  "  memory               Agent memory notes",
  "  schedule             Cron schedules",
  "  storage              Size report, cleanup, purge",
  "  vault                Secret vault names and values",
  "  doctor               Diagnostics",
  "  update               Update packages and reload tools",
  "  bench                Five-agent memory benchmark",
  "",
  "Global: --json, --help, --version, --home <path>",
].join("\n");

export async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (has(parsed, "version")) {
    print("dura-agents 0.1.0");
    return;
  }
  const command = parsed.positional.shift() ?? "help";
  if (has(parsed, "help") && command !== "help") {
    print(HELP);
    return;
  }

  switch (command) {
    case "help":
    case "--help":
      print(HELP);
      return;
    case "init": {
      const { runInit } = await import("./commands/init.ts");
      await runInit(parsed);
      return;
    }
    case "verify": {
      const { runVerify } = await import("./commands/verify.ts");
      await runVerify(parsed);
      return;
    }
    case "start": {
      const { runStart } = await import("./commands/start.ts");
      await runStart(parsed);
      return;
    }
    case "stop": {
      const { runStop } = await import("./commands/stop.ts");
      await runStop(parsed);
      return;
    }
    case "restart": {
      const { runRestart } = await import("./commands/restart.ts");
      await runRestart(parsed);
      return;
    }
    case "status": {
      const { runStatus } = await import("./commands/status.ts");
      await runStatus(parsed);
      return;
    }
    case "logs": {
      const { runLogs } = await import("./commands/logs.ts");
      await runLogs(parsed);
      return;
    }
    case "config": {
      const { runConfig } = await import("./commands/config.ts");
      await runConfig(parsed);
      return;
    }
    case "chat": {
      const { runChat } = await import("./commands/chat.ts");
      await runChat(parsed);
      return;
    }
    case "bot": {
      const { runBot } = await import("./commands/bot.ts");
      await runBot(parsed);
      return;
    }
    case "discord": {
      const { runDiscord } = await import("./commands/discord.ts");
      await runDiscord(parsed);
      return;
    }
    case "provider": {
      const { runProvider } = await import("./commands/provider.ts");
      await runProvider(parsed);
      return;
    }
    case "mcp": {
      const { runMcp } = await import("./commands/mcp.ts");
      await runMcp(parsed);
      return;
    }
    case "thread": {
      const { runThread } = await import("./commands/thread.ts");
      await runThread(parsed);
      return;
    }
    case "group": {
      const { runGroup } = await import("./commands/group.ts");
      await runGroup(parsed);
      return;
    }
    case "agent": {
      const { runAgent } = await import("./commands/agent.ts");
      await runAgent(parsed);
      return;
    }
    case "orchestrator": {
      const { runOrchestrator } = await import("./commands/orchestrator.ts");
      await runOrchestrator(parsed);
      return;
    }
    case "user": {
      const { runUser } = await import("./commands/user.ts");
      await runUser(parsed);
      return;
    }
    case "monitor":
    case "fleet": {
      const { runMonitor } = await import("./commands/monitor.ts");
      await runMonitor(parsed);
      return;
    }
    case "usage": {
      const { runUsage } = await import("./commands/usage.ts");
      await runUsage(parsed);
      return;
    }
    case "memory": {
      const { runMemory } = await import("./commands/memory.ts");
      await runMemory(parsed);
      return;
    }
    case "schedule": {
      const { runSchedule } = await import("./commands/schedule.ts");
      await runSchedule(parsed);
      return;
    }
    case "storage": {
      const { runStorage } = await import("./commands/storage.ts");
      await runStorage(parsed);
      return;
    }
    case "vault": {
      const { runVault } = await import("./commands/vault.ts");
      await runVault(parsed);
      return;
    }
    case "doctor": {
      const { runDoctor } = await import("./commands/doctor.ts");
      await runDoctor(parsed);
      return;
    }
    case "service": {
      const { runService } = await import("./commands/service.ts");
      await runService(parsed);
      return;
    }
    case "tune": {
      const { runTune } = await import("./commands/tune.ts");
      await runTune(parsed);
      return;
    }
    case "sudo": {
      const { runSudoCommand } = await import("./commands/sudo.ts");
      await runSudoCommand(parsed);
      return;
    }
    case "migrate": {
      const { runMigrate } = await import("./commands/migrate.ts");
      await runMigrate(parsed);
      return;
    }
    case "update": {
      const { runUpdate } = await import("./commands/update.ts");
      await runUpdate(parsed);
      return;
    }
    case "bench": {
      const { runBench } = await import("./commands/bench.ts");
      await runBench(parsed);
      return;
    }
    case "telegram": {
      const { runTelegram } = await import("./commands/telegram.ts");
      await runTelegram(parsed);
      return;
    }
    default:
      print("unknown command: " + command);
      print("");
      print(HELP);
      process.exit(2);
  }
}
