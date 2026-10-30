import { type Parsed, flag, has } from "../args.ts";
import { fail, json, paint, print, table } from "../output.ts";
import {
  addBot,
  botByLabel,
  loadRegistry,
  maskToken,
  publicRegistry,
  RegistryError,
  removeBot,
  setBotEnabled,
  setDefaultBot,
} from "../../../telegram/src/registry.ts";
import { loadState, setHealth } from "../../../telegram/src/state.ts";
import { BotApi } from "../../../telegram/src/client.ts";
import { syncBotCommands } from "../../../telegram/src/command-catalog.ts";
import { listAgents } from "../../../core/src/agents.ts";
import { readConfig } from "../../../core/src/config.ts";
import { secret } from "../prompts.ts";
import { DaemonClient, DaemonUnavailable } from "../client.ts";
import { useBotRegistry } from "../bots.ts";
import { assignBotToAgent, normalizeBotAssignments, releaseBot } from "../../../core/src/agent-admin.ts";

async function daemonOrUndefined(): Promise<DaemonClient | undefined> {
  try {
    return await DaemonClient.connect(undefined, 700);
  } catch (error) {
    if (error instanceof DaemonUnavailable) return undefined;
    throw error;
  }
}

function slugFromUsername(username: string): string {
  const base = username.replace(/_?bot$/i, "").replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase();
  return (base || "bot").slice(0, 32).replace(/^-+|-+$/g, "") || "bot";
}

async function apiFor(label: string): Promise<{ api: BotApi; token: string }> {
  const registry = await loadRegistry();
  const bot = botByLabel(registry, label);
  if (!bot) fail("unknown bot: " + label + " (dura bot list)", 4);
  const config = await readConfig();
  return { api: new BotApi({ token: bot.token, apiBase: config.telegram.apiBase, label }), token: bot.token };
}

export async function runBot(parsed: Parsed): Promise<void> {
  const active = await readConfig();
  if (active.chat.active === "discord") {
    const { runDiscordBot } = await import("./bot-discord.ts");
    return runDiscordBot(parsed);
  }
  const [action = "list", target] = parsed.positional;

  if (action === "list") {
    const [registry, state, agents] = await Promise.all([loadRegistry(), loadState(), listAgents()]);
    if (has(parsed, "json")) {
      json({
        ...publicRegistry(registry),
        health: Object.fromEntries(Object.entries(state.bots).map(([label, bot]) => [label, bot.health])),
        agents: Object.fromEntries(registry.bots.map((bot) => [bot.label, agents.filter((agent) => agent.telegramBot === bot.label).length])),
      });
      return;
    }
    if (registry.bots.length === 0) {
      print("no bots yet; run dura init (step 3) or dura bot add");
      return;
    }
    table(
      ["label", "username", "agent", "default", "enabled", "poll"],
      registry.bots.map((bot) => {
        const holder = agents.find((agent) => agent.telegramBot === bot.label);
        return [
          bot.label,
          "@" + bot.username,
          holder ? holder.id : paint("yellow", "unpaired"),
          bot.label === registry.default ? paint("green", "yes") : "",
          bot.enabled ? "yes" : "no",
          state.bots[bot.label]?.health.ok === true ? paint("green", "ok") : state.bots[bot.label]?.health.lastError ? paint("red", "error") : "unknown",
        ];
      }),
    );
    return;
  }

  if (action === "add") {
    let token = flag(parsed, "token");
    if (!token) {
      const env = process.env.DURA_TELEGRAM_BOTS;
      if (env) {
        const first = env.split(",").map((part) => part.split(":")[0]);
        const pair = env.split(",")[0];
        if (pair && pair.includes(":")) token = pair.slice(pair.indexOf(":") + 1);
        if (first.length > 1) print(paint("dim", "using the first token from DURA_TELEGRAM_BOTS; add the rest one by one"));
      }
    }
    if (!token) token = await secret("Bot token from @BotFather");
    if (!token.includes(":")) fail("that does not look like a bot token", 2);
    const running = await daemonOrUndefined();
    if (running) {
      try {
        const result = await running.request<{ label: string; username: string }>("bots.add", {
          token,
          ...(flag(parsed, "label") ? { label: flag(parsed, "label") } : {}),
        });
        const agent = flag(parsed, "agent");
        if (agent) await running.request("bots.pair", { bot: result.label, agent });
        if (has(parsed, "json")) json({ ...result, agent: agent ?? null });
        else {
          print(paint("green", "bot added") + " " + result.label + " · @" + result.username + " · " + (agent ? "agent " + agent : paint("yellow", "unpaired")));
          if (!agent) print(paint("dim", "connect it with: dura bot connect " + result.label + " <agent>"));
        }
        return;
      } finally {
        running.close();
      }
    }
    const config = await readConfig();
    const api = new BotApi({ token, apiBase: config.telegram.apiBase });
    const me = await api.getMe();
    if (!me.username) fail("the bot has no username", 4);
    const label = (flag(parsed, "label") ?? slugFromUsername(me.username)).toLowerCase();
    try {
      await addBot({ label, token, botId: String(me.id), username: me.username });
    } catch (error) {
      if (error instanceof RegistryError) fail(error.message, 4);
      throw error;
    }
    const synced = await syncBotCommands(api).catch(() => ({ cleared: 0, set: 0 }));
    print(paint("dim", "commands synced: " + synced.set + " scopes, " + synced.cleared + " old sets cleared"));
    const agent = flag(parsed, "agent");
    if (agent) {
      await useBotRegistry();
      await assignBotToAgent(label, agent, "cli");
    }
    if (has(parsed, "json")) json({ label, username: me.username, botId: me.id, agent: agent ?? null });
    else {
      print(paint("green", "bot added") + " " + label + " · @" + me.username + " · token " + maskToken(token));
      print(paint("dim", agent ? "connected to " + agent : "unpaired; connect it with: dura bot connect " + label + " <agent>"));
    }
    return;
  }

  if (action === "connect") {
    const label = target ?? fail("usage: dura bot connect <label> <agent-id>", 2);
    const agent = parsed.positional[2] ?? fail("usage: dura bot connect <label> <agent-id>", 2);
    const running = await daemonOrUndefined();
    if (running) {
      try {
        const result = await running.request<{ agentId: string; freed: string[] }>("bots.pair", { bot: label, agent });
        if (has(parsed, "json")) json(result);
        else print(paint("green", "connected") + " " + label + " → " + agent + (result.freed.length ? " · unpaired " + result.freed.join(", ") : ""));
        return;
      } finally {
        running.close();
      }
    }
    await useBotRegistry();
    const result = await assignBotToAgent(label, agent, "cli");
    print(paint("green", "connected") + " " + label + " → " + agent + " (restart the daemon to rebind)");
    return;
  }

  if (action === "disconnect") {
    const label = target ?? fail("usage: dura bot disconnect <label>", 2);
    const running = await daemonOrUndefined();
    if (running) {
      try {
        const result = await running.request<{ freed: string[] }>("bots.release", { bot: label });
        if (has(parsed, "json")) json(result);
        else print(result.freed.length ? "unpaired " + result.freed.join(", ") : "no agent held " + label);
        return;
      } finally {
        running.close();
      }
    }
    print("unpaired " + (await releaseBot(label, "cli")).join(", "));
    return;
  }

  if (action === "normalize") {
    const running = await daemonOrUndefined();
    if (running) {
      try {
        const result = await running.request<{ cleared: { agentId: string; bot: string }[] }>("bots.normalize");
        if (has(parsed, "json")) json(result);
        else print(result.cleared.length ? "unpaired: " + result.cleared.map((entry) => entry.agentId).join(", ") : "no duplicate bot assignments");
        return;
      } finally {
        running.close();
      }
    }
    const cleared = await normalizeBotAssignments();
    print(cleared.length ? "unpaired: " + cleared.map((entry) => entry.agentId).join(", ") : "no duplicate bot assignments");
    return;
  }

  if (action === "remove") {
    const label = target ?? fail("usage: dura bot remove <label>", 2);
    const registry = await loadRegistry();
    const agents = await listAgents();
    const used = agents.filter((agent) => agent.telegramBot === label);
    if (used.length > 0) {
      fail("agents still use this bot: " + used.map((agent) => agent.id).join(", ") + "; reassign them first", 4);
    }
    if (registry.bots.some((bot) => bot.label === label)) await removeBot(label);
    if (has(parsed, "json")) json({ removed: true, label });
    else print("removed bot " + label);
    return;
  }

  if (action === "default") {
    const label = target ?? fail("usage: dura bot default <label>", 2);
    await setDefaultBot(label);
    print("default bot: " + label);
    return;
  }

  if (action === "enable" || action === "disable") {
    const label = target ?? fail("usage: dura bot " + action + " <label>", 2);
    await setBotEnabled(label, action === "enable");
    print(label + " " + (action === "enable" ? "enabled" : "disabled"));
    return;
  }

  if (action === "test") {
    const registry = await loadRegistry();
    const labels = target ? [target] : registry.bots.map((bot) => bot.label);
    if (labels.length === 0) fail("no bots configured", 4);
    const state = await loadState();
    const rows: string[][] = [];
    for (const label of labels) {
      const { api } = await apiFor(label);
      try {
        const me = await api.getMe();
        await setHealth(state, label, { ok: true, checkedAt: Date.now(), username: me.username });
        rows.push([label, paint("green", "ok"), "@" + me.username + " · id " + me.id]);
      } catch (error) {
        await setHealth(state, label, { ok: false, checkedAt: Date.now(), lastError: String(error) });
        rows.push([label, paint("red", "FAIL"), String(error)]);
      }
    }
    if (has(parsed, "json")) json({ results: rows });
    else table(["bot", "result", "detail"], rows);
    return;
  }

  fail("usage: dura bot <list|add|connect|disconnect|normalize|remove|default|enable|disable|test>", 2);
}
