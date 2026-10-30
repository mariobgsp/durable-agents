import { type Parsed, flag, has } from "../args.ts";
import { fail, json, paint, print, table } from "../output.ts";
import {
  addDiscordUser,
  approveDiscordPending,
  denyDiscordPending,
  loadDiscordUsers,
  removeDiscordUser,
  setDiscordOwner,
} from "../../../discord/src/users.ts";

export async function runDiscordUser(parsed: Parsed): Promise<void> {
  const [action = "list", target] = parsed.positional;

  if (action === "list") {
    const users = await loadDiscordUsers();
    if (has(parsed, "json")) return void json(users);
    table(
      ["id", "username", "role", "added"],
      users.users.map((user) => [user.id, user.username ?? "-", user.role, new Date(user.addedAt).toLocaleDateString()]),
    );
    if (users.owner === null) print(paint("yellow", "no owner yet; run dura init --platform discord or dura user owner <id>"));
    return;
  }

  if (action === "add") {
    const id = target ?? fail("usage: dura user add <discord-id> [--username name]", 2);
    const users = await addDiscordUser(await loadDiscordUsers(), id, flag(parsed, "username"), "cli");
    if (has(parsed, "json")) json(users);
    else print(paint("green", "added") + " " + id + " · " + users.users.length + " allowed users");
    return;
  }

  if (action === "remove") {
    const id = target ?? fail("usage: dura user remove <discord-id>", 2);
    const users = await removeDiscordUser(await loadDiscordUsers(), id);
    if (has(parsed, "json")) json(users);
    else print("removed " + id);
    return;
  }

  if (action === "owner") {
    const id = target ?? fail("usage: dura user owner <discord-id>", 2);
    const users = await setDiscordOwner(await loadDiscordUsers(), id, flag(parsed, "username"));
    if (has(parsed, "json")) json(users);
    else print(paint("green", "owner set") + " " + id);
    return;
  }

  if (action === "pending") {
    const users = await loadDiscordUsers();
    if (has(parsed, "json")) json(users.pending);
    else if (users.pending.length === 0) print("no pending users");
    else table(["id", "username", "first seen", "last text"], users.pending.map((user) => [user.id, user.username ?? "-", new Date(user.firstSeenAt).toLocaleString(), user.lastText ?? "-"]));
    return;
  }

  if (action === "approve") {
    const id = target ?? fail("usage: dura user approve <discord-id>", 2);
    const users = await approveDiscordPending(await loadDiscordUsers(), id, "cli");
    if (has(parsed, "json")) json(users);
    else print(paint("green", "approved") + " " + id);
    return;
  }

  if (action === "deny") {
    const id = target ?? fail("usage: dura user deny <discord-id>", 2);
    const users = await denyDiscordPending(await loadDiscordUsers(), id);
    if (has(parsed, "json")) json(users);
    else print("denied " + id);
    return;
  }

  if (action === "invite") {
    fail("Discord uses a bot invite URL: dura discord invite", 2);
  }

  fail("usage: dura user <list|add|remove|owner|pending|approve|deny>", 2);
}
