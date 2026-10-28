import { type Parsed, flag, has } from "../args.ts";
import { fail, json, paint, print } from "../output.ts";
import { botByLabel, defaultBot, loadRegistry } from "../../../telegram/src/registry.ts";
import { loadUsers } from "../../../telegram/src/users.ts";
import { BotApi } from "../../../telegram/src/client.ts";
import { readConfig } from "../../../core/src/config.ts";

export async function runTelegram(parsed: Parsed): Promise<void> {
  const [action = "whoami"] = parsed.positional;
  const registry = await loadRegistry();
  const label = flag(parsed, "bot") ?? registry.default;
  const bot = botByLabel(registry, label) ?? defaultBot(registry);
  if (!bot) fail("no bots configured; run dura init (step 3) or dura bot add", 4);
  const config = await readConfig();
  const api = new BotApi({ token: bot.token, apiBase: config.telegram.apiBase, label: bot.label });

  if (action === "whoami") {
    const me = await api.getMe();
    if (has(parsed, "json")) json({ label: bot.label, ...me });
    else {
      print("bot " + bot.label + " · @" + me.username + " · id " + me.id);
      print("api " + config.telegram.apiBase);
    }
    return;
  }

  if (action === "test") {
    const users = await loadUsers();
    if (!users.owner) fail("no owner yet; run dura init step 3", 4);
    const message = await api.sendMessage(users.owner, "dura test · " + new Date().toISOString());
    if (has(parsed, "json")) json({ label: bot.label, messageId: message.message_id, owner: users.owner });
    else print(paint("green", "sent") + " message " + message.message_id + " to owner " + users.owner + " via " + bot.label);
    return;
  }

  fail("usage: dura telegram <whoami|test> [--bot label]", 2);
}
