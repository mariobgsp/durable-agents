import type { BotApi } from "./client.ts";
import type { BotCommand, CommandScope } from "./types.ts";

/**
 * One catalog, five uses: the scopes Telegram is told about, the /help text, the inline menu, the owner
 * check in the dispatcher, and the argument hints.
 *
 * Every list below is derived from these entries. A command that exists in one of them and not the others
 * is exactly the drift this file exists to prevent, so nothing may be spelled out twice: adding a command
 * here is the whole change.
 */

/**
 * Who may run a command.
 *
 * `owner-to-change` is the shape /model and /thinking need: anyone in the thread may read the setting, and
 * the write is what the owner check protects. Collapsing it into `owner` would refuse the read, and
 * dropping it would let anyone retune an agent.
 */
export type CommandAccess = "everyone" | "owner" | "owner-to-change";

export type TelegramCommand = {
  name: string;
  /** Other names that reach the same handler. Aliases are never offered to Telegram and never listed. */
  aliases?: readonly string[];
  /** One line for Telegram's command menu, where there is room for about four words. */
  description: string;
  /** The /help line, which has room to say what the command is for. No "(owner)" suffix: that is derived. */
  help: string;
  access?: CommandAccess;
  /** Which Telegram command scopes offer it. Empty means typed-only: hidden from every menu and from /help. */
  scopes?: readonly Scope[];
  /** Caption on the inline keyboard. Commands without one stay off /menu. */
  menu?: string;
};

type Scope = "private" | "group" | "admin";

/**
 * Telegram resolves the most specific command scope, so an old integration that set all_private_chats
 * commands overrides a fresh default list; syncing therefore clears every scope (and the language variants
 * an older bot may have used) before writing ours.
 */
const CATALOG = [
  {
    name: "menu",
    aliases: ["start", "commands"],
    description: "Open the main menu",
    help: "/menu — buttons",
    scopes: ["private", "group", "admin"],
  },
  {
    name: "new",
    description: "Start a new thread",
    help: "/new [title] — new thread",
    scopes: ["private", "group"],
    menu: "New thread",
  },
  {
    name: "threads",
    description: "List and switch threads",
    help: "/threads — list and switch threads",
    scopes: ["private", "group"],
    menu: "Threads",
  },
  {
    name: "plan",
    description: "Ask for a plan before executing",
    help: "/plan [goal] — ask for a plan before executing",
    scopes: ["private", "group"],
    menu: "Plan",
  },
  {
    name: "model",
    description: "Show or change the model",
    help: "/model [provider/model] — show or change the model",
    access: "owner-to-change",
    scopes: ["private", "group", "admin"],
    menu: "Model",
  },
  {
    name: "thinking",
    description: "Reasoning effort for one agent or all",
    help: "/thinking [level|all level] — reasoning effort for one agent or every agent",
    access: "owner-to-change",
    scopes: ["private", "group", "admin"],
  },
  {
    name: "usage",
    description: "Usage report",
    help: "/usage — usage report",
    scopes: ["private", "group", "admin"],
    menu: "Usage",
  },
  {
    name: "agents",
    description: "Choose an agent",
    help: "/agents — switch agent",
    scopes: ["private", "group"],
    menu: "Agents",
  },
  {
    name: "memory",
    description: "Agent memory notes",
    help: "/memory [agent] — memory notes",
    scopes: ["private"],
    menu: "Memory",
  },
  {
    name: "schedules",
    description: "Cron schedules",
    help: "/schedules — cron schedules",
    scopes: ["private"],
    menu: "Schedules",
  },
  {
    name: "status",
    description: "Daemon and connection status",
    help: "/status — daemon and connection",
    scopes: ["private", "group", "admin"],
    menu: "Status",
  },
  {
    name: "whoami",
    description: "Your Telegram id and role",
    help: "/whoami — your id and role",
    scopes: ["private", "group"],
  },
  {
    name: "compact",
    description: "Compact this thread's context",
    help: "/compact — compact this thread",
    access: "owner",
    scopes: ["private"],
  },
  {
    name: "learn",
    description: "Learn from this thread: preferences, memory, lessons",
    help: "/learn — distill this thread into preferences, memory and lessons",
    scopes: ["private"],
  },
  {
    name: "stop",
    description: "Stop the run in this thread only",
    help: "/stop — stop the run in this thread only, leaving other threads alone",
    scopes: ["private", "group"],
    menu: "Stop",
  },
  {
    name: "abort",
    description: "Abort the current run",
    help: "/abort — abort the current run",
    scopes: ["private"],
    menu: "Abort",
  },
  {
    name: "group",
    description: "Group settings",
    help: "/group — group settings",
    access: "owner",
    scopes: ["private", "group"],
    menu: "Group",
  },
  {
    name: "help",
    description: "List commands",
    help: "/help — this list",
    scopes: ["private", "group", "admin"],
    menu: "Help",
  },
  {
    name: "reload",
    description: "Reload tools and thread state",
    help: "/reload — reload tools and threads",
    access: "owner",
    scopes: ["private", "admin"],
    menu: "Reload",
  },
  {
    name: "restart",
    description: "Restart the service",
    help: "/restart — restart the service",
    access: "owner",
    scopes: ["private", "admin"],
    menu: "Restart",
  },
  {
    name: "orchestrator",
    description: "Show or choose the orchestrator",
    help: "/orchestrator — show or choose the orchestrator",
    access: "owner",
    scopes: ["private", "admin"],
  },
  {
    name: "bots",
    description: "Bot registry",
    help: "/bots — bot registry",
    access: "owner",
    scopes: ["private", "admin"],
    menu: "Bots",
  },
  {
    name: "mcp",
    description: "MCP servers and tools for all agents",
    help: "/mcp — MCP servers and tools for all agents",
    access: "owner",
    scopes: ["private", "admin"],
    menu: "MCP",
  },
  {
    name: "prune",
    description: "Remove stale threads",
    help: "/prune [days] — remove stale threads",
    access: "owner",
    scopes: ["private", "admin"],
    menu: "Prune",
  },
  {
    name: "connect",
    description: "Pair a bot from a token",
    help: "/connect &lt;agent&gt; &lt;token&gt; — pair a bot from a token, no browser",
    access: "owner",
    scopes: ["private", "admin"],
  },
  {
    name: "grant",
    description: "Full access for this thread",
    help: "/grant — full access for this thread",
    access: "owner",
    scopes: ["private"],
  },
  {
    name: "bind",
    description: "Bind this group to a thread",
    help: "/bind &lt;id&gt; — bind this group to a thread",
    access: "owner",
    scopes: ["private", "admin"],
  },
  {
    name: "settings",
    description: "Show configuration",
    help: "/settings — configuration",
    access: "owner",
    scopes: ["private"],
  },
  {
    name: "switch",
    description: "Switch this chat to another thread",
    help: "/switch &lt;id&gt; — switch this chat to another thread",
    scopes: [],
  },
  {
    name: "rename",
    description: "Rename this thread",
    help: "/rename &lt;title&gt; — rename this thread",
    scopes: [],
  },
  {
    name: "restart-thread",
    description: "Restart this thread's run",
    help: "/restart-thread [note] — restart this thread's run without restarting the service",
    access: "owner",
    scopes: [],
  },
  {
    name: "groups",
    description: "List durable groups",
    help: "/groups — list durable groups",
    scopes: [],
  },
  {
    name: "approve",
    description: "Approve a user who asked for access",
    help: "/approve &lt;id&gt; — approve a user who asked for access",
    access: "owner",
    scopes: [],
  },
] as const satisfies readonly TelegramCommand[];

/**
 * The catalog as the package reads it. The literal copy above is what makes a mistyped name in the menu a
 * compile error; this view is what lets an entry omit the optional fields it does not need.
 */
export const TELEGRAM_COMMANDS: readonly TelegramCommand[] = CATALOG;

export type TelegramCommandName = (typeof CATALOG)[number]["name"];

/**
 * The inline keyboard, two buttons per row. The layout is a design choice and stays here; the captions and
 * the command names come from the catalog, so a button cannot point at a command that no longer exists.
 */
export const MENU_LAYOUT: readonly (readonly TelegramCommandName[])[] = [
  ["agents", "new"],
  ["threads", "plan"],
  ["model", "usage"],
  ["stop", "abort"],
  ["reload", "restart"],
  ["group", "schedules"],
  ["memory", "bots"],
  ["mcp", "prune"],
  ["status", "help"],
];

export type MenuRow = { text: string; data: string };

export function menuRows(): MenuRow[][] {
  return MENU_LAYOUT.map((row) =>
    row.map((name) => {
      const entry = TELEGRAM_COMMANDS.find((candidate) => candidate.name === name);
      if (!entry) throw new Error("menu layout names a command that is not in the catalog: " + name);
      return { text: entry.menu ?? entry.name, data: "cmd:" + name };
    }),
  );
}

/** The command a typed name reaches, following aliases: `/start` and `/commands` are `/menu`. */
export function findCommand(name: string): TelegramCommand | undefined {
  const lowered = name.toLowerCase();
  return TELEGRAM_COMMANDS.find(
    (entry) => entry.name === lowered || (entry.aliases as readonly string[] | undefined)?.includes(lowered) === true,
  );
}

/** The /help body, derived from the catalog: argument hints and the access suffix come from each entry. */
export function helpText(): string {
  const lines = ["<b>Commands</b>"];
  for (const entry of TELEGRAM_COMMANDS) {
    if (!entry.scopes || entry.scopes.length === 0) continue;
    const access = entry.access === "owner" ? " (owner)" : entry.access === "owner-to-change" ? " (owner to change)" : "";
    lines.push(entry.help + access);
  }
  return lines.join("\n");
}

/** The command list for one scope, with the access note Telegram has no field for. */
function offered(scope: Scope): BotCommand[] {
  return TELEGRAM_COMMANDS.filter((entry) => entry.scopes?.includes(scope)).map((entry) => ({
    command: entry.name,
    description: entry.access === "owner" ? entry.description + " (owner)" : entry.description,
  }));
}

export function privateCommands(): BotCommand[] {
  return offered("private");
}

export function groupCommands(): BotCommand[] {
  return offered("group");
}

export function adminCommands(): BotCommand[] {
  return offered("admin");
}

const SCOPES: (CommandScope | undefined)[] = [
  undefined,
  { type: "all_private_chats" },
  { type: "all_group_chats" },
  { type: "all_chat_administrators" },
];

const LANGUAGE_CODES = ["", "en", "id"];

export async function syncBotCommands(api: BotApi): Promise<{ cleared: number; set: number }> {
  // Parallel batches stay under the Bot API's global pace (25 calls/s) while keeping a service restart from
  // waiting tens of seconds before the bot can take messages.
  const deleteJobs = SCOPES.flatMap((scope) =>
    LANGUAGE_CODES.map((language) => api.deleteMyCommands(scope, language || undefined).then(() => 1).catch(() => 0)),
  );
  const cleared = (await Promise.all(deleteJobs)).reduce((total, value) => total + value, 0);

  const plan: { scope: CommandScope | undefined; commands: BotCommand[] }[] = [
    { scope: undefined, commands: privateCommands() },
    { scope: { type: "all_private_chats" }, commands: privateCommands() },
    { scope: { type: "all_group_chats" }, commands: groupCommands() },
    { scope: { type: "all_chat_administrators" }, commands: adminCommands() },
  ];
  const setResults = await Promise.all(
    plan.map((entry) => api.setMyCommands(entry.commands, entry.scope).then(() => 1).catch(() => 0)),
  );
  const set = setResults.reduce((total, value) => total + value, 0);
  await Promise.all([
    api.setCommandsMenuButton().catch(() => false),
    api.setDescription("dura-agents: durable agents, schedules, memory and files over Telegram. Use /menu to begin.").catch(() => false),
    api.setShortDescription("Durable agents over Telegram.").catch(() => false),
  ]);
  return { cleared, set };
}
