import { type Parsed, has } from "../args.ts";
import { fail, json, paint, print } from "../output.ts";
import { appendLesson, appendMemory, lessonsPath, listAgents, readLessons, memoryPath, readMemory } from "../../../core/src/agents.ts";
import { recallMemories } from "../../../core/src/recall.ts";

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
  if (action === "lessons") {
    const text = await readLessons(agentId);
    if (has(parsed, "json")) json({ agentId, lessons: text });
    else print(text.trim() || paint("dim", "(no lessons yet)"));
    return;
  }
  if (action === "lesson") {
    const note = rest.join(" ").trim();
    if (!note) fail("usage: dura memory <agent> lesson <note>", 2);
    const saved = await appendLesson(agentId, note);
    if (has(parsed, "json")) json(saved);
    else print(saved.saved ? "saved: " + saved.line : "already learned: " + saved.line);
    return;
  }
  if (action === "recall") {
    // Same scorer the prompt-time recall uses, run by hand: keyword overlap with a recency tilt.
    const query = rest.join(" ").trim();
    if (!query) fail("usage: dura memory <agent> recall <query>", 2);
    const sources = [
      { name: "memory", text: await readMemory(agentId) },
      { name: "lesson", text: await readLessons(agentId) },
    ];
    const matches = sources.flatMap(({ name, text }) =>
      recallMemories(text, query).map((line) => ({ source: name, line })),
    );
    if (has(parsed, "json")) json({ agentId, query: rest.join(" ").trim(), matches });
    else if (matches.length === 0) print(paint("dim", "(no matching notes)"));
    else for (const match of matches) print(paint("dim", match.source + ":") + " " + match.line);
    return;
  }
  if (action === "edit") {
    fail("edit the files directly: " + memoryPath(agentId) + " · " + lessonsPath(agentId), 2);
  }
  fail("usage: dura memory <agent> [list|add <note>|lessons|lesson <note>|recall <query>|edit]", 2);
}
