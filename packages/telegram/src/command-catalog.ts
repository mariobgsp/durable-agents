import type { BotApi } from "./client.ts";
import type { BotCommand, CommandScope } from "./types.ts";

/**
 * One catalog, four scopes. Telegram resolves the most specific scope, so an old integration that
 * set all_private_chats commands overrides a fresh default list; syncing therefore clears every
 * scope (and the language variants an older bot may have used) before writing ours.
 */
export const PRIVATE_COMMANDS: BotCommand[] = [
  { command: "menu", description: "Open the main menu" },
  { command: "new", description: "Start a new thread" },
  { command: "threads", description: "List and switch threads" },
  { command: "plan", description: "Ask for a plan before executing" },
  { command: "model", description: "Show or change the model" },
  { command: "usage", description: "Usage report" },
  { command: "agents", description: "Choose an agent" },
  { command: "memory", description: "Agent memory notes" },
  { command: "schedules", description: "Cron schedules" },
  { command: "reload", description: "Reload tools and thread state (owner)" },
  { command: "restart", description: "Restart the service (owner)" },
  { command: "orchestrator", description: "Show or choose the orchestrator (owner)" },
  { command: "bots", description: "Bot registry (owner)" },
  { command: "status", description: "Daemon and connection status" },
  { command: "whoami", description: "Your Telegram id and role" },
  { command: "mcp", description: "MCP servers and tools for all agents (owner)" },
  { command: "prune", description: "Remove stale threads (owner)" },
  { command: "compact", description: "Compact this thread's context" },
  { command: "stop", description: "Stop the current run and queued messages" },
  { command: "connect", description: "Pair a bot from a token (owner)" },
  { command: "abort", description: "Abort the current run" },
  { command: "grant", description: "Full access for this thread (owner)" },
  { command: "group", description: "Group settings" },
  { command: "bind", description: "Bind this group to a thread (owner)" },
  { command: "settings", description: "Show configuration" },
  { command: "help", description: "List commands" },
];

/** Fewer commands in a group: thread and model handling still works, but no admin noise. */
export const GROUP_COMMANDS: BotCommand[] = [
  { command: "menu", description: "Open the main menu" },
  { command: "new", description: "Start a new thread" },
  { command: "threads", description: "List and switch threads" },
  { command: "plan", description: "Ask for a plan before executing" },
  { command: "model", description: "Show or change the model" },
  { command: "usage", description: "Usage report" },
  { command: "agents", description: "Choose an agent" },
  { command: "group", description: "Group settings" },
  { command: "stop", description: "Stop the current run and queued messages" },
  { command: "status", description: "Daemon and connection status" },
  { command: "whoami", description: "Your Telegram id and role" },
  { command: "help", description: "List commands" },
];

/** Group administrators see the owner-facing subset in that group's scope. */
export const ADMIN_COMMANDS: BotCommand[] = [
  { command: "menu", description: "Open the main menu" },
  { command: "status", description: "Daemon and connection status" },
  { command: "reload", description: "Reload tools and thread state" },
  { command: "restart", description: "Restart the service" },
  { command: "model", description: "Show or change the model" },
  { command: "usage", description: "Usage report" },
  { command: "orchestrator", description: "Show or choose the orchestrator" },
  { command: "bots", description: "Bot registry" },
  { command: "bind", description: "Bind this group to a thread" },
  { command: "connect", description: "Pair a bot from a token" },
  { command: "prune", description: "Remove stale threads" },
  { command: "mcp", description: "MCP servers and tools for all agents" },
  { command: "help", description: "List commands" },
];

const SCOPES: (CommandScope | undefined)[] = [
  undefined,
  { type: "all_private_chats" },
  { type: "all_group_chats" },
  { type: "all_chat_administrators" },
];

const LANGUAGE_CODES = ["", "en", "id"];

/**
 * Clear every inherited command set, then install ours per scope. Language codes are cleared too:
 * Telegram keeps a separate list per language, and an older integration may have written one.
 */
export async function syncBotCommands(api: BotApi): Promise<{ cleared: number; set: number }> {
  // Parallel batches stay under the Bot API's global pace (25 calls/s) while keeping a service
  // restart from waiting tens of seconds before the bot can take messages.
  const deleteJobs = SCOPES.flatMap((scope) =>
    LANGUAGE_CODES.map((language) => api.deleteMyCommands(scope, language || undefined).then(() => 1).catch(() => 0)),
  );
  const cleared = (await Promise.all(deleteJobs)).reduce((total, value) => total + value, 0);

  const plan: { scope: CommandScope | undefined; commands: BotCommand[] }[] = [
    { scope: undefined, commands: PRIVATE_COMMANDS },
    { scope: { type: "all_private_chats" }, commands: PRIVATE_COMMANDS },
    { scope: { type: "all_group_chats" }, commands: GROUP_COMMANDS },
    { scope: { type: "all_chat_administrators" }, commands: ADMIN_COMMANDS },
  ];
  const setResults = await Promise.all(
    plan.map((entry) => api.setMyCommands(entry.commands, entry.scope).then(() => 1).catch(() => 0)),
  );
  const set = setResults.reduce((total, value) => total + value, 0);
  await Promise.all([
    api.setCommandsMenuButton().catch(() => false),
    api
      .setDescription("dura-agents: durable agents, schedules, memory and files over Telegram. Use /menu to begin.")
      .catch(() => false),
    api.setShortDescription("Durable agents over Telegram.").catch(() => false),
  ]);
  return { cleared, set };
}
