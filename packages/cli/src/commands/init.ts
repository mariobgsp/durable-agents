import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type Parsed, flag, has } from "../args.ts";
import { fail, json, paint, print, table, bytes } from "../output.ts";
import { ask, choose, confirm, interactive, secret } from "../prompts.ts";
import { DaemonClient, DaemonUnavailable } from "../client.ts";
import { startDetached } from "./start.ts";
import { runStop } from "./stop.ts";
import { useBotRegistry } from "../bots.ts";
import { createAgent } from "../../../core/src/agent-admin.ts";
import { listAgents, readAgent } from "../../../core/src/agents.ts";
import { completeStep, isSurfaceComplete, readConfig, surfaceStep, updateConfig, type ChatPlatform, type DuraConfig } from "../../../core/src/config.ts";
import { createOrchestrator, hydrateOrchestrator, orchestratorId, replaceOrchestrator } from "../../../core/src/orchestrator.ts";
import { addProviderKey, builtinProviderIds, providerRows, testProvider } from "../../../core/src/providers.ts";
import { models } from "../../../core/src/models.ts";
import { BotApi } from "../../../telegram/src/client.ts";
import { addBot, defaultBot, loadRegistry, setDefaultBot } from "../../../telegram/src/registry.ts";
import { loadUsers, setOwner } from "../../../telegram/src/users.ts";
import { DiscordApi } from "../../../discord/src/client.ts";
import {
  addDiscordBot,
  defaultDiscordBot,
  loadDiscordRegistry,
  setDefaultDiscordBot,
  setDiscordBotDefaultAgent,
} from "../../../discord/src/registry.ts";
import { loadDiscordUsers, setDiscordOwner } from "../../../discord/src/users.ts";
import { duraHome, repoRoot } from "../../../core/src/paths.ts";
import { runMigrate } from "./migrate.ts";
import { runService } from "./service.ts";
import { runTune } from "./tune.ts";

/**
 * The setup wizard. Strictly sequential — 1 Agents, 2 Provider, 3 Chat surface, 4 Service, 5
 * Connection test — with completion recorded in config.setup so a re-run resumes at the first
 * unfinished step and a passing test is the only proof of success. Step 3 chooses Telegram or
 * Discord; only that surface is configured, and only one is ever active.
 */

type Staged = {
  name: string;
  id?: string;
  responsibility?: string;
  telegramBot?: string;
  orchestrator: boolean;
  replacing?: boolean;
};

type WizardState = { staged: Staged[] };

const STEPS = ["agents", "provider", "chat", "service", "test"] as const;
type Step = (typeof STEPS)[number];
const TITLES: Record<Step, string> = {
  agents: "Agents",
  provider: "Provider",
  chat: "Chat surface",
  service: "Service and tuning",
  test: "Connection test",
};

function stepNumber(step: Step): number {
  return STEPS.indexOf(step) + 1;
}

async function waitForDaemon(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await daemonRunning()) return true;
    await new Promise((done) => setTimeout(done, 250));
  }
  return false;
}

async function daemonRunning(): Promise<boolean> {
  try {
    const client = await DaemonClient.connect(undefined, 700);
    client.close();
    return true;
  } catch (error) {
    if (error instanceof DaemonUnavailable) return false;
    throw error;
  }
}

async function maybeMigration(): Promise<void> {
  const source = resolve(repoRoot, "data");
  const hasSource = await stat(resolve(source, "sessions.json")).then(() => true).catch(() => false);
  const hasDest = await stat(resolve(duraHome, "app.sqlite")).then(() => true).catch(() => false);
  if (!hasSource || hasDest) return;
  if (!(await confirm("Existing data found at " + source + ". Import it into " + duraHome + "?", true))) return;
  await runMigrate({ positional: [], flags: new Map(), booleans: new Set(["yes"]) });
}

async function stepAgents(state: WizardState, config: DuraConfig): Promise<void> {
  print(paint("bold", "Step " + stepNumber("agents") + " of 5 — Agent setup"));
  print(paint("dim", "Model is chosen in step 2 and the bot in step 3; agents are written at the end of step 3."));
  await hydrateOrchestrator();
  const current = orchestratorId();
  const agents = await listAgents();

  if (!current) {
    const create = has(parsedFlags, "yes") ? true : await confirm("No orchestrator exists. Create one now?", true);
    if (create) {
      const name = await ask("Orchestrator name", "Orchestrator");
      const responsibility = await ask("What does it own? (one line, optional)", "plans work and keeps the team coherent");
      state.staged.push({
        name,
        id: "orchestrator",
        responsibility,
        orchestrator: true,
      });
      print(paint("green", "staged") + " " + name + " as the orchestrator (model in step 2, bot in step 3)");
    } else {
      print(paint("yellow", "no orchestrator; the bot will ask you again on the first message"));
    }
  } else {
    const files = await readAgent(current);
    print("current orchestrator: " + (files?.record.name ?? current) + " (" + current + ")");
    const replace = await confirm("Replace it? (the old agent stays as a normal agent)", false);
    if (replace) {
      const name = await ask("New orchestrator name", "Orchestrator");
      state.staged.push({
        name,
        id: "orchestrator-" + Date.now().toString(36),
        orchestrator: true,
        replacing: true,
      });
      print(paint("green", "staged") + " replacement orchestrator; it becomes the pointer at the end of step 3");
    }
  }

  print("");
  print("existing agents: " + (agents.length === 0 ? "none" : agents.map((agent) => agent.id).join(", ")));
  let more = await confirm("Create another agent now?", false);
  while (more) {
    const name = await ask("Agent name");
    if (!name.trim()) {
      print(paint("yellow", "a name is required"));
      more = await confirm("Add another?", false);
      continue;
    }
    const responsibility = await ask("Responsibility (one line, optional)", "");
    state.staged.push({ name, responsibility: responsibility || undefined, orchestrator: false });
    print(paint("green", "staged") + " " + name);
    more = await confirm("Add another?", false);
  }
  await completeStep("agents");
  print(paint("green", "step complete"));
}

async function stepProvider(state: WizardState, config: DuraConfig): Promise<void> {
  print(paint("bold", ""));
  print(paint("bold", "Step " + stepNumber("provider") + " of 5 — Provider setup"));
  const rows = await providerRows(config.models.registered);
  const configured = rows.filter((row) => row.configured);
  print("current default: " + config.models.default.provider + "/" + config.models.default.modelId);
  print("configured: " + (configured.length ? configured.map((row) => row.id + " (" + row.source + ")").join(", ") : "none"));

  const choice = has(parsedFlags, "yes")
    ? "opencode"
    : await choose("Provider setup", [
        { label: "Use opencode-go (current" + (configured.some((row) => row.id === "opencode-go") ? ", credential found" : ", add a key") + ")", value: "opencode" },
        { label: "Add a provider by API key (" + (await builtinProviderIds()).length + " built in)", value: "add" },
        { label: "Skip for now (agents cannot answer)", value: "skip" },
      ]);

  if (choice === "opencode") {
    const auth = await models.getAuth("opencode-go").catch(() => undefined);
    if (!auth) {
      const key = flag(parsedFlags, "api-key") ?? (has(parsedFlags, "api-key-stdin") ? await stdinAll() : await secret("opencode-go API key"));
      if (key) {
        const result = await addProviderKey("opencode-go", key);
        print(paint("green", "saved and verified") + " " + result.models + " models");
      } else {
        print(paint("yellow", "no credential; add one later with dura provider add opencode-go"));
      }
    }
    const configNow = await readConfig({ fresh: true });
    if (flag(parsedFlags, "model")) {
      await updateConfig({ models: { default: { provider: "opencode-go", modelId: flag(parsedFlags, "model") ?? configNow.models.default.modelId } } });
    }
    print("default: " + (await readConfig({ fresh: true })).models.default.provider + "/" + (await readConfig({ fresh: true })).models.default.modelId);
  } else if (choice === "add") {
    const ids = await builtinProviderIds();
    print("");
    const id = await ask("Provider id (for example opencode-go, openai, anthropic, groq)");
    if (!ids.includes(id)) fail("not in the catalog: " + id + "\nknown: " + ids.join(", "), 2);
    const key = await secret("API key for " + id);
    const result = await addProviderKey(id, key);
    const configNow = await readConfig({ fresh: true });
    await updateConfig({ models: { registered: [...new Set([...configNow.models.registered, id])] } });
    const model = await ask("Default model for " + id, "");
    const chosenModel = model || ((await models.getAvailable(id))[0] as { id?: string } | undefined)?.id;
    if (chosenModel) {
      await updateConfig({ models: { default: { provider: id, modelId: chosenModel } } });
      print("default: " + id + "/" + chosenModel);
    }
    print(paint("green", "saved and verified") + " " + result.models + " models");
  } else {
    print(paint("yellow", "skipped; agents will have no provider until one is configured"));
  }

  const configNow = await readConfig({ fresh: true });
  if (state.staged.length > 0 && (await confirm("Apply this default model to the agents staged in step 1?", true))) {
    // Staged agents inherit the default at materialization; recording it here makes the summary honest.
    print("staged agents will use " + configNow.models.default.provider + "/" + configNow.models.default.modelId);
  }
  await completeStep("provider");
  print(paint("green", "step complete"));
}

async function stdinAll(): Promise<string> {
  return new Promise((resolveText) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (body += String(chunk)));
    process.stdin.on("end", () => resolveText(body.trim()));
  });
}

async function bindOwner(api: BotApi): Promise<string | undefined> {
  const explicit = flag(parsedFlags, "owner-id");
  if (explicit) {
    const users = await setOwner(await loadUsers(), explicit);
    print(paint("green", "owner") + " " + explicit);
    return explicit;
  }
  if (!interactive()) {
    print(paint("yellow", "no --owner-id and no terminal; owner binding skipped"));
    return undefined;
  }
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  print("Send this to @BotFather's bot now:  /start " + code);
  print(paint("dim", "waiting up to 120 seconds; or pass --owner-id next time"));
  const deadline = Date.now() + 120_000;
  let offset = 0;
  while (Date.now() < deadline) {
    const updates = await api.getUpdates(offset, 10).catch(() => []);
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      if (!message?.from || message.from.is_bot) continue;
      if ((message.text ?? "").trim() !== "/start " + code) continue;
      const id = String(message.from.id);
      const users = await setOwner(await loadUsers(), id, message.from.username);
      print(paint("green", "owner") + " " + id);
      return users.owner ?? id;
    }
  }
  print(paint("yellow", "owner binding timed out"));
  return undefined;
}

function discordSlug(username: string): string {
  return username.replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 32) || "bot";
}

function discordInvite(applicationId: string): string {
  const bits: bigint[] = [1n << 10n, 1n << 11n, 1n << 38n, 1n << 35n, 1n << 34n, 1n << 16n, 1n << 15n, 1n << 14n, 1n << 6n, 1n << 13n, 1n << 40n, 1n << 1n, 1n << 2n, 1n << 7n];
  const permissions = bits.reduce((sum, bit) => sum | bit, 0n).toString();
  return "https://discord.com/oauth2/authorize?client_id=" + applicationId + "&permissions=" + permissions + "&scope=bot%20applications.commands";
}

function discordTokenFromEnv(): { token?: string; label?: string } {
  const pair = process.env.DURA_DISCORD_BOTS?.split(",").map((part) => part.trim()).find(Boolean);
  if (pair) {
    const colon = pair.indexOf(":");
    if (colon > 0) return { label: pair.slice(0, colon), token: pair.slice(colon + 1) };
    return { token: pair };
  }
  const token = process.env.DURA_DISCORD_TOKEN;
  return token ? { token } : {};
}

async function stepChat(state: WizardState): Promise<void> {
  print("");
  print(paint("bold", "Step " + stepNumber("chat") + " of 5 — Chat surface"));
  const config = await readConfig({ fresh: true });
  const current = config.chat.active;
  const requested = flag(parsedFlags, "platform");
  const choice: ChatPlatform =
    requested === "telegram" || requested === "discord"
      ? requested
      : has(parsedFlags, "yes")
        ? current
        : ((await choose("Which chat surface should be active?", [
            { label: "Telegram bot" + (current === "telegram" ? " (current)" : ""), value: "telegram" },
            { label: "Discord bot" + (current === "discord" ? " (current)" : ""), value: "discord" },
          ])) as ChatPlatform);
  if (choice !== current) {
    await updateConfig({ chat: { active: choice } });
    await updateConfig({ setup: { verifiedAt: null } });
  }
  print(paint("dim", "Only one surface is active at a time; the other stays configured but is ignored."));
  if (choice === "telegram") await stepTelegramSurface(state);
  else await stepDiscordSurface(state);
  await completeStep(surfaceStep(choice));
  print(paint("green", "step complete"));
}

async function stepDiscordSurface(state: WizardState): Promise<void> {
  print("");
  print(paint("bold", "Discord setup"));
  const config = await readConfig();
  const apiBase = config.discord.apiBase;
  let registry = await loadDiscordRegistry();

  if (registry.bots.length === 0 || has(parsedFlags, "add-bot")) {
    let adding = registry.bots.length === 0 || (await confirm("Add another Discord bot?", true));
    while (adding) {
      const env = discordTokenFromEnv();
      const raw = flag(parsedFlags, "discord-token") ?? env.token ?? (await secret("Discord bot token"));
      if (!raw.trim()) fail("a Discord bot token is required", 4);
      const api = new DiscordApi({ token: raw.trim(), apiBase });
      const me = await api.getMe();
      let applicationId = me.id;
      try {
        applicationId = (await api.getApplication()).id;
      } catch {
        // The bot user id is the application id for normal bots.
      }
      const label = (await ask("Label for this bot", flag(parsedFlags, "discord-label") ?? env.label ?? discordSlug(me.username))).toLowerCase();
      registry = await addDiscordBot({ label, token: raw.trim(), applicationId, botId: me.id, username: me.username });
      print(paint("green", "added") + " " + label + " @" + me.username);
      print("invite: " + discordInvite(applicationId));
      adding = await confirm("Add another Discord bot?", false);
    }
    registry = await setDefaultDiscordBot(await ask("Which label is the default Discord bot?", registry.default || registry.bots[0]?.label || ""));
  }

  const defaultEntry = defaultDiscordBot(registry);
  if (!defaultEntry) fail("no Discord bot configured", 4);
  const api = new DiscordApi({ token: defaultEntry.token, apiBase, label: defaultEntry.label });
  print("invite: " + discordInvite(defaultEntry.applicationId));
  print(paint("dim", "Enable Message Content Intent in the Discord Developer Portal, then invite the bot."));

  const explicitOwner = flag(parsedFlags, "owner-id") ?? process.env.DURA_DISCORD_OWNER_ID;
  let owner = explicitOwner;
  if (!owner && interactive()) owner = await ask("Owner Discord user id (right-click a user > Copy User ID)", "");
  if (owner) {
    const user = await api.getUser(owner).catch(() => undefined);
    if (!user) fail("Discord user not found: " + owner, 4);
    const users = await setDiscordOwner(await loadDiscordUsers(), owner, user.username);
    print(paint("green", "owner") + " " + owner + (users.owner ? "" : " (not saved)"));
    try {
      const dm = await api.createDM(owner);
      await api.sendMessage(dm.id, { content: "dura setup: Discord is connected. DMs will reach your default agent.", allowed_mentions: { parse: [] } });
      print(paint("green", "owner DM delivered"));
    } catch {
      print(paint("yellow", "owner DM failed; invite the bot to a mutual server, then send it a DM"));
    }
  } else {
    print(paint("yellow", "no owner id; run dura init again with --owner-id or dura user owner <id>"));
  }

  for (const staged of state.staged) {
    if (staged.orchestrator) {
      const files = await createOrchestrator({ id: staged.id, name: staged.name, responsibility: staged.responsibility });
      print(paint("green", "created") + " " + files.record.id + " as the orchestrator");
      continue;
    }
    const files = await createAgent({ id: staged.id, name: staged.name, responsibility: staged.responsibility, telegramBot: null, caller: "wizard" });
    print(paint("green", "created") + " " + files.record.id);
  }

  const agents = await listAgents();
  const defaultAgent = orchestratorId() ?? agents[0]?.id;
  if (defaultAgent) {
    await setDiscordBotDefaultAgent(defaultEntry.label, defaultAgent);
    print(paint("green", "default agent") + " " + defaultAgent + " (DMs and unbound threads)");
  } else {
    print(paint("yellow", "no agent yet; create one in step 1 or with dura agent create"));
  }
  print(paint("dim", "In a server use /new to create a thread for another agent; the bot is a fleet connection, not one bot per agent."));
}

async function stepTelegramSurface(state: WizardState): Promise<void> {
  print("");
  print(paint("bold", "Telegram setup"));
  let registry = await loadRegistry();

  if (registry.bots.length === 0 || has(parsedFlags, "add-bot")) {
    let adding = registry.bots.length === 0 || (await confirm("Add another bot?", true));
    while (adding) {
      const env = process.env.DURA_TELEGRAM_BOTS;
      const envPair = env?.split(",").map((part) => part.trim()).find(Boolean);
      const rawToken = flag(parsedFlags, "token") ?? (envPair?.includes(":") ? envPair : undefined) ?? (await secret("Bot token from @BotFather"));
      // --token accepts label:id:secret (Telegram tokens themselves contain exactly one colon), so a
      // second colon means the caller prefixed a label. Keep the label and strip it from the token.
      const tokenParts = rawToken.split(":");
      const labelPrefix = tokenParts.length > 2 ? tokenParts[0] : undefined;
      const token = labelPrefix ? rawToken.slice(rawToken.indexOf(":") + 1) : rawToken;
      const config = await readConfig();
      const api = new BotApi({ token, apiBase: config.telegram.apiBase });
      const me = await api.getMe();
      if (!me.username) fail("the bot has no username", 4);
      const fallback = me.username.replace(/_?bot$/i, "").replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase().slice(0, 32) || "bot";
      const label = (await ask("Label for this bot", labelPrefix ?? fallback)).toLowerCase();
      registry = await addBot({ label, token, botId: String(me.id), username: me.username });
      print(paint("green", "added") + " " + label + " @" + me.username);
      adding = await confirm("Add another bot?", false);
    }
    registry = await setDefaultBot(await ask("Which label is the default bot?", registry.default || registry.bots[0]?.label || ""));
  }

  const config = await readConfig();
  const defaultEntry = defaultBot(registry);
  if (!defaultEntry) fail("no bot configured", 4);
  const api = new BotApi({ token: defaultEntry.token, apiBase: config.telegram.apiBase, label: defaultEntry.label });
  const owner = (await loadUsers()).owner ?? (await bindOwner(api));
  if (owner) {
    const users = await loadUsers();
    if (!users.owner) await setOwner(users, owner);
  }

  const labels = registry.bots.map((bot) => bot.label);
  const agents = await listAgents();
  print("");
  print("Assign a bot to each agent:");
  for (const staged of state.staged) {
    // One bot is one agent: reserve bots already held by existing agents, then hand out distinct labels.
    const used = new Set(agents.map((agent) => agent.telegramBot).filter((label): label is string => Boolean(label)));
    for (const staged of state.staged) {
      if (staged.telegramBot) {
        used.add(staged.telegramBot);
        continue;
      }
      const free = labels.filter((label) => !used.has(label));
      if (free.length === 0) {
        print(paint("yellow", "unpaired") + " " + staged.name + " (no bot left; it is reachable through the orchestrator)");
        continue;
      }
      staged.telegramBot = free.length === 1 ? free[0] : await choose("Bot for " + staged.name, free.map((label) => ({ label: "@" + label, value: label })));
      if (staged.telegramBot) used.add(staged.telegramBot);
    }
    for (const agent of agents) {
      if (agent.telegramBot) continue;
      const free = labels.filter((label) => !used.has(label));
      if (free.length === 0) {
        print(paint("yellow", "unpaired") + " " + agent.id + " (no bot left)");
        continue;
      }
      const picked = free.length === 1 ? free[0] : await choose("Bot for " + agent.id, free.map((label) => ({ label: "@" + label, value: label })));
      if (!picked) continue;
      if (!has(parsedFlags, "yes") && !(await confirm("Connect " + agent.id + " to " + picked + "?", true))) continue;
      await (await import("../../../core/src/agent-admin.ts")).updateAgent({ id: agent.id, telegramBot: picked, caller: "wizard" });
      used.add(picked);
      print(paint("green", "connected") + " " + agent.id + " → " + picked);
    }
  }

  await useBotRegistry();
  for (const staged of state.staged) {
    if (staged.orchestrator) {
      const files = await createOrchestrator({
        id: staged.id,
        name: staged.name,
        responsibility: staged.responsibility,
        ...(staged.telegramBot ? { telegramBot: staged.telegramBot } : {}),
      });
      print(paint("green", "created") + " " + files.record.id + " as the orchestrator on " + (files.record.telegramBot ?? "default"));
      continue;
    }
    const files = await createAgent({
      id: staged.id,
      name: staged.name,
      responsibility: staged.responsibility,
      telegramBot: staged.telegramBot ?? null,
      caller: "wizard",
    });
    print(paint("green", "created") + " " + files.record.id + (files.record.telegramBot ? " on " + files.record.telegramBot : " (unpaired)"));
  }
}

async function stepService(): Promise<void> {
  print("");
  print(paint("bold", "Step " + stepNumber("service") + " of 5 — Service and tuning"));
  if (has(parsedFlags, "no-service")) {
    print(paint("dim", "service skipped (--no-service)"));
  } else if (await confirm("Install and start the systemd user service?", true)) {
    await runService({ positional: ["install"], flags: new Map(), booleans: new Set() });
  } else {
    print(paint("dim", "service skipped; start manually with dura start"));
  }
  if (!has(parsedFlags, "no-tune") && (await confirm("Report host memory tuning (zram/sysctl)?", true))) {
    await runTune({ positional: ["status"], flags: new Map(), booleans: new Set() });
  }
  await completeStep("service");
  print(paint("green", "step complete"));
}

async function stepTest(state: WizardState): Promise<void> {
  print("");
  print(paint("bold", "Step " + stepNumber("test") + " of 5 — Connection test"));
  if (has(parsedFlags, "skip-test")) {
    print(paint("yellow", "skipped (--skip-test); setup is not verified"));
    return;
  }
  // systemd started the unit a moment ago; give it time to open the socket before starting a second daemon.
  const wasRunning = await waitForDaemon(8000);
  let started = false;
  if (!wasRunning) {
    print(paint("dim", "starting the daemon for the test…"));
    await startDetached(parsedFlags);
    started = true;
  }
  const client = await DaemonClient.connect(undefined, 5000);
  let result: { ok: boolean; checks: { name: string; ok: boolean; detail: string; required: boolean }[] };
  try {
    result = await client.request("verify.run", { agentPing: !has(parsedFlags, "no-agent-ping") }, 180_000);
  } finally {
    client.close();
  }
  table(
    ["check", "result", "detail"],
    result.checks.map((check) => [check.name, check.ok ? paint("green", "ok") : check.required ? paint("red", "FAIL") : paint("yellow", "warn"), check.detail]),
  );
  if (!result.ok) {
    print("");
    print(paint("red", "connection test failed; fix the failing check and run: dura verify"));
    if (started && !has(parsedFlags, "keep-running")) await runStop({ positional: [], flags: new Map(), booleans: new Set() });
    process.exit(1);
  }
  await completeStep("test");
  print("");
  print(paint("green", "setup complete and verified"));
  if (!(await confirm("Keep the daemon running?", true)) && started) {
    await runStop({ positional: [], flags: new Map(), booleans: new Set() });
  }
}

let parsedFlags: Parsed;

export async function runInit(parsed: Parsed): Promise<void> {
  parsedFlags = parsed;
  if (await daemonRunning()) {
    fail("the daemon is running; stop it first with: dura stop", 4);
  }
  print(paint("bold", "dura-agents setup"));
  print("home " + duraHome);
  if (has(parsed, "json")) {
    // The wizard is interactive; JSON only describes the resulting state.
  }

  if (!has(parsed, "no-migrate")) await maybeMigration();
  const state: WizardState = { staged: [] };
  let config = await readConfig({ fresh: true });

  const run: Record<Step, () => Promise<void>> = {
    agents: () => stepAgents(state, config),
    provider: () => stepProvider(state, config),
    chat: () => stepChat(state),
    service: () => stepService(),
    test: () => stepTest(state),
  };

  for (const step of STEPS) {
    const explicitSurface = step === "chat" && Boolean(flag(parsed, "platform"));
    const done = step === "chat" ? isSurfaceComplete(config, config.chat.active) : config.setup.completed.includes(step);
    if (done && !has(parsed, "redo") && !explicitSurface) {
      print("");
      print(paint("dim", "Step " + stepNumber(step) + " of 5 — " + TITLES[step] + ": done"));
      continue;
    }
    await run[step]();
    config = await readConfig({ fresh: true });
    if (step === "test") {
      print("");
      print(paint("bold", "Ready"));
      print("next: message your bot, or run dura status / dura monitor");
      return;
    }
  }
  print("");
  print(paint("bold", "Ready"));
  print("next: dura verify, then message your bot");
}
