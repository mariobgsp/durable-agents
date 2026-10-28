import { type Parsed, flag, has } from "../args.ts";
import { fail, json, paint, print } from "../output.ts";
import { confirm, interactive, ask } from "../prompts.ts";
import { useBotRegistry } from "../bots.ts";
import { readAgent } from "../../../core/src/agents.ts";
import { createOrchestrator, hydrateOrchestrator, replaceOrchestrator, setOrchestrator } from "../../../core/src/orchestrator.ts";
import { readConfig } from "../../../core/src/config.ts";

export async function runOrchestrator(parsed: Parsed): Promise<void> {
  const [action = "show", target] = parsed.positional;
  await hydrateOrchestrator();

  if (action === "show") {
    const config = await readConfig({ fresh: true });
    const id = config.orchestrator.agentId;
    const files = id ? await readAgent(id) : null;
    if (has(parsed, "json")) {
      json({ agentId: id, agent: files?.record ?? null });
      return;
    }
    if (!files) {
      print(paint("yellow", "no orchestrator configured"));
      print("create one with: dura orchestrator create");
      return;
    }
    print(paint("bold", "orchestrator: " + files.record.name + " (" + id + ")"));
    print("model " + files.record.provider + "/" + files.record.modelId + " · bot " + (files.record.telegramBot ?? "default"));
    return;
  }

  if (action === "set" || action === "replace") {
    const id = target ?? fail("usage: dura orchestrator " + action + " <agent-id>", 2);
    if (action === "replace" && !has(parsed, "yes") && interactive()) {
      const previous = (await readConfig({ fresh: true })).orchestrator.agentId;
      if (!(await confirm("Replace orchestrator " + (previous ?? "(none)") + " with " + id + "?", true))) return;
    }
    if (action === "replace") await replaceOrchestrator(id, { removeOld: has(parsed, "remove-old") });
    else await setOrchestrator(id);
    print(paint("green", "orchestrator") + " " + id);
    return;
  }

  if (action === "create") {
    const labels = await useBotRegistry();
    if (labels.length === 0) fail("no Telegram bot configured; run dura init step 3 or dura bot add", 4);
    const config = await readConfig({ fresh: true });
    if (config.orchestrator.agentId && !has(parsed, "yes")) {
      if (!interactive() || !(await confirm("An orchestrator already exists; replace it?", false))) return;
    }
    let bot = flag(parsed, "bot");
    if (!bot) {
      if (!interactive() && labels.length > 1) fail("several bots; pass --bot", 2);
      bot = labels.length === 1 ? labels[0] : labels[0];
    }
    if (!labels.includes(bot ?? "")) fail("unknown bot: " + bot, 4);
    const name = flag(parsed, "name") ?? (has(parsed, "yes") ? "Orchestrator" : await ask("Orchestrator name", "Orchestrator"));
    const responsibility = flag(parsed, "responsibility") ?? undefined;
    const files = await createOrchestrator({
      id: flag(parsed, "id") ?? "orchestrator",
      name,
      responsibility,
      telegramBot: bot,
      ...(flag(parsed, "model") ? { modelId: flag(parsed, "model") } : {}),
    });
    if (has(parsed, "json")) json(files.record);
    else {
      print(paint("green", "orchestrator created") + " " + files.record.id + " on bot " + bot);
      print("chat: message @" + bot);
    }
    return;
  }

  fail("usage: dura orchestrator <show|set|replace|create> [agent-id]", 2);
}
