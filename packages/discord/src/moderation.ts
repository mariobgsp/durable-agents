import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readConfig } from "../../core/src/config.ts";
import { errorFields, log } from "../../core/src/logger.ts";
import { discordWarningsPath } from "../../core/src/paths.ts";
import { DiscordApiError, type DiscordApi } from "./client.ts";
import type { DiscordGuildMember, DiscordRole } from "./types.ts";

export type WarningRecord = {
  id: string;
  guildId: string;
  userId: string;
  moderatorId: string;
  reason: string;
  at: number;
};

type WarningFile = { version: 1; warnings: WarningRecord[] };
const WARNING_LIMIT = 5000;

export async function loadWarnings(): Promise<WarningRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(discordWarningsPath, "utf8")) as Partial<WarningFile>;
    return Array.isArray(parsed.warnings)
      ? parsed.warnings.filter(
          (warning): warning is WarningRecord =>
            Boolean(warning) &&
            typeof warning.id === "string" &&
            typeof warning.guildId === "string" &&
            typeof warning.userId === "string" &&
            typeof warning.reason === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export async function saveWarnings(warnings: WarningRecord[]): Promise<void> {
  await mkdir(dirname(discordWarningsPath), { recursive: true, mode: 0o700 });
  const tmp = discordWarningsPath + ".tmp";
  const payload: WarningFile = { version: 1, warnings: warnings.slice(-WARNING_LIMIT) };
  await writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, discordWarningsPath);
}

export async function addWarning(input: Omit<WarningRecord, "id" | "at">): Promise<WarningRecord> {
  const warning: WarningRecord = {
    ...input,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    at: Date.now(),
  };
  const warnings = await loadWarnings();
  warnings.push(warning);
  await saveWarnings(warnings);
  return warning;
}

export async function warningsFor(guildId: string, userId: string): Promise<WarningRecord[]> {
  return (await loadWarnings()).filter((warning) => warning.guildId === guildId && warning.userId === userId);
}

function highestPosition(member: DiscordGuildMember, roles: DiscordRole[], guildId: string): number {
  const held = new Set(member.roles);
  held.add(guildId); // @everyone
  return roles.filter((role) => held.has(role.id)).reduce((max, role) => Math.max(max, role.position), 0);
}

async function assertCanModerate(api: DiscordApi, guildId: string, targetId: string, botId: string): Promise<void> {
  if (targetId === botId) throw new Error("I will not moderate myself.");
  const guild = await api.getGuild(guildId);
  if (guild.owner_id === targetId) throw new Error("the guild owner cannot be moderated by this bot");
  const [roles, botMember, targetMember] = await Promise.all([
    api.getGuildRoles(guildId),
    api.getGuildMember(guildId, botId),
    api.getGuildMember(guildId, targetId),
  ]);
  if (targetMember.user?.bot) throw new Error("bots are not moderation targets for this command");
  if (highestPosition(botMember, roles, guildId) <= highestPosition(targetMember, roles, guildId)) {
    throw new Error("the target's highest role is at or above the bot's; move the bot's role higher first");
  }
}

/** Best-effort audit line. A failing audit log must not hide a successful moderation action. */
export async function audit(api: DiscordApi, text: string): Promise<void> {
  const config = await readConfig({ fresh: true }).catch(() => undefined);
  const channelId = config?.discord?.moderation?.auditChannelId;
  if (!channelId) {
    log.info("discord.moderation", { text });
    return;
  }
  try {
    await api.sendMessage(channelId, { content: text.slice(0, 1900), allowed_mentions: { parse: [] } });
  } catch (error) {
    log.warn("discord.audit_failed", errorFields(error));
  }
}

async function notifyTarget(api: DiscordApi, userId: string, text: string): Promise<void> {
  const config = await readConfig({ fresh: true }).catch(() => undefined);
  if (config?.discord?.moderation?.dmTargets === false) return;
  try {
    const dm = await api.createDM(userId);
    await api.sendMessage(dm.id, { content: text.slice(0, 1900), allowed_mentions: { parse: [] } });
  } catch (error) {
    log.warn("discord.target_dm_failed", { userId, ...errorFields(error) });
  }
}

export type ModerationAction = "timeout" | "kick" | "ban" | "unban" | "warn";

export type ModerationInput = {
  action: ModerationAction;
  guildId: string;
  userId: string;
  moderatorId: string;
  botId: string;
  reason: string;
  minutes?: number;
  deleteDays?: number;
};

export type ModerationResult = { ok: true; text: string } | { ok: false; error: string };

function cleanReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, 400);
}

/**
 * One moderation path for slash commands, the CLI and the agent tool. Permission/property checks are
 * here, not in the caller, so a new surface cannot accidentally bypass them.
 */
export async function moderate(api: DiscordApi, input: ModerationInput): Promise<ModerationResult> {
  const reason = cleanReason(input.reason);
  if (!reason) return { ok: false, error: "a reason is required" };
  try {
    const guild = await api.getGuild(input.guildId);
    const actor = "<@" + input.userId + ">";
    switch (input.action) {
      case "timeout": {
        await assertCanModerate(api, input.guildId, input.userId, input.botId);
        const minutes = Math.max(0, Math.min(40_320, Math.floor(input.minutes ?? 0)));
        await api.moderateMember(input.guildId, input.userId, { timeoutSeconds: minutes * 60, reason });
        const text = minutes > 0 ? "timed out " + actor + " for " + minutes + " minute(s)" : "cleared the timeout on " + actor;
        await audit(api, "🛡️ " + text + " by <@" + input.moderatorId + "> · " + reason);
        if (minutes > 0) await notifyTarget(api, input.userId, "You were timed out in " + guild.name + ": " + reason);
        return { ok: true, text };
      }
      case "kick": {
        await assertCanModerate(api, input.guildId, input.userId, input.botId);
        await api.kickMember(input.guildId, input.userId, reason);
        await audit(api, "👢 kicked " + actor + " by <@" + input.moderatorId + "> · " + reason);
        await notifyTarget(api, input.userId, "You were kicked from " + guild.name + ": " + reason);
        return { ok: true, text: "kicked " + actor };
      }
      case "ban": {
        try {
          await assertCanModerate(api, input.guildId, input.userId, input.botId);
        } catch (error) {
          // A user who is not a member can still be banned; only hierarchy checks need membership.
          if (!(error instanceof DiscordApiError && error.status === 404)) throw error;
          if (guild.owner_id === input.userId) throw error;
        }
        const days = Math.max(0, Math.min(7, Math.floor(input.deleteDays ?? 0)));
        await api.banMember(input.guildId, input.userId, { reason, deleteMessageSeconds: days * 86_400 });
        await audit(api, "🔨 banned " + actor + " by <@" + input.moderatorId + "> · " + reason);
        await notifyTarget(api, input.userId, "You were banned from " + guild.name + ": " + reason);
        return { ok: true, text: "banned " + actor };
      }
      case "unban": {
        await api.unbanMember(input.guildId, input.userId, reason);
        await audit(api, "♻️ unbanned " + actor + " by <@" + input.moderatorId + "> · " + reason);
        return { ok: true, text: "unbanned " + actor };
      }
      case "warn": {
        const warning = await addWarning({ guildId: input.guildId, userId: input.userId, moderatorId: input.moderatorId, reason });
        await audit(api, "⚠️ warned " + actor + " by <@" + input.moderatorId + "> · " + reason + " · warning " + warning.id);
        await notifyTarget(api, input.userId, "You were warned in " + guild.name + ": " + reason);
        return { ok: true, text: "warned " + actor };
      }
      default:
        return { ok: false, error: "unknown moderation action" };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
