import { type Parsed, flag, has } from "../args.ts";
import { fail, json, paint, print } from "../output.ts";
import { DaemonClient, DaemonUnavailable } from "../client.ts";
import { readConfig } from "../../../core/src/config.ts";
import { defaultDiscordBot, discordBotByLabel, loadDiscordRegistry, publicDiscordRegistry } from "../../../discord/src/registry.ts";
import { loadDiscordUsers } from "../../../discord/src/users.ts";
import { DiscordApi } from "../../../discord/src/client.ts";
import { moderate } from "../../../discord/src/moderation.ts";
import { syncDiscordCommands } from "../../../discord/src/command-catalog.ts";
import type { ModerationAction } from "../../../discord/src/moderation.ts";

function permissions(): string {
  const bits: bigint[] = [1n << 10n, 1n << 11n, 1n << 38n, 1n << 35n, 1n << 34n, 1n << 16n, 1n << 15n, 1n << 14n, 1n << 6n, 1n << 13n, 1n << 40n, 1n << 1n, 1n << 2n, 1n << 7n];
  return bits.reduce((sum, bit) => sum | bit, 0n).toString();
}

function invite(applicationId: string): string {
  return "https://discord.com/oauth2/authorize?client_id=" + applicationId + "&permissions=" + permissions() + "&scope=bot%20applications.commands";
}

async function bot(label?: string) {
  const registry = await loadDiscordRegistry();
  const entry = label ? discordBotByLabel(registry, label) : defaultDiscordBot(registry);
  if (!entry) fail("no Discord bot configured; run dura init --platform discord", 4);
  const config = await readConfig();
  return { entry, api: new DiscordApi({ token: entry.token, apiBase: config.discord.apiBase, label: entry.label }) };
}

async function daemon(): Promise<DaemonClient | undefined> {
  try {
    return await DaemonClient.connect(undefined, 700);
  } catch (error) {
    if (error instanceof DaemonUnavailable) return undefined;
    throw error;
  }
}

export async function runDiscord(parsed: Parsed): Promise<void> {
  const [action = "whoami"] = parsed.positional;
  const label = flag(parsed, "bot");

  if (action === "whoami") {
    const { entry, api } = await bot(label);
    const me = await api.getMe();
    const application = await api.getApplication().catch(() => undefined);
    if (has(parsed, "json")) {
      json({ label: entry.label, id: me.id, username: me.username, applicationId: application?.id ?? entry.applicationId });
      return;
    }
    print("bot " + entry.label + " · @ " + me.username + " · id " + me.id);
    print("application " + (application?.id ?? entry.applicationId));
    print("invite " + invite(application?.id ?? entry.applicationId));
    return;
  }

  if (action === "test") {
    const { entry, api } = await bot(label);
    const users = await loadDiscordUsers();
    if (!users.owner) fail("no owner yet; run dura init --platform discord", 4);
    const dm = await api.createDM(users.owner);
    const message = await api.sendMessage(dm.id, { content: "dura test · " + new Date().toISOString(), allowed_mentions: { parse: [] } });
    if (has(parsed, "json")) json({ label: entry.label, messageId: message.id, owner: users.owner });
    else print(paint("green", "sent") + " message " + message.id + " to owner " + users.owner + " via " + entry.label);
    return;
  }

  if (action === "invite") {
    const { entry } = await bot(label);
    if (has(parsed, "json")) json({ url: invite(entry.applicationId), applicationId: entry.applicationId });
    else {
      print(paint("green", "invite URL") + " (bot + applications.commands):");
      print(invite(entry.applicationId));
      print(paint("dim", "Enable Message Content Intent in the Developer Portal before inviting."));
    }
    return;
  }

  if (action === "threads") {
    const guildId = flag(parsed, "guild") ?? fail("usage: dura discord threads --guild <id>", 2);
    const running = await daemon();
    if (running) {
      try {
        const threads = await running.request<unknown[]>("discord.threads", { guildId });
        if (has(parsed, "json")) json(threads);
        else for (const thread of threads as { id: string; name?: string; archived?: boolean }[]) print("· " + (thread.name ?? thread.id) + " · " + thread.id + (thread.archived ? " · archived" : ""));
        return;
      } finally {
        running.close();
      }
    }
    const { api } = await bot(label);
    const threads = await api.listActiveThreads(guildId);
    if (has(parsed, "json")) json(threads);
    else for (const thread of threads) print("· " + (thread.name ?? thread.id) + " · " + thread.id);
    return;
  }

  if (action === "mod") {
    const moderationAction = parsed.positional[1] as ModerationAction | undefined;
    if (!moderationAction || !["timeout", "kick", "ban", "unban", "warn"].includes(moderationAction)) {
      fail("usage: dura discord mod <timeout|kick|ban|unban|warn> --guild <id> --user <id> --reason <text>", 2);
    }
    if ((moderationAction === "kick" || moderationAction === "ban") && !has(parsed, "yes")) {
      fail("refusing to " + moderationAction + " without --yes", 4);
    }
    const guildId = flag(parsed, "guild") ?? fail("--guild is required", 2);
    const userId = flag(parsed, "user") ?? fail("--user is required", 2);
    const reason = flag(parsed, "reason") ?? fail("--reason is required", 2);
    const minutes = Number(flag(parsed, "minutes") ?? "10");
    const deleteDays = Number(flag(parsed, "delete-days") ?? "0");
    const running = await daemon();
    if (running) {
      try {
        const result = await running.request<{ ok: boolean; text?: string; error?: string }>("discord.mod", {
          action: moderationAction,
          guildId,
          userId,
          reason,
          ...(moderationAction === "timeout" ? { minutes } : {}),
          ...(moderationAction === "ban" ? { deleteDays } : {}),
        });
        if (!result.ok) fail(result.error ?? "moderation failed", 1);
        if (has(parsed, "json")) json(result);
        else print(paint("green", "ok") + " " + (result.text ?? moderationAction));
        return;
      } finally {
        running.close();
      }
    }
    const { entry, api } = await bot(label);
    const result = await moderate(api, {
      action: moderationAction,
      guildId,
      userId,
      moderatorId: "cli",
      botId: entry.botId,
      reason,
      ...(moderationAction === "timeout" ? { minutes } : {}),
      ...(moderationAction === "ban" ? { deleteDays } : {}),
    });
    if (!result.ok) fail(result.error, 1);
    if (has(parsed, "json")) json(result);
    else print(paint("green", "ok") + " " + result.text);
    return;
  }

  if (action === "commands") {
    const sub = parsed.positional[1] ?? "sync";
    if (sub !== "sync") fail("usage: dura discord commands sync", 2);
    const running = await daemon();
    if (running) {
      try {
        const result = await running.request<{ count: number }>("discord.commands", label ? { label } : {});
        if (has(parsed, "json")) json(result);
        else print(paint("green", "synced") + " " + result.count + " commands");
        return;
      } finally {
        running.close();
      }
    }
    const { entry, api } = await bot(label);
    const result = await syncDiscordCommands(api, entry.applicationId);
    if (has(parsed, "json")) json(result);
    else print(paint("green", "synced") + " " + result.count + " commands");
    return;
  }

  if (action === "list") {
    const registry = await loadDiscordRegistry();
    if (has(parsed, "json")) json(publicDiscordRegistry(registry));
    else for (const entry of registry.bots) print("· " + entry.label + " · @" + entry.username + " · default " + (entry.defaultAgent ?? "none"));
    return;
  }

  fail("usage: dura discord <whoami|test|invite|threads|mod|commands|list>", 2);
}
