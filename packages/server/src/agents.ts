import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { dataDir } from "./paths.ts";
import { models, resolveDefaultModel } from "./models.ts";

export type ThinkingLevel = "off" | "low" | "medium" | "high";

/** One agent is one directory at data/agents/<id>/ holding agent.json + AGENT.md + SOUL.md. */
export type AgentRecord = {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /** Tool names enabled for this agent; empty means chat only. */
  tools: string[];
  /** Image input policy: "auto" follows the model's capabilities, "off" refuses images. */
  vision?: "auto" | "off";
  /** One-line area of responsibility; used by Nyahut mode. */
  responsibility?: string;
  cwd?: string;
  /** A disabled agent stays readable but cannot start new threads. Defaults to true. */
  enabled?: boolean;
  /** Identity the user picks: a hex colour and an emoji face shown in the sidebar and bubbles. */
  color?: string;
  avatar?: string;
};

export type AgentFiles = { record: AgentRecord; agentMd: string; soulMd: string };

export type AgentInput = {
  id?: string;
  name: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  vision?: "auto" | "off";
  responsibility?: string;
  cwd?: string;
  enabled?: boolean;
  color?: string;
  avatar?: string;
  agentMd?: string;
  soulMd?: string;
};

const agentsDir = resolve(dataDir, "agents");

/** What a new agent gets: the same tool set pi ships with, including code mode. */
export const DEFAULT_AGENT_TOOLS = ["read", "write", "edit", "bash", "codemode"] as const;

export const AGENT_TEMPLATE = `# Role

State in one paragraph who you are and what you work on.

## Rules

- Answer briefly and concretely.
- If you do not know, say you do not know.
`;

export const SOUL_TEMPLATE = `# Who you are

Name, temperament, and voice. Example: "You are cheerful, casual, and never long-winded."

## Responsibilities

- What you own, for example: releases, documentation, security.
`;

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "agent";
}

function dirOf(id: string): string {
  return resolve(agentsDir, id);
}

async function readText(path: string, fallback = ""): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, text);
  await rename(tmp, path);
}

async function readRecord(id: string): Promise<AgentRecord | null> {
  const raw = await readText(resolve(dirOf(id), "agent.json"));
  if (!raw) return null;
  let parsed: Partial<AgentRecord>;
  try {
    parsed = JSON.parse(raw) as Partial<AgentRecord>;
  } catch {
    return null;
  }
  const fallback = await resolveDefaultModel();
  return {
    id: typeof parsed.id === "string" && parsed.id ? parsed.id : id,
    name: typeof parsed.name === "string" && parsed.name ? parsed.name : id,
    provider: typeof parsed.provider === "string" && parsed.provider ? parsed.provider : fallback.provider,
    modelId: typeof parsed.modelId === "string" && parsed.modelId ? parsed.modelId : fallback.modelId,
    thinkingLevel: parsed.thinkingLevel ?? "medium",
    tools: Array.isArray(parsed.tools) ? parsed.tools.filter((tool) => typeof tool === "string") : [],
    vision: parsed.vision === "off" ? "off" : "auto",
    responsibility: typeof parsed.responsibility === "string" ? parsed.responsibility : undefined,
    cwd: typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : undefined,
    enabled: parsed.enabled !== false,
    color: typeof parsed.color === "string" && parsed.color ? parsed.color : undefined,
    avatar: typeof parsed.avatar === "string" && parsed.avatar ? parsed.avatar : undefined,
  };
}

export async function listAgents(): Promise<AgentRecord[]> {
  let names: string[] = [];
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const records: AgentRecord[] = [];
  for (const name of names.toSorted()) {
    const record = await readRecord(name);
    if (record) records.push(record);
  }
  return records;
}

export async function readAgent(id: string): Promise<AgentFiles | null> {
  const record = await readRecord(id);
  if (!record) return null;
  return {
    record,
    agentMd: await readText(resolve(dirOf(id), "AGENT.md")),
    soulMd: await readText(resolve(dirOf(id), "SOUL.md")),
  };
}

export async function writeAgent(input: AgentInput): Promise<AgentFiles> {
  const fallback = await resolveDefaultModel();
  const id = slugify(input.id ?? input.name);
  const existing = await readRecord(id);
  const record: AgentRecord = {
    id,
    name: input.name.trim() || id,
    provider: input.provider ?? existing?.provider ?? fallback.provider,
    modelId: input.modelId ?? existing?.modelId ?? fallback.modelId,
    thinkingLevel: input.thinkingLevel ?? existing?.thinkingLevel ?? "medium",
    tools: input.tools ?? existing?.tools ?? [...DEFAULT_AGENT_TOOLS],
    vision: input.vision ?? existing?.vision ?? "auto",
    responsibility: input.responsibility ?? existing?.responsibility,
    cwd: input.cwd ?? existing?.cwd,
    enabled: input.enabled ?? existing?.enabled ?? true,
    color: input.color ?? existing?.color,
    avatar: input.avatar ?? existing?.avatar,
  };
  await writeText(resolve(dirOf(id), "agent.json"), JSON.stringify(record, null, 2) + "\n");
  if (input.agentMd !== undefined) await writeText(resolve(dirOf(id), "AGENT.md"), input.agentMd);
  else if (!existing) await writeText(resolve(dirOf(id), "AGENT.md"), AGENT_TEMPLATE);
  if (input.soulMd !== undefined) await writeText(resolve(dirOf(id), "SOUL.md"), input.soulMd);
  else if (!existing) await writeText(resolve(dirOf(id), "SOUL.md"), SOUL_TEMPLATE);
  const files = await readAgent(id);
  if (!files) throw new Error("failed to write agent: " + id);
  return files;
}

/** Toggle one agent without touching the rest of its settings. */
export async function setAgentEnabled(id: string, enabled: boolean): Promise<AgentFiles | null> {
  const existing = await readRecord(id);
  if (!existing) return null;
  return writeAgent({ ...existing, id, enabled });
}

export async function deleteAgent(id: string): Promise<boolean> {
  const record = await readRecord(id);
  if (!record) return false;
  await rm(dirOf(id), { recursive: true, force: true });
  return true;
}

/** System-prompt instructions: SOUL first (who you are), then AGENT (working rules). */
export function renderInstructions(files: AgentFiles): string {
  const parts: string[] = [];
  if (files.soulMd.trim()) parts.push("## SOUL.md\n\n" + files.soulMd.trim());
  if (files.agentMd.trim()) parts.push("## AGENT.md\n\n" + files.agentMd.trim());
  return parts.join("\n\n");
}

function textOfAssistant(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block) {
      const value: unknown = block.text;
      if (typeof value === "string") text += value;
    }
  }
  return text;
}

/**
 * One-line area-of-responsibility suggestion from SOUL.md.
 * Stateless call (no conversation) with a sessionId, which the opencode provider requires.
 */
export async function suggestResponsibility(soulMd: string): Promise<string> {
  const ref = await resolveDefaultModel();
  const model = await models.getModel(ref.provider, ref.modelId);
  if (!model) throw new Error("model unavailable: " + ref.provider + "/" + ref.modelId);
  const answer = await models.completeSimple(
    model,
    {
      systemPrompt:
        "Write ONE line (max 18 words) describing the area of responsibility of the agent below. No quotes, no filler.",
      messages: [
        { role: "user", content: soulMd.slice(0, 4000) || "(SOUL.md is still empty)", timestamp: Date.now() },
      ],
    },
    { sessionId: "agent-responsibility" },
  );
  const line = textOfAssistant(answer).trim().split("\n")[0] ?? "";
  return line.slice(0, 200);
}
