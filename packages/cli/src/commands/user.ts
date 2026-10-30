import { type Parsed, flag, has } from "../args.ts";
import { fail, json, paint, print, table } from "../output.ts";
import {
  addUser,
  approvePending,
  denyPending,
  loadUsers,
  removeUser,
  setOwner,
} from "../../../telegram/src/users.ts";
import { botByLabel, loadRegistry } from "../../../telegram/src/registry.ts";
import { BotApi } from "../../../telegram/src/client.ts";
import { readConfig } from "../../../core/src/config.ts";

export async function runUser(parsed: Parsed): Promise<void> {
  const active = await readConfig();
  if (active.chat.active === "discord") {
    const { runDiscordUser } = await import("./user-discord.ts");
    return runDiscordUser(parsed);
  }
  const [action = "list", target] = parsed.positional;

  if (action === "list") {
    const users = await loadUsers();
    if (has(parsed, "json")) {
      json(users);
      return;
    }
    table(
      ["id", "username", "role", "added"],
      users.users.map((user) => [user.id, user.username ?? "-", user.role, new Date(user.addedAt).toLocaleDateString()]),
    );
    if (users.owner === null) print(paint("yellow", "no owner yet; run dura init step 3 or dura user owner <id>"));
    return;
  }

  if (action === "add") {
    const id = target ?? fail("usage: dura user add <telegram-id> [--username name]", 2);
    const users = await addUser(await loadUsers(), id, flag(parsed, "username"), "cli");
    if (has(parsed, "json")) json(users);
    else print(paint("green", "added") + " " + id + " · " + users.users.length + " allowed users");
    return;
  }

  if (action === "remove") {
    const id = target ?? fail("usage: dura user remove <telegram-id>", 2);
    const users = await removeUser(await loadUsers(), id);
    if (has(parsed, "json")) json(users);
    else print("removed " + id);
    return;
  }

  if (action === "owner") {
    const id = target ?? fail("usage: dura user owner <telegram-id>", 2);
    const users = await setOwner(await loadUsers(), id, flag(parsed, "username"));
    if (has(parsed, "json")) json(users);
    else print(paint("green", "owner set") + " " + id);
    return;
  }

  if (action === "pending") {
    const users = await loadUsers();
    if (has(parsed, "json")) json(users.pending);
    else if (users.pending.length === 0) print("no pending users");
    else table(["id", "username", "first seen", "last text"], users.pending.map((user) => [user.id, user.username ?? "-", new Date(user.firstSeenAt).toLocaleString(), user.lastText ?? "-"]));
    return;
  }

  if (action === "approve") {
    const id = target ?? fail("usage: dura user approve <telegram-id>", 2);
    const users = await approvePending(await loadUsers(), id, "cli");
    if (has(parsed, "json")) json(users);
    else print(paint("green", "approved") + " " + id);
    return;
  }

  if (action === "deny") {
    const id = target ?? fail("usage: dura user deny <telegram-id>", 2);
    const users = await denyPending(await loadUsers(), id);
    if (has(parsed, "json")) json(users);
    else print("denied " + id);
    return;
  }

  if (action === "invite") {
    const chat = flag(parsed, "chat") ?? fail("usage: dura user invite --chat <chat-id> [--bot label]", 2);
    const registry = await loadRegistry();
    const label = flag(parsed, "bot") ?? registry.default;
    const bot = botByLabel(registry, label);
    if (!bot) fail("unknown bot: " + label, 4);
    const config = await readConfig();
    const api = new BotApi({ token: bot.token, apiBase: config.telegram.apiBase, label });
    const link = await api.createInviteLink(chat, "dura", 1);
    if (has(parsed, "json")) json({ link });
    else {
      print(paint("green", "invite link") + " (single use, 24h):");
      print(link);
      print(paint("dim", "a bot cannot add members directly; send this link, then add the user id with dura user add"));
    }
    return;
  }

  fail("usage: dura user <list|add|remove|owner|pending|approve|deny|invite>", 2);
}
