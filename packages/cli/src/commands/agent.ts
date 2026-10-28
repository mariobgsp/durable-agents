import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type Parsed, flag, has } from "../args.ts";
import { fail, json, paint, print, table } from "../output.ts";
import { choose, confirm, interactive, ask } from "../prompts.ts";
import { useBotRegistry } from "../bots.ts";
import {
  createAgent,
  deleteAgent,
  setEnabled,
  updateAgent,
  writeAgentDoc,
} from "../../../core/src/agent-admin.ts";
import { docHistory, readDocs, restoreDoc } from "../../../core/src/doc-store.ts";
import { listAgents, readAgent } from "../../../core/src/agents.ts";
import { defaultCwd, readConfig } from "../../../core/src/config.ts";
import { suggestResponsibility } from "../../../core/src/agents.ts";
import { allSessionRecords } from "../../../core/src/sessions.ts";

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

async function modelChoice(parsed: Parsed): Promise<{ provider: string; modelId: string }> {
  const config = await readConfig({ fresh: true });
  const explicitModel = flag(parsed, "model");
  const explicitProvider = flag(parsed, "provider");
  if (explicitProvider && explicitModel) return { provider: explicitProvider, modelId: explicitModel };
  if (explicitModel) return { provider: explicitProvider ?? config.models.default.provider, modelId: explicitModel };
  return config.models.default;
}

async function createInteractive(parsed: Parsed): Promise<void> {
  const labels = await useBotRegistry();
  const config = await readConfig({ fresh: true });
  if (labels.length === 0) fail("no Telegram bot configured; run dura init step 3 or dura bot add", 4);
  const name = flag(parsed, "name") ?? (await ask("Agent name"));
  if (!name.trim()) fail("an agent needs a name", 2);

  let bot = flag(parsed, "bot");
  if (!bot) {
    if (!interactive() && labels.length > 1) {
      fail("several bots are configured; pass --bot with one of: " + labels.join(", "), 2);
    }
    bot = labels.length === 1 ? labels[0] : await choose("Which Telegram bot?", labels.map((label) => ({ label: "@" + label, value: label })));
  }
  if (!bot || !labels.includes(bot)) fail("unknown bot: " + (bot ?? "(none)") + "; available: " + labels.join(", "), 4);

  const responsibility = flag(parsed, "responsibility") ?? (interactive() ? await ask("Responsibility (one line, optional)", "") : "");
  const { provider, modelId } = await modelChoice(parsed);
  const tools = splitList(flag(parsed, "tools")) ?? config.defaults.tools;
  const permissions = (flag(parsed, "permissions") ?? config.defaults.permissions) as "standard" | "custom" | "full";
  const cwd = flag(parsed, "cwd") ?? defaultCwd(config);
  const agentMd = flag(parsed, "agent-doc") ? await readFile(flag(parsed, "agent-doc") ?? "", "utf8") : undefined;
  const soulMd = flag(parsed, "soul-doc") ? await readFile(flag(parsed, "soul-doc") ?? "", "utf8") : undefined;

  if (!has(parsed, "yes")) {
    print("");
    print(paint("bold", "New agent"));
    print("name        " + name + " (" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ")");
    print("bot         " + bot);
    print("model       " + provider + "/" + modelId);
    print("tools       " + tools.length + " (" + tools.slice(0, 8).join(", ") + (tools.length > 8 ? ", …" : "") + ")");
    print("permissions " + permissions + " · cwd " + cwd);
    if (!(await confirm("Create it?", true))) return;
  }

  const files = await createAgent({
    name,
    telegramBot: bot,
    responsibility: responsibility || undefined,
    provider,
    modelId,
    tools,
    permissions,
    cwd,
    agentMd,
    soulMd,
    caller: "cli",
  });
  if (has(parsed, "json")) json(files.record);
  else {
    print(paint("green", "created") + " " + files.record.id + " on bot " + bot);
    print("chat: message @" + bot);
  }
}

function parseAssignment(assignment: string): { key: string; value: string } {
  const index = assignment.indexOf("=");
  if (index <= 0) fail("usage: dura agent set <id> key=value", 2);
  return { key: assignment.slice(0, index), value: assignment.slice(index + 1) };
}

export async function runAgent(parsed: Parsed): Promise<void> {
  const [action = "list", target] = parsed.positional;

  if (action === "list") {
    const [agents, records, config] = await Promise.all([listAgents(), allSessionRecords(), readConfig()]);
    if (has(parsed, "json")) {
      json(
        agents.map((agent) => ({
          ...agent,
          threads: records.filter((record) => record.agent === agent.id && !record.deletedAt).length,
          isOrchestrator: config.orchestrator.agentId === agent.id,
        })),
      );
      return;
    }
    if (agents.length === 0) {
      print("no agents yet; run dura init (step 1) or dura agent create");
      return;
    }
    table(
      ["id", "name", "bot", "model", "state", "threads", "orchestrator"],
      agents.map((agent) => [
        agent.id,
        agent.name,
        agent.telegramBot ?? paint("yellow", "unpaired"),
        agent.provider + "/" + agent.modelId,
        agent.enabled === false ? paint("yellow", "disabled") : "enabled",
        String(records.filter((record) => record.agent === agent.id && !record.deletedAt).length),
        config.orchestrator.agentId === agent.id ? paint("green", "yes") : "",
      ]),
    );
    return;
  }

  if (action === "show") {
    if (!target) fail("usage: dura agent show <id> [--doc agent|soul]", 2);
    const files = await readAgent(target);
    if (!files) fail("unknown agent: " + target, 4);
    const docs = await readDocs(target);
    if (has(parsed, "json")) {
      json({ record: files.record, agent: docs.agent, soul: docs.soul });
      return;
    }
    const doc = flag(parsed, "doc");
    if (doc === "agent") print(docs.agent.text);
    else if (doc === "soul") print(docs.soul.text);
    else {
      print(paint("bold", files.record.name + " (" + files.record.id + ")"));
      print("model       " + files.record.provider + "/" + files.record.modelId);
      print("bot         " + (files.record.telegramBot ?? "unpaired"));
      print("tools       " + files.record.tools.join(", "));
      print("permissions " + (files.record.permissions ?? "inferred") + " · cwd " + (files.record.cwd ?? "-"));
      print("mesh        " + (files.record.mesh ?? "full") + " · " + (files.record.enabled === false ? "disabled" : "enabled"));
      print("AGENT.md    " + docs.agent.sha256.slice(0, 12) + " · " + docs.agent.lines + " lines");
      print("SOUL.md     " + docs.soul.sha256.slice(0, 12) + " · " + docs.soul.lines + " lines");
      print("");
      print(paint("dim", "dura agent show " + target + " --doc agent|soul"));
    }
    return;
  }

  if (action === "create") {
    await createInteractive(parsed);
    return;
  }

  if (action === "set") {
    if (!target) fail("usage: dura agent set <id> key=value [...]", 2);
    await useBotRegistry();
    const assignments = parsed.positional.slice(2).map(parseAssignment);
    const patch: Record<string, unknown> = {};
    for (const { key, value } of assignments) {
      switch (key) {
        case "name":
        case "responsibility":
        case "provider":
        case "model":
        case "cwd":
        case "mesh":
        case "permissions":
          patch[key] = value;
          break;
        case "bot":
          // "none" or an empty value disconnects the bot instead of leaving the old pairing in place.
          patch.bot = value === "" || value === "none" ? null : value;
          break;
        case "enabled":
          patch.enabled = value === "true" || value === "1" || value === "yes";
          break;
        case "tools":
          patch.tools = splitList(value) ?? [];
          break;
        default:
          fail("unknown field: " + key, 2);
      }
    }
    const files = await updateAgent({
      id: target,
      name: (patch.name as string) ?? undefined,
      responsibility: (patch.responsibility as string) ?? undefined,
      provider: (patch.provider as string) ?? undefined,
      modelId: (patch.model as string) ?? undefined,
      cwd: (patch.cwd as string) ?? undefined,
      telegramBot: patch.bot === null ? null : ((patch.bot as string | undefined) ?? undefined),
      mesh: (patch.mesh as never) ?? undefined,
      permissions: (patch.permissions as never) ?? undefined,
      tools: (patch.tools as string[]) ?? undefined,
      enabled: (patch.enabled as boolean) ?? undefined,
      caller: "cli",
    });
    if (has(parsed, "json")) json(files.record);
    else print(paint("green", "updated") + " " + target);
    return;
  }

  if (action === "enable" || action === "disable") {
    if (!target) fail("usage: dura agent " + action + " <id>", 2);
    await setEnabled(target, action === "enable", "cli");
    print(target + " " + (action === "enable" ? "enabled" : "disabled"));
    return;
  }

  if (action === "delete") {
    if (!target) fail("usage: dura agent delete <id> [--yes]", 2);
    if (!has(parsed, "yes") && interactive() && !(await confirm("Delete " + target + " and hide its threads?", false))) return;
    await deleteAgent(target, { confirm: target, caller: "cli" });
    print(paint("green", "deleted") + " " + target);
    return;
  }

  if (action === "docs") {
    if (!target) fail("usage: dura agent docs <id>", 2);
    const [docs, history] = await Promise.all([
      readDocs(target),
      Promise.all([docHistory(target, "agent"), docHistory(target, "soul")]),
    ]);
    if (has(parsed, "json")) json({ docs, history });
    else {
      table(
        ["doc", "lines", "sha256", "history"],
        [
          ["AGENT.md", String(docs.agent.lines), docs.agent.sha256, String(history[0].length)],
          ["SOUL.md", String(docs.soul.lines), docs.soul.sha256, String(history[1].length)],
        ],
      );
      print(paint("dim", "dura agent edit-doc <id> agent|soul"));
    }
    return;
  }

  if (action === "edit-doc") {
    const doc = parsed.positional[2];
    if (!target || (doc !== "agent" && doc !== "soul")) fail("usage: dura agent edit-doc <id> agent|soul [--file path]", 2);
    const files = await readAgent(target);
    if (!files) fail("unknown agent: " + target, 4);
    const current = doc === "agent" ? files.agentMd : files.soulMd;
    let text: string;
    const file = flag(parsed, "file");
    if (file) {
      text = await readFile(file, "utf8");
    } else if (interactive()) {
      const dir = await mkdtemp(resolve(tmpdir(), "dura-doc-"));
      const path = resolve(dir, doc === "agent" ? "AGENT.md" : "SOUL.md");
      await writeFile(path, current, { mode: 0o600 });
      const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
      const child = spawn(editor, [path], { stdio: "inherit" });
      await new Promise<void>((done, failed) => {
        child.on("exit", (code) => (code === 0 ? done() : failed(new Error("editor exited " + code))));
        child.on("error", failed);
      });
      text = await readFile(path, "utf8");
      await rm(dir, { recursive: true, force: true });
    } else {
      text = await new Promise<string>((done) => {
        let body = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (body += String(chunk)));
        process.stdin.on("end", () => done(body));
      });
    }
    const result = await writeAgentDoc({
      agentId: target,
      doc,
      mode: flag(parsed, "append") ? "append" : "replace",
      content: text,
      caller: "cli",
    });
    print(paint("green", "wrote") + " " + (doc === "agent" ? "AGENT.md" : "SOUL.md") + " · " + result.lines + " lines · " + result.rebound + " threads rebound");
    return;
  }

  if (action === "restore-doc") {
    const doc = parsed.positional[2];
    const stamp = parsed.positional[3];
    if (!target || (doc !== "agent" && doc !== "soul") || !stamp) {
      fail("usage: dura agent restore-doc <id> agent|soul <timestamp>", 2);
    }
    const result = await restoreDoc(target, doc, stamp);
    print(paint("green", "restored") + " " + result.lines + " lines");
    return;
  }

  if (action === "suggest") {
    if (!target) fail("usage: dura agent suggest <id>", 2);
    const files = await readAgent(target);
    if (!files) fail("unknown agent: " + target, 4);
    print(await suggestResponsibility(files.soulMd));
    return;
  }

  fail("usage: dura agent <list|show|create|set|enable|disable|delete|docs|edit-doc|restore-doc|suggest>", 2);
}
