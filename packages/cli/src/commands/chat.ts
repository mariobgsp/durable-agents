import { type Parsed, flag, has } from "../args.ts";
import { fail, json, paint, print, table } from "../output.ts";
import { DaemonClient, DaemonUnavailable } from "../client.ts";
import { startDetached } from "./start.ts";
import { runStop } from "./stop.ts";
import {
  readConfig,
  updateConfig,
  validateConfig,
  type ChatPlatform,
} from "../../../core/src/config.ts";
import { loadRegistry } from "../../../telegram/src/registry.ts";
import { loadUsers } from "../../../telegram/src/users.ts";
import { listAgents } from "../../../core/src/agents.ts";
import { updateAgent } from "../../../core/src/agent-admin.ts";
import { loadDiscordRegistry } from "../../../discord/src/registry.ts";
import { loadDiscordUsers } from "../../../discord/src/users.ts";

function parsePlatform(value: string | undefined): ChatPlatform {
  if (value === "telegram" || value === "discord") return value;
  fail("usage: dura chat use <telegram|discord>", 2);
  throw new Error("unreachable");
}

async function readiness(platform: ChatPlatform): Promise<{ ready: boolean; detail: string }> {
  if (platform === "telegram") {
    const [registry, users] = await Promise.all([loadRegistry(), loadUsers()]);
    const ok = registry.bots.length > 0 && Boolean(users.owner);
    return { ready: ok, detail: registry.bots.length + " bot(s), owner " + (users.owner ?? "missing") };
  }
  const [registry, users] = await Promise.all([loadDiscordRegistry(), loadDiscordUsers()]);
  const ok = registry.bots.length > 0 && Boolean(users.owner);
  return { ready: ok, detail: registry.bots.length + " bot(s), owner " + (users.owner ?? "missing") };
}

async function daemonStatus(): Promise<Record<string, unknown> | undefined> {
  try {
    const client = await DaemonClient.connect(undefined, 700);
    try {
      return await client.request("status");
    } finally {
      client.close();
    }
  } catch (error) {
    if (error instanceof DaemonUnavailable) return undefined;
    throw error;
  }
}

export async function runChat(parsed: Parsed): Promise<void> {
  const [action = "show", target] = parsed.positional;

  if (action === "show" || action === "status") {
    const config = await readConfig({ fresh: true });
    const problems = validateConfig(config);
    const running = await daemonStatus();
    const telegram = await readiness("telegram");
    const discord = await readiness("discord");
    const active = running ? ((running.channels as { platform?: string } | null)?.platform ?? "none") : "not running";
    if (has(parsed, "json")) {
      json({ active: config.chat.active, running: active, problems, telegram, discord, status: running ?? null });
      return;
    }
    print(paint("bold", "Chat surface"));
    print("active  " + config.chat.active + (config.setup.verifiedAt ? " · verified" : " · not verified"));
    print("running " + active + (running && active !== config.chat.active ? paint("yellow", " · restart required") : ""));
    print("telegram " + (telegram.ready ? paint("green", telegram.detail) : paint("yellow", telegram.detail)));
    print("discord  " + (discord.ready ? paint("green", discord.detail) : paint("yellow", discord.detail)));
    if (problems.length > 0) {
      print("");
      print(paint("red", "config problems:"));
      for (const problem of problems) print("· " + problem);
    }
    return;
  }

  if (action === "use") {
    const platform = parsePlatform(target);
    const config = await readConfig({ fresh: true });
    if (config.chat.active === platform) {
      print("already active: " + platform);
      return;
    }
    const targetReady = await readiness(platform);
    if (!targetReady.ready) {
      fail("the " + platform + " surface is not configured (" + targetReady.detail + "); run: dura init --platform " + platform, 4);
    }
    const previous = config.chat.active;
    const wasRunning = Boolean(await daemonStatus());
    if (wasRunning) await runStop({ positional: [], flags: new Map(), booleans: new Set() });
    await updateConfig({ chat: { active: platform }, setup: { verifiedAt: null } });

    if (platform === "discord" && !has(parsed, "no-tools")) {
      const agents = await listAgents();
      let added = 0;
      for (const agent of agents) {
        if (agent.tools.includes("discord")) continue;
        await updateAgent({ id: agent.id, tools: [...agent.tools, "discord"], caller: "chat-use" });
        added += 1;
      }
      if (added > 0) print(paint("dim", "added the discord tool to " + added + " agent(s)"));
    }

    print(paint("green", "active surface") + " " + platform);
    if (!wasRunning) {
      print(paint("dim", "start it with: dura start"));
      return;
    }

    try {
      await startDetached(parsed);
      const client = await DaemonClient.connect();
      let result: { ok: boolean; checks: { name: string; ok: boolean; detail: string; required: boolean }[] };
      try {
        result = await client.request("verify.run", { agentPing: !has(parsed, "no-agent-ping") }, 180_000);
      } finally {
        client.close();
      }
      table(["check", "", "detail"], result.checks.map((check) => [check.name, check.ok ? paint("green", "ok") : check.required ? paint("red", "FAIL") : paint("yellow", "warn"), check.detail]));
      if (!result.ok) throw new Error("connection test failed; run: dura verify");
    } catch (error) {
      print(paint("red", "switch failed: " + (error instanceof Error ? error.message : String(error))));
      print(paint("yellow", "restoring " + previous));
      await runStop({ positional: [], flags: new Map(), booleans: new Set() }).catch(() => undefined);
      await updateConfig({ chat: { active: previous }, setup: { verifiedAt: null } });
      await startDetached(parsed).catch((restoreError) => print(paint("red", "could not restart " + previous + ": " + String(restoreError))));
      process.exit(1);
    }
    return;
  }

  fail("usage: dura chat <show|use|status>", 2);
}
