import { type Parsed, has } from "../args.ts";
import { fail, json, paint, print } from "../output.ts";
import { appendMemory, listAgents, readMemory } from "../../../core/src/agents.ts";

export async function runMemory(parsed: Parsed): Promise<void> {
  const [agentId, action = "list", ...rest] = parsed.positional;
  if (!agentId) {
    const agents = await listAgents();
    if (has(parsed, "json")) json(agents.map((agent) => ({ id: agent.id, name: agent.name })));
    else for (const agent of agents) print(agent.id + "  " + agent.name);
    return;
  }
  if (!(await listAgents()).some((agent) => agent.id === agentId)) fail("unknown agent: " + agentId, 4);

  if (action === "list") {
    const text = await readMemory(agentId);
    if (has(parsed, "json")) json({ agentId, memory: text });
    else print(text.trim() || paint("dim", "(no memory yet)"));
    return;
  }
  if (action === "add") {
    const note = rest.join(" ").trim();
    if (!note) fail("usage: dura memory <agent> add <note>", 2);
    const saved = await appendMemory(agentId, note);
    if (has(parsed, "json")) json(saved);
    else print(saved.saved ? "saved: " + saved.line : "already in memory: " + saved.line);
    return;
  }
  if (action === "edit") {
    fail("edit the file directly: " + (await import("../../../core/src/agents.ts")).memoryPath(agentId), 2);
  }
  fail("usage: dura memory <agent> [list|add <note>|edit]", 2);
}
