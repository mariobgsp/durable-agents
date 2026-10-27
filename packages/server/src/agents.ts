import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { agentTmpRoot, dataDir } from "./paths.ts";
import { models, resolveDefaultModel } from "./models.ts";
import type { PermissionTier } from "./permissions.ts";
import { recordStatelessUsage } from "./usage-ledger.ts";

export type ThinkingLevel = "off" | "low" | "medium" | "high";

/**
 * One agent is one directory at data/agents/<id>/ holding agent.json + AGENT.md + SOUL.md + MEMORY.md.
 * Its scratch space lives outside the repository, at ~/tmp/<id>, and is not part of the agent's files.
 */
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
  /**
   * What this agent may do. Absent on records written before tiers existed, where the policy is inferred:
   * an agent that already had `bash` or `codemode` is reported as `full` rather than quietly losing it.
   */
  permissions?: PermissionTier;
  /** Tools a Custom agent may not call; `*` wildcards allowed (`mcp__*`). */
  blockedTools?: string[];
  /** Extra roots a scoped agent may reach beyond its `cwd`. */
  allowedPaths?: string[];
  /**
   * What this agent may do on the agent network: off (no tools), message (list and send), or full (also
   * delegate). Defaults to full when absent, because being able to talk to a teammate is part of the job.
   */
  mesh?: "off" | "message" | "full";
};

export type AgentFiles = { record: AgentRecord; agentMd: string; soulMd: string; memoryMd: string };

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
  permissions?: PermissionTier;
  blockedTools?: string[];
  allowedPaths?: string[];
  mesh?: "off" | "message" | "full";
  agentMd?: string;
  soulMd?: string;
};

export const agentsDir = resolve(dataDir, "agents");

/**
 * Agent files are fleet facts: a create, rename, colour change, delete or enabled flag changes the roster
 * every open tab reads. The listener is deliberately only a notification; the fleet computes the new
 * snapshot from the files.
 */
const listeners = new Set<() => void>();

export function subscribeAgents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitAgents(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* A broken listener must not fail a save. */
    }
  }
}

/** What a new agent gets: the same tool set pi ships with, including code mode. */
export const DEFAULT_AGENT_TOOLS = ["read", "write", "edit", "bash", "terminal", "coding", "codemode"] as const;

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
    // Carried explicitly, like every other field here: a reader that rebuilds the record drops what it does
    // not name, and a dropped tier silently becomes the inferred one — which for an agent with `bash` means
    // Full Access. The identity scenario documents the same trap for a room's colour.
    permissions:
      parsed.permissions === "standard" || parsed.permissions === "custom" || parsed.permissions === "full"
        ? parsed.permissions
        : undefined,
    blockedTools: Array.isArray(parsed.blockedTools)
      ? parsed.blockedTools.filter((tool) => typeof tool === "string")
      : undefined,
    allowedPaths: Array.isArray(parsed.allowedPaths)
      ? parsed.allowedPaths.filter((path) => typeof path === "string")
      : undefined,
    // Carried explicitly for the same reason as permissions: a reader that rebuilds the record drops what it
    // does not name, and a dropped policy would silently become "full".
    mesh: parsed.mesh === "off" || parsed.mesh === "message" || parsed.mesh === "full" ? parsed.mesh : undefined,
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
    memoryMd: await readText(memoryPath(id)),
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
    permissions: input.permissions ?? existing?.permissions,
    blockedTools: input.blockedTools ?? existing?.blockedTools,
    allowedPaths: input.allowedPaths ?? existing?.allowedPaths,
    mesh: input.mesh ?? existing?.mesh,
  };
  await writeText(resolve(dirOf(id), "agent.json"), JSON.stringify(record, null, 2) + "\n");
  if (input.agentMd !== undefined) await writeText(resolve(dirOf(id), "AGENT.md"), input.agentMd);
  else if (!existing) await writeText(resolve(dirOf(id), "AGENT.md"), AGENT_TEMPLATE);
  if (input.soulMd !== undefined) await writeText(resolve(dirOf(id), "SOUL.md"), input.soulMd);
  else if (!existing) await writeText(resolve(dirOf(id), "SOUL.md"), SOUL_TEMPLATE);
  // The announced scratch path must exist before any prompt mentions it.
  await ensureAgentTmp(id);
  const files = await readAgent(id);
  if (!files) throw new Error("failed to write agent: " + id);
  emitAgents();
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
  emitAgents();
  return true;
}

/** Notes rendered into the prompt; older ones stay on disk instead of crowding out the conversation. */
const MEMORY_RENDER_LIMIT = 40;

/** The agent's scratch directory: ~/tmp/<id>, created on save and on boot. */
export function agentTmpDir(id: string): string {
  return resolve(agentTmpRoot, id);
}

/** Announce a path only once it exists. */
export async function ensureAgentTmp(id: string): Promise<string> {
  const dir = agentTmpDir(id);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function memoryPath(id: string): string {
  return resolve(dirOf(id), "MEMORY.md");
}

export async function readMemory(id: string): Promise<string> {
  return readText(memoryPath(id));
}

/**
 * Append one note to an agent's memory.
 *
 * This runs inside a tool call, so it must not reach the model again by itself: the saved line is echoed back
 * in the tool result instead. A note already present (same day, or the same sentence from an earlier day) is
 * reported rather than duplicated, because a model that repeats itself should not grow the file.
 */
export async function appendMemory(id: string, note: string): Promise<{ saved: boolean; line: string }> {
  const clean = note.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!clean) throw new Error("a memory note cannot be empty");

  const existing = await readMemory(id);
  const line = "- " + new Date().toISOString().slice(0, 10) + " \u00b7 " + clean;
  const lower = clean.toLowerCase();
  const duplicate = existing
    .split("\n")
    .some((entry) => entry.trim().toLowerCase().endsWith(lower));
  if (duplicate) return { saved: false, line };

  const body = existing.trim().length > 0 ? existing.trimEnd() + "\n" + line + "\n" : "# Memory\n\n" + line + "\n";
  await writeText(memoryPath(id), body);
  return { saved: true, line };
}

/**
 * The notes the agent saved with `remember`. Only the newest `MEMORY_RENDER_LIMIT` are rendered: memory is
 * meant to inform the prompt, not to become the conversation.
 */
function memorySection(memoryMd: string): string {
  const notes = memoryMd
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
  if (notes.length === 0) return "";
  const kept = notes.slice(-MEMORY_RENDER_LIMIT);
  const omitted = notes.length - kept.length;
  return [
    "## Memory",
    "",
    "Notes you saved with the `remember` tool. They are yours in every thread, so treat them as things you already know.",
    "",
    ...(omitted > 0 ? ["(" + omitted + " older notes are on disk but omitted here)", ""] : []),
    ...kept,
  ].join("\n");
}

/**
 * App-level working rules, present on every request.
 *
 * The first rule is about choosing an executor: a coding request is the one moment the owner may want the work
 * to happen in a different CLI that is already logged in, so the agent asks once instead of assuming. The
 * terminal rule is the complement — the shell is the agent's tool, and the owner reads the result in the
 * thread, so a reply must never tell them to open a terminal and look for themselves.
 */
function workingSection(): string {
  return [
    "## Working rules",
    "",
    "When the owner asks you to write, fix or refactor code, ask once with the `question` tool which executor to use:",
    "`Durable agents (me)` keeps the work in this thread; `pi` and `opencode` hand it to that CLI, which is already logged in for this user.",
    "Do not ask again in a thread where the owner already chose. If one executor is unavailable, say so and offer the rest.",
    "Use the `terminal` tool for builds, tests, git and inspection. Never tell the owner to open a terminal: report what changed (files, diff stat, the decisive test lines) in your answer.",
    "When you hand a task to `pi` or `opencode` through the `coding` tool, relay the useful part of its output and name the files it touched.",
  ].join("\n");
}

/** Where this agent may write scripts, named explicitly so it never invents a shared directory. */
function scratchSection(id: string): string {
  return [
    "## Scratch space",
    "",
    "Your own directory is `" + agentTmpDir(id) + "`. Put scripts and throwaway files there.",
    "Every agent has its own directory; do not write into another agent's.",
  ].join("\n");
}

/** System-prompt instructions: SOUL (who you are), AGENT (rules), memory (what you learned), then scratch space. */
export function renderInstructions(files: AgentFiles): string {
  const parts: string[] = [];
  if (files.soulMd.trim()) parts.push("## SOUL.md\n\n" + files.soulMd.trim());
  if (files.agentMd.trim()) parts.push("## AGENT.md\n\n" + files.agentMd.trim());
  const memory = memorySection(files.memoryMd);
  if (memory) parts.push(memory);
  parts.push(workingSection());
  parts.push(scratchSection(files.record.id));
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
  if (answer?.usage) {
    await recordStatelessUsage({
      source: "suggest-responsibility",
      provider: ref.provider,
      modelId: ref.modelId,
      usage: answer.usage,
      at: answer.timestamp,
    });
  }
  const line = textOfAssistant(answer).trim().split("\n")[0] ?? "";
  return line.slice(0, 200);
}