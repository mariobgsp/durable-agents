import { readAgent, writeAgent, type AgentFiles } from "./agents.ts";
import { DEFAULT_TOOLS, defaultCwd, readConfig, updateConfig } from "./config.ts";
import { log } from "./logger.ts";

/**
 * The orchestrator is a config pointer, never a flag on the agent. One source of truth means a
 * renamed or deleted agent cannot leave a stale "orchestrator: true" behind, and the answer to
 * "who is the orchestrator" is the same for the CLI, the bot and the tools.
 *
 * The pointer is cached because agent-change construction is synchronous: a conversation must know
 * whether to offer the admin tools without waiting for a file read.
 */
let currentId: string | null = null;
let hydrated = false;

export const ORCHESTRATOR_AGENT_MD = `# Role

You are the orchestrator. You plan work, keep the owner's goals in view, and route tasks to the right teammates.

## Rules

- Answer the owner directly when the work is small; delegate when another agent is clearly better at it.
- Use agent_admin_list before naming a teammate, and agent_read before changing anyone's persona.
- Create agents with agent_create. When several Telegram bots are configured, ask the owner which bot the new
  agent should use with the question tool before calling agent_create.
- Change another agent's AGENT.md or SOUL.md only with agent_write_doc: read first, pass expectedSha256, prefer
  small patches over whole-file rewrites. Never edit another agent's MEMORY.md.
- After creating or changing an agent, say what changed and on which bot the owner can reach it.
- Keep answers short. The owner reads them in Telegram.
`;

export const ORCHESTRATOR_SOUL_MD = `# Who you are

You are the orchestrator: calm, decisive, and brief. You think in terms of ownership and next action.

## Responsibilities

- Turn the owner's request into either a direct answer or a delegation.
- Keep the team coherent: names, roles and personas.
- Report results, not process.
`;

export function orchestratorId(): string | null {
  return currentId;
}

export function isOrchestrator(agentId: string | null | undefined): boolean {
  return Boolean(agentId && currentId && agentId === currentId);
}

/** Prime the synchronous cache from config. Called once at boot and after every pointer change. */
export async function hydrateOrchestrator(): Promise<string | null> {
  const config = await readConfig({ fresh: true });
  const id = config.orchestrator.agentId;
  if (id) {
    const files = await readAgent(id);
    if (!files) {
      log.warn("orchestrator.dangling", { agentId: id });
      currentId = null;
      await updateConfig({ orchestrator: { agentId: null } });
      hydrated = true;
      return null;
    }
    currentId = id;
  } else {
    currentId = null;
  }
  hydrated = true;
  return currentId;
}

export function orchestratorHydrated(): boolean {
  return hydrated;
}

export type OrchestratorEvent =
  | { kind: "changed"; agentId: string | null; previous: string | null }
  | { kind: "claimed"; agentId: string }
  | { kind: "requested"; agentId: string; current: string | null };

const listeners = new Set<(event: OrchestratorEvent) => void>();

/** Telegram and the CLI listen here for a self-assignment request or a completed claim. */
export function subscribeOrchestrator(listener: (event: OrchestratorEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: OrchestratorEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* a listener must not fail a pointer change */
    }
  }
}

/** Rebuild one agent's conversations so the admin tools follow the role immediately. */
async function rebindForRole(agentId: string | null): Promise<void> {
  if (!agentId) return;
  try {
    const { rebindAgent } = await import("./sessions.ts");
    await rebindAgent(agentId);
  } catch {
    /* a missing conversation is not a reason to fail the pointer change */
  }
}

/** Set (or clear) the pointer, validating the agent first. */
export async function setOrchestrator(agentId: string | null): Promise<string | null> {
  if (agentId) {
    const files = await readAgent(agentId);
    if (!files) throw new Error("unknown agent: " + agentId);
    if (files.record.enabled === false) throw new Error("agent " + agentId + " is disabled");
  }
  const previous = currentId;
  await updateConfig({ orchestrator: { agentId } });
  currentId = agentId;
  hydrated = true;
  if (previous !== agentId) {
    await rebindForRole(previous);
    await rebindForRole(agentId);
  }
  log.info("orchestrator.set", { agentId, previous });
  emit({ kind: "changed", agentId, previous });
  return currentId;
}

/**
 * Self-assignment. With no orchestrator the caller takes the role at once (bootstrap); with one in
 * place the request is reported to the owner, who approves it from Telegram. A full-access agent can
 * still edit config.json directly with the shell; the owner-facing request is the supported path.
 */
export async function claimOrchestrator(agentId: string): Promise<{ status: "already" | "claimed" | "requested"; current: string | null }> {
  const files = await readAgent(agentId);
  if (!files) throw new Error("unknown agent: " + agentId);
  if (files.record.enabled === false) throw new Error("agent " + agentId + " is disabled");
  if (currentId === agentId) return { status: "already", current: currentId };
  if (currentId === null) {
    await setOrchestrator(agentId);
    emit({ kind: "claimed", agentId });
    return { status: "claimed", current: currentId };
  }
  emit({ kind: "requested", agentId, current: currentId });
  log.info("orchestrator.claim_requested", { agentId, current: currentId });
  return { status: "requested", current: currentId };
}

export type OrchestratorInput = {
  id?: string;
  name?: string;
  responsibility?: string;
  provider?: string;
  modelId?: string;
  tools?: string[];
  telegramBot?: string;
  agentMd?: string;
  soulMd?: string;
};

/** Create a new orchestrator agent from the defaults and point at it. */
export async function createOrchestrator(input: OrchestratorInput = {}): Promise<AgentFiles> {
  const config = await readConfig({ fresh: true });
  const id = input.id ?? "orchestrator";
  if (await readAgent(id)) throw new Error("an agent called " + id + " already exists; use replace");
  const files = await writeAgent({
    id,
    name: input.name ?? "Orchestrator",
    provider: input.provider ?? config.models.default.provider,
    modelId: input.modelId ?? config.models.default.modelId,
    responsibility: input.responsibility ?? "plans work, delegates, and keeps the agent team coherent",
    tools: input.tools ?? [...DEFAULT_TOOLS, "agents_list", "agents_message", "agents_delegate"],
    permissions: "full",
    cwd: defaultCwd(config),
    mesh: "full",
    ...(input.telegramBot ? { telegramBot: input.telegramBot } : {}),
    agentMd: input.agentMd ?? ORCHESTRATOR_AGENT_MD,
    soulMd: input.soulMd ?? ORCHESTRATOR_SOUL_MD,
  });
  await setOrchestrator(files.record.id);
  return files;
}

/**
 * Replace the pointer, keeping the previous agent as a normal agent unless removeOld is set.
 * This is a pointer move first; deletion of the old agent is a separate, confirmed action.
 */
export async function replaceOrchestrator(agentId: string, options: { removeOld?: boolean } = {}): Promise<string> {
  const previous = currentId;
  await setOrchestrator(agentId);
  if (options.removeOld && previous && previous !== agentId) {
    const { deleteAgent } = await import("./agent-admin.ts");
    await deleteAgent(previous, { confirm: previous, caller: "orchestrator-replace", allowOrchestrator: true });
  }
  return agentId;
}
