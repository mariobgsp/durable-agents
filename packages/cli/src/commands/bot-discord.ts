import { type Parsed, flag, has } from "../args.ts";
import { fail, json, paint, print, table } from "../output.ts";
import { DaemonClient, DaemonUnavailable } from "../client.ts";
import { readConfig } from "../../../core/src/config.ts";
import { readAgent } from "../../../core/src/agents.ts";
import {
  addDiscordBot,
  defaultDiscordBot,
  discordBotByLabel,
  loadDiscordRegistry,
  maskDiscordToken,
  publicDiscordRegistry,
  removeDiscordBot,
  setDefaultDiscordBot,
  setDiscordBotDefaultAgent,
  setDiscordBotEnabled,
} from "../../../discord/src/registry.ts";
import { DiscordApi } from "../../../discord/src/client.ts";
import { secret } from "../prompts.ts";
import { loadDiscordState } from "../../../discord/src/state.ts";

async function daemon(): Promise<DaemonClient | undefined> {
  try {
    return await DaemonClient.connect(undefined, 700);
  } catch (error) {
    if (error instanceof DaemonUnavailable) return undefined;
    throw error;
  }
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 32) || "bot";
}

export async function runDiscordBot(parsed: Parsed): Promise<void> {
  const [action = "list", target] = parsed.positional;

  if (action === "list") {
    const [registry, state] = await Promise.all([loadDiscordRegistry(), loadDiscordState()]);
    if (has(parsed, "json")) {
      json({ ...publicDiscordRegistry(registry), health: state.bots });
      return;
    }
    if (registry.bots.length === 0) {
      print("no Discord bots yet; run dura init --platform discord or dura bot add");
      return;
    }
    table(
      ["label", "username", "default agent", "default", "enabled", "gateway"],
      registry.bots.map((bot) => [
        bot.label,
        "@" + bot.username,
        bot.defaultAgent ?? paint("yellow", "none"),
        bot.label === registry.default ? paint("green", "yes") : "",
        bot.enabled ? "yes" : "no",
        state.bots[bot.label]?.health.ok ? paint("green", "ready") : state.bots[bot.label]?.health.lastError ? paint("red", "error") : "unknown",
      ]),
    );
    return;
  }

  if (action === "add") {
    const config = await readConfig();
    let token = flag(parsed, "token");
    if (!token) token = process.env.DURA_DISCORD_TOKEN;
    if (!token) {
      const pair = process.env.DURA_DISCORD_BOTS?.split(",")[0];
      if (pair?.includes(":")) token = pair.slice(pair.indexOf(":") + 1);
    }
    if (!token) token = await secret("Discord bot token");
    if (!token.trim()) fail("a token is required", 2);
    const api = new DiscordApi({ token: token.trim(), apiBase: config.discord.apiBase });
    let me;
    try {
      me = await api.getMe();
    } catch (error) {
      fail("Discord rejected the token: " + (error instanceof Error ? error.message : String(error)), 4);
    }
    const application = await api.getApplication().catch(() => undefined);
    const label = (flag(parsed, "label") ?? slug(me.username)).toLowerCase();
    const agent = flag(parsed, "agent");
    if (agent && !(await readAgent(agent))) fail("unknown agent: " + agent, 4);
    const running = await daemon();
    if (running) {
      try {
        const result = await running.request<{ label: string; username: string; agent: string | null }>("bots.add", {
          token: token.trim(),
          label,
          ...(agent ? { agent } : {}),
        });
        if (has(parsed, "json")) json(result);
        else print(paint("green", "bot added") + " " + result.label + " · @" + result.username + (result.agent ? " · default " + result.agent : ""));
        return;
      } finally {
        running.close();
      }
    }
    await addDiscordBot({
      label,
      token: token.trim(),
      applicationId: application?.id ?? me.id,
      botId: me.id,
      username: me.username,
      ...(agent ? { defaultAgent: agent } : {}),
    });
    if (has(parsed, "json")) json({ label, username: me.username, botId: me.id, agent: agent ?? null });
    else print(paint("green", "bot added") + " " + label + " · @" + me.username + " · token " + maskDiscordToken(token));
    return;
  }

  if (action === "connect") {
    const label = target ?? fail("usage: dura bot connect <label> <agent-id>", 2);
    const agent = parsed.positional[2] ?? fail("usage: dura bot connect <label> <agent-id>", 2);
    if (!(await readAgent(agent))) fail("unknown agent: " + agent, 4);
    const running = await daemon();
    if (running) {
      try {
        const result = await running.request<{ agentId: string; freed: string[] }>("bots.pair", { bot: label, agent });
        if (has(parsed, "json")) json(result);
        else print(paint("green", "default agent") + " " + label + " → " + agent);
        return;
      } finally {
        running.close();
      }
    }
    await setDiscordBotDefaultAgent(label, agent);
    print(paint("green", "default agent") + " " + label + " → " + agent + " (restart the daemon to apply)");
    return;
  }

  if (action === "disconnect") {
    const label = target ?? fail("usage: dura bot disconnect <label>", 2);
    const running = await daemon();
    if (running) {
      try {
        const result = await running.request<{ freed: string[] }>("bots.release", { bot: label });
        if (has(parsed, "json")) json(result);
        else print(result.freed.length ? "cleared " + result.freed.join(", ") : "no default agent on " + label);
        return;
      } finally {
        running.close();
      }
    }
    await setDiscordBotDefaultAgent(label, null);
    print("cleared default agent on " + label);
    return;
  }

  if (action === "remove") {
    const label = target ?? fail("usage: dura bot remove <label>", 2);
    const running = await daemon();
    if (running) {
      try {
        await running.request("bots.remove", { label });
        if (has(parsed, "json")) json({ removed: true, label });
        else print("removed bot " + label);
        return;
      } finally {
        running.close();
      }
    }
    await removeDiscordBot(label);
    print("removed bot " + label);
    return;
  }

  if (action === "default") {
    const label = target ?? fail("usage: dura bot default <label>", 2);
    await setDefaultDiscordBot(label);
    print("default bot: " + label);
    return;
  }

  if (action === "enable" || action === "disable") {
    const label = target ?? fail("usage: dura bot " + action + " <label>", 2);
    const running = await daemon();
    if (running) {
      try {
        await running.request(action === "enable" ? "bots.enable" : "bots.disable", { label });
        print(label + " " + (action === "enable" ? "enabled" : "disabled"));
        return;
      } finally {
        running.close();
      }
    }
    await setDiscordBotEnabled(label, action === "enable");
    print(label + " " + (action === "enable" ? "enabled" : "disabled") + " (restart to apply)");
    return;
  }

  if (action === "test") {
    const registry = await loadDiscordRegistry();
    const bots = target ? [discordBotByLabel(registry, target)].filter(Boolean) : registry.bots;
    if (bots.length === 0) fail("no bots configured", 4);
    const config = await readConfig();
    const rows: string[][] = [];
    for (const bot of bots) {
      if (!bot) continue;
      try {
        const me = await new DiscordApi({ token: bot.token, apiBase: config.discord.apiBase, label: bot.label }).getMe();
        rows.push([bot.label, paint("green", "ok"), "@" + me.username + " · id " + me.id]);
      } catch (error) {
        rows.push([bot.label, paint("red", "FAIL"), String(error)]);
      }
    }
    if (has(parsed, "json")) json({ results: rows });
    else table(["bot", "result", "detail"], rows);
    return;
  }

  if (action === "normalize") {
    print("Discord has no per-agent bot assignments; nothing to normalize.");
    return;
  }

  fail("usage: dura bot <list|add|connect|disconnect|remove|default|enable|disable|test|normalize>", 2);
}
