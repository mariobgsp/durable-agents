import { errorFields, log } from "../../core/src/logger.ts";
import type { DiscordApi } from "./client.ts";
import type { DiscordApplicationCommand, DiscordCommandOption } from "./types.ts";

export type DiscordCommandSpec = {
  name: string;
  description: string;
  options?: DiscordCommandOption[];
  /** Registered with member permissions 0 and also checked by user id in the runtime. */
  ownerOnly?: boolean;
  /** Available in DMs; owner-only commands default to false. */
  dm?: boolean;
};

const STRING = 3;
const INTEGER = 4;
const BOOLEAN = 5;
const USER = 6;
const CHANNEL = 7;

function opt(type: number, name: string, description: string, required = false): DiscordCommandOption {
  return { type, name, description, required };
}

/**
 * The command menu. Keep this list in step with the runtime's dispatcher: a registered command the
 * runtime does not know is worse than no command at all.
 */
export const DISCORD_COMMANDS: DiscordCommandSpec[] = [
  { name: "help", description: "Show the commands and how threads work", dm: true },
  { name: "menu", description: "Show a compact command menu", dm: true },
  { name: "whoami", description: "Show your Discord id and role", dm: true },
  { name: "status", description: "Show daemon, bot, gateway and run status", dm: true },
  { name: "new", description: "Start a new thread (or a DM thread) and bind a session", options: [
    opt(STRING, "title", "Thread title"),
    opt(STRING, "agent", "Agent id; defaults to the channel or bot default"),
  ], dm: true },
  { name: "threads", description: "List this agent's threads and link the Discord ones", dm: true },
  { name: "rename", description: "Rename the current thread", options: [opt(STRING, "title", "New title", true)], dm: true },
  { name: "archive", description: "Archive the current Discord thread", dm: false },
  { name: "agent", description: "Move the current thread to another agent", options: [opt(STRING, "agent", "Agent id", true)], dm: true },
  { name: "agents", description: "List agents and their models", dm: true },
  { name: "model", description: "Show or change the model for this thread", options: [opt(STRING, "model", "provider/model or model id")], dm: true },
  { name: "thinking", description: "Show or change reasoning effort", options: [opt(STRING, "level", "off, minimal, low, medium, high, xhigh or max")], dm: true },
  { name: "usage", description: "Show token and cost usage", dm: true },
  { name: "plan", description: "Ask the agent to plan without executing", options: [opt(STRING, "goal", "Goal to plan", true)], dm: true },
  { name: "compact", description: "Compact this thread's context", dm: true },
  { name: "abort", description: "Abort the current run", dm: true },
  { name: "stop", description: "Stop the current run and withdraw queued inputs", dm: true },
  { name: "bind", description: "Bind this channel or thread to an agent or group", options: [
    opt(STRING, "agent", "Agent id"),
    opt(STRING, "group", "Durable group/room id"),
  ], ownerOnly: true, dm: false },
  { name: "unbind", description: "Remove this channel or thread binding", ownerOnly: true, dm: false },
  { name: "memory", description: "Show an agent's memory notes", options: [opt(STRING, "agent", "Agent id")], dm: true },
  { name: "schedules", description: "List cron schedules", dm: true },
  { name: "bots", description: "List Discord bots, gateway health and default agents", ownerOnly: true, dm: false },
  { name: "orchestrator", description: "Show or choose the orchestrator", options: [opt(STRING, "agent", "Agent id")], ownerOnly: true, dm: false },
  { name: "settings", description: "Show the active chat configuration", ownerOnly: true, dm: false },
  { name: "mcp", description: "List, add, remove or reload MCP servers", options: [
    opt(STRING, "action", "list, add, remove or reload"),
    opt(STRING, "name", "Server name"),
    opt(STRING, "command", "Command for add"),
  ], ownerOnly: true, dm: false },
  { name: "prune", description: "Preview stale threads and offer delete/purge", options: [opt(INTEGER, "days", "Older than N days")], ownerOnly: true, dm: false },
  { name: "reload", description: "Reload tools and rebind agents", ownerOnly: true, dm: false },
  { name: "restart", description: "Restart the dura service", ownerOnly: true, dm: false },
  { name: "connect", description: "Add a Discord bot from a token (the token message is deleted)", options: [
    opt(STRING, "label", "Registry label"),
    opt(STRING, "token", "Bot token", true),
    opt(STRING, "agent", "Default agent id for this bot"),
  ], ownerOnly: true, dm: false },
  { name: "approve", description: "Approve a pending user by id", options: [opt(STRING, "user", "Discord user id", true)], ownerOnly: true, dm: false },
  { name: "invite", description: "Print the bot invite URL and required permissions", dm: true },
  { name: "server", description: "Show this guild, channel and thread", ownerOnly: true, dm: false },
  { name: "ping", description: "Check the gateway and REST round-trip", dm: true },
  {
    name: "mod",
    description: "Moderation: timeout, kick, ban, unban, warn, warnings, audit",
    options: [
      { type: 1, name: "timeout", description: "Timeout a member", options: [
        opt(USER, "user", "Member to time out", true),
        opt(INTEGER, "minutes", "Minutes; 0 clears the timeout", true),
        opt(STRING, "reason", "Audit reason", true),
      ] },
      { type: 1, name: "kick", description: "Kick a member", options: [
        opt(USER, "user", "Member to kick", true),
        opt(STRING, "reason", "Audit reason", true),
      ] },
      { type: 1, name: "ban", description: "Ban a member", options: [
        opt(USER, "user", "Member to ban", true),
        opt(STRING, "reason", "Audit reason", true),
        opt(INTEGER, "delete_days", "Delete this many days of their messages"),
      ] },
      { type: 1, name: "unban", description: "Unban a user", options: [
        opt(USER, "user", "User to unban", true),
        opt(STRING, "reason", "Audit reason", true),
      ] },
      { type: 1, name: "warn", description: "Record a warning", options: [
        opt(USER, "user", "Member to warn", true),
        opt(STRING, "reason", "Warning reason", true),
      ] },
      { type: 1, name: "warnings", description: "Show a user's warnings", options: [opt(USER, "user", "Member", true)] },
      { type: 1, name: "audit", description: "Set the audit log channel", options: [opt(CHANNEL, "channel", "Audit channel", true)] },
    ],
    ownerOnly: true,
    dm: false,
  },
];

export function toApplicationCommand(spec: DiscordCommandSpec): DiscordApplicationCommand {
  return {
    name: spec.name,
    description: spec.description.slice(0, 100),
    type: 1,
    ...(spec.options?.length ? { options: spec.options } : {}),
    ...(spec.ownerOnly ? { default_member_permissions: "0" } : {}),
    dm_permission: spec.dm ?? true,
  };
}

/** PUT the whole command set; this is also how stale commands are removed. */
export async function syncDiscordCommands(
  api: DiscordApi,
  applicationId: string,
  guildId?: string,
): Promise<{ count: number }> {
  try {
    await api.registerCommands(applicationId, DISCORD_COMMANDS.map(toApplicationCommand), guildId);
    log.info("discord.commands", { applicationId, guildId: guildId ?? "global", count: DISCORD_COMMANDS.length });
    return { count: DISCORD_COMMANDS.length };
  } catch (error) {
    log.warn("discord.commands_failed", { applicationId, ...errorFields(error) });
    throw error;
  }
}
