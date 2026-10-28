import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  deleteAgent as deleteAgentFiles,
  listAgents,
  readAgent,
  setAgentEnabled,
  suggestResponsibility,
  writeAgent,
  type AgentFiles,
  type AgentInput,
  type AgentRecord,
} from "./agents.ts";
import { defaultCwd, readConfig } from "./config.ts";
import { DocError, docHistory, readDoc, readDocs, writeDoc, type DocMode, type DocName, type PatchPair } from "./doc-store.ts";
import { errorFields, log } from "./logger.ts";
import { reconcileMesh } from "./mesh.ts";
import { agentResolver } from "./remember.ts";
import { addMcpServer, mcpStatus, mcpToolInfos, removeMcpServer } from "./mcp.ts";
import { claimOrchestrator, isOrchestrator } from "./orchestrator.ts";
import { deleteSchedulesForAgent, reconcileSchedules } from "./schedules.ts";
import {
  allSessionRecords,
  rebindAgent,
  updateSessionRecord,
} from "./sessions.ts";

/**
 * Everyone who creates, edits or deletes an agent goes through this module: the CLI, the TUI, the
 * wizard's Finish step and the orchestrator's tools. One pipeline means one set of guards:
 * uniqueness, maxAgents, bot validation, the orchestrator's own immunity, purpose threads, and the
 * rebind/reconcile/notice sequence after every write.
 */

export type BotValidator = (label: string) => Promise<boolean>;
export type BotLister = () => Promise<string[]>;

let validateBot: BotValidator = async () => true;
let listBots: BotLister = async () => [];

export function setBotResolver(resolver: { validate: BotValidator; list: BotLister }): void {
  validateBot = resolver.validate;
  listBots = resolver.list;
}

export type AdminEvent =
  | { kind: "create"; agentId: string; caller: string }
  | { kind: "update"; agentId: string; caller: string }
  | { kind: "delete"; agentId: string; caller: string }
  | { kind: "doc"; agentId: string; doc: DocName; caller: string; sha256: string };

const listeners = new Set<(event: AdminEvent) => void>();
export function subscribeAdmin(listener: (event: AdminEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit(event: AdminEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* a listener must not fail a mutation */
    }
  }
}

export class BotChoiceRequired extends Error {
  readonly bots: string[];
  constructor(bots: string[]) {
    super(
      "several Telegram bots are configured (" + bots.join(", ") + "). Ask the owner which bot this agent should " +
      "use, then call again with telegramBot set.",
    );
    this.name = "BotChoiceRequired";
    this.bots = bots;
  }
}

function slugify(value: string): string {
  return (value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "agent");
}

/** The agent that currently owns a bot label, if any. One bot belongs to at most one agent. */
export async function botHolder(label: string, exceptAgentId?: string): Promise<AgentRecord | undefined> {
  return (await listAgents()).find((agent) => agent.telegramBot === label && agent.id !== exceptAgentId);
}

async function assertBotFree(label: string, exceptAgentId?: string): Promise<void> {
  const holder = await botHolder(label, exceptAgentId);
  if (holder) {
    throw new Error(
      "Telegram bot " + label + " already belongs to " + holder.id + ". One bot is one agent; release it first or add another bot.",
    );
  }
}

/**
 * Creation follows the one-bot-one-agent rule. A requested bot must be free; without a request the
 * default is used when free, and when every bot is taken the agent is created unpaired (reachable
 * through the orchestrator, or later through a new bot).
 */
async function resolveBotForCreate(label: string | undefined, options: { ask: boolean }): Promise<string | undefined> {
  const config = await readConfig({ fresh: true });
  if (label) {
    if (!(await validateBot(label))) {
      const known = await listBots();
      throw new Error("unknown Telegram bot: " + label + (known.length ? " (available: " + known.join(", ") + ")" : ""));
    }
    await assertBotFree(label);
    return label;
  }
  const bots = await listBots();
  if (bots.length === 0) return undefined;
  const free: string[] = [];
  for (const bot of bots) if (!(await botHolder(bot))) free.push(bot);
  if (free.length === 0) return undefined;
  if (free.length > 1 && options.ask && config.telegram.askBotOnAgentCreate) throw new BotChoiceRequired(free);
  return free.includes(config.telegram.defaultBot) ? config.telegram.defaultBot : free[0];
}

/** Move a bot to an agent: the previous holder is unpaired and the agent's old bot is released. */
export async function assignBotToAgent(bot: string, agentId: string, caller = "cli"): Promise<{ agentId: string; freed: string[] }> {
  if (!(await validateBot(bot))) throw new Error("unknown Telegram bot: " + bot);
  const target = await readAgent(agentId);
  if (!target) throw new Error("unknown agent: " + agentId);
  const holders = (await listAgents()).filter((agent) => agent.telegramBot === bot && agent.id !== agentId);
  for (const holder of holders) {
    await writeAgent({ ...holder, id: holder.id, telegramBot: null });
    await postMutation(holder.id);
    emit({ kind: "update", agentId: holder.id, caller });
  }
  const previousBot = target.record.telegramBot;
  const updated = await writeAgent({ ...target.record, id: target.record.id, telegramBot: bot });
  await postMutation(agentId);
  emit({ kind: "update", agentId, caller });
  log.info("bot.assigned", { bot, agentId, freed: holders.map((holder) => holder.id), previousBot, caller });
  return { agentId, freed: holders.map((holder) => holder.id) };
}

/** Unpair every agent that names this bot. */
export async function releaseBot(bot: string, caller = "cli"): Promise<string[]> {
  const holders = (await listAgents()).filter((agent) => agent.telegramBot === bot);
  for (const holder of holders) {
    await writeAgent({ ...holder, id: holder.id, telegramBot: null });
    await postMutation(holder.id);
    emit({ kind: "update", agentId: holder.id, caller });
  }
  if (holders.length > 0) log.info("bot.released", { bot, agents: holders.map((holder) => holder.id), caller });
  return holders.map((holder) => holder.id);
}

/**
 * Repair a legacy/imported state where several agents name one bot: keep one holder per bot (the
 * orchestrator first, otherwise the first agent) and unassign the rest. Run at boot so a migration
 * cannot leave ambiguous DM routing.
 */
export async function normalizeBotAssignments(): Promise<{ agentId: string; bot: string }[]> {
  const groups = new Map<string, AgentRecord[]>();
  for (const agent of await listAgents()) {
    if (!agent.telegramBot) continue;
    const list = groups.get(agent.telegramBot) ?? [];
    list.push(agent);
    groups.set(agent.telegramBot, list);
  }
  const cleared: { agentId: string; bot: string }[] = [];
  for (const [bot, agents] of groups) {
    if (agents.length <= 1) continue;
    const keep = agents.find((agent) => isOrchestrator(agent.id)) ?? agents[0];
    if (!keep) continue;
    for (const agent of agents) {
      if (agent.id === keep.id) continue;
      await writeAgent({ ...agent, id: agent.id, telegramBot: null });
      await postMutation(agent.id);
      cleared.push({ agentId: agent.id, bot });
      emit({ kind: "update", agentId: agent.id, caller: "boot" });
    }
  }
  if (cleared.length > 0) log.warn("bot.normalized", { cleared });
  return cleared;
}

async function postMutation(agentId: string): Promise<{ rebound: number }> {
  const rebound = await rebindAgent(agentId).catch(() => 0);
  await reconcileMesh().catch((error) => log.warn("mesh.reconcile_failed", errorFields(error)));
  await reconcileSchedules().catch((error) => log.warn("schedules.reconcile_failed", errorFields(error)));
  return { rebound };
}

export type CreateAgentInput = {
  name: string;
  id?: string;
  responsibility?: string;
  provider?: string;
  modelId?: string;
  tools?: string[];
  permissions?: AgentRecord["permissions"];
  cwd?: string;
  mesh?: AgentRecord["mesh"];
  telegramBot?: string | null;
  agentMd?: string;
  soulMd?: string;
  overwrite?: boolean;
  caller?: string;
};

export async function createAgent(input: CreateAgentInput): Promise<AgentFiles> {
  const caller = input.caller ?? "cli";
  const config = await readConfig({ fresh: true });
  const id = input.id ? slugify(input.id) : slugify(input.name);
  if ((await readAgent(id)) && !input.overwrite) throw new Error("an agent called " + id + " already exists");
  const agents = await listAgents();
  if (agents.length >= config.limits.maxAgents) {
    throw new Error("the agent limit is " + config.limits.maxAgents + "; delete or merge an agent first");
  }
  const bot =
    input.telegramBot === null
      ? undefined
      : await resolveBotForCreate(input.telegramBot, { ask: caller === "orchestrator" });
  const files = await writeAgent({
    id,
    name: input.name,
    provider: input.provider ?? config.models.default.provider,
    modelId: input.modelId ?? config.models.default.modelId,
    tools: input.tools ?? [...config.defaults.tools],
    permissions: input.permissions ?? config.defaults.permissions,
    cwd: input.cwd ?? defaultCwd(config),
    mesh: input.mesh ?? "full",
    responsibility: input.responsibility,
    telegramBot: bot ?? null,
    agentMd: input.agentMd,
    soulMd: input.soulMd,
  });
  await postMutation(files.record.id);
  log.info("agent.created", { agentId: files.record.id, bot, caller });
  emit({ kind: "create", agentId: files.record.id, caller });
  return files;
}

export type UpdateAgentInput = {
  id: string;
  name?: string;
  responsibility?: string;
  provider?: string;
  modelId?: string;
  tools?: string[];
  permissions?: AgentRecord["permissions"];
  cwd?: string;
  mesh?: AgentRecord["mesh"];
  telegramBot?: string | null;
  enabled?: boolean;
  caller?: string;
};

export async function updateAgent(input: UpdateAgentInput): Promise<AgentFiles> {
  const caller = input.caller ?? "cli";
  const files = await readAgent(input.id);
  if (!files) throw new Error("unknown agent: " + input.id);
  let bot: string | undefined | null = files.record.telegramBot;
  if (input.telegramBot === null) {
    bot = null;
  } else if (input.telegramBot) {
    if (!(await validateBot(input.telegramBot))) throw new Error("unknown Telegram bot: " + input.telegramBot);
    await assertBotFree(input.telegramBot, input.id);
    bot = input.telegramBot;
  }
  const enabled = input.enabled ?? files.record.enabled;
  if (input.enabled === false && isOrchestrator(input.id)) {
    throw new Error("the orchestrator cannot be disabled here; choose another orchestrator or disable it from the CLI");
  }
  const updated = await writeAgent({
    ...files.record,
    id: files.record.id,
    name: input.name ?? files.record.name,
    responsibility: input.responsibility ?? files.record.responsibility,
    provider: input.provider ?? files.record.provider,
    modelId: input.modelId ?? files.record.modelId,
    tools: input.tools ?? files.record.tools,
    permissions: input.permissions ?? files.record.permissions,
    cwd: input.cwd ?? files.record.cwd,
    mesh: input.mesh ?? files.record.mesh,
    telegramBot: bot ?? null,
    enabled,
  });
  await postMutation(files.record.id);
  log.info("agent.updated", { agentId: input.id, caller });
  emit({ kind: "update", agentId: input.id, caller });
  return updated;
}

export async function setEnabled(id: string, enabled: boolean, caller = "cli"): Promise<AgentFiles | null> {
  if (!enabled && isOrchestrator(id)) throw new Error("the orchestrator cannot be disabled here");
  const files = await setAgentEnabled(id, enabled);
  if (files) {
    await postMutation(id);
    emit({ kind: "update", agentId: id, caller });
    log.info("agent.enabled", { agentId: id, enabled, caller });
  }
  return files;
}

export type DeleteAgentOptions = {
  confirm: string;
  caller?: string;
  allowOrchestrator?: boolean;
};

export async function deleteAgent(id: string, options: DeleteAgentOptions): Promise<boolean> {
  const caller = options.caller ?? "cli";
  if (options.confirm !== id) throw new Error("deletion needs confirm set to the agent id");
  if (!options.allowOrchestrator && isOrchestrator(id)) {
    throw new Error("the orchestrator cannot be deleted; replace it first");
  }
  const records = await allSessionRecords();
  const purpose = records.filter((record) => record.agent === id && record.purpose && !record.deletedAt);
  if (purpose.length > 0) {
    throw new Error("agent " + id + " has " + purpose.length + " purpose thread(s) (inbox/delegate/schedule); finish or delete them first");
  }
  const removed = await deleteAgentFiles(id);
  if (!removed) return false;
  await deleteSchedulesForAgent(id).catch(() => 0);
  const { forgetMeshAgent } = await import("./mesh.ts");
  await forgetMeshAgent(id).catch(() => undefined);
  for (const record of records.filter((entry) => entry.agent === id && !entry.deletedAt)) {
    await updateSessionRecord(record.id, { deletedAt: Date.now() });
  }
  if (isOrchestrator(id) && options.allowOrchestrator) {
    const { updateConfig } = await import("./config.ts");
    await updateConfig({ orchestrator: { agentId: null } });
  }
  emit({ kind: "delete", agentId: id, caller });
  log.info("agent.deleted", { agentId: id, caller });
  return true;
}

export type WriteAgentDocInput = {
  agentId: string;
  doc: DocName;
  mode: DocMode;
  content?: string;
  patches?: PatchPair[];
  expectedSha256?: string;
  allowEmpty?: boolean;
  caller?: string;
};

export async function writeAgentDoc(input: WriteAgentDocInput) {
  const caller = input.caller ?? "cli";
  const result = await writeDoc({ ...input, caller });
  emit({ kind: "doc", agentId: input.agentId, doc: input.doc, caller, sha256: result.sha256 });
  log.info("agent.doc_written", {
    agentId: input.agentId,
    doc: input.doc,
    mode: input.mode,
    caller,
    previous: result.previousSha256,
    sha: result.sha256,
    lines: result.lines,
  });
  return result;
}

export async function adminSnapshot(): Promise<{
  agents: (AgentRecord & { threadCount: number })[];
  bots: string[];
  orchestrator: string | null;
}> {
  const { orchestratorId } = await import("./orchestrator.ts");
  const [agents, records, bots] = await Promise.all([listAgents(), allSessionRecords(), listBots()]);
  return {
    agents: agents.map((agent) => ({
      ...agent,
      threadCount: records.filter((record) => record.agent === agent.id && !record.deletedAt).length,
    })),
    bots,
    orchestrator: orchestratorId(),
  };
}

/* ------------------------------- tools ------------------------------- */

function refusal(message: string): { output: { type: "text"; text: string }[]; isError: true } {
  return { output: [{ type: "text" as const, text: message }], isError: true };
}

async function callingAgent(conversationId: string): Promise<string | undefined> {
  return agentResolver()?.(conversationId);
}

async function requireOrchestrator(conversationId: string): Promise<string | ReturnType<typeof refusal>> {
  const agentId = await callingAgent(conversationId);
  if (!isOrchestrator(agentId)) {
    return refusal("Only the orchestrator may manage agents. This conversation belongs to " + (agentId ?? "no agent") + ".");
  }
  return agentId as string;
}

export const agentAdminListTool = defineTool({
  name: "agent_admin_list",
  description:
    "List every agent with its model, bot, tools, responsibility and thread count, plus the available Telegram bots and " +
    "the current orchestrator. Use before creating or editing anyone.",
  parameters: Type.Object({}),
  async execute(_args, api) {
    const guard = await requireOrchestrator(String(api.conversationId));
    if (typeof guard !== "string") return guard;
    const snapshot = await adminSnapshot();
    const lines = snapshot.agents.map((agent) =>
      [
        agent.id + " — " + agent.name,
        agent.enabled === false ? "disabled" : "enabled",
        agent.provider + "/" + agent.modelId,
        "bot: " + (agent.telegramBot ?? "default"),
        agent.responsibility ? "responsibility: " + agent.responsibility : "",
        agent.threadCount + " threads",
        isOrchestrator(agent.id) ? "ORCHESTRATOR" : "",
      ]
        .filter(Boolean)
        .join(" · "),
    );
    return {
      output: [
        {
          type: "text" as const,
          text:
            "Orchestrator: " + (snapshot.orchestrator ?? "none") + "\nBots: " + (snapshot.bots.join(", ") || "none") + "\n\n" + lines.join("\n"),
        },
      ],
      details: snapshot as never,
    };
  },
});

export const agentReadTool = defineTool({
  name: "agent_read",
  description:
    "Read one agent: its record summary, AGENT.md and SOUL.md, with a sha256 for each document. Pass that sha256 to " +
    "agent_write_doc so a concurrent edit cannot be clobbered. MEMORY.md is never returned.",
  parameters: Type.Object({ agent: Type.String({ description: "Agent id" }) }),
  async execute(args, api) {
    const guard = await requireOrchestrator(String(api.conversationId));
    if (typeof guard !== "string") return guard;
    const files = await readAgent(args.agent);
    if (!files) return refusal("unknown agent: " + args.agent);
    const docs = await readDocs(args.agent);
    return {
      output: [
        {
          type: "text" as const,
          text:
            "Agent " + args.agent + " (" + files.record.name + ") · " + files.record.provider + "/" + files.record.modelId +
            " · bot " + (files.record.telegramBot ?? "default") + " · " + (files.record.enabled === false ? "disabled" : "enabled") +
            "\nAGENT.md sha256 " + docs.agent.sha256 + " (" + docs.agent.lines + " lines)\n" + docs.agent.text +
            "\nSOUL.md sha256 " + docs.soul.sha256 + " (" + docs.soul.lines + " lines)\n" + docs.soul.text,
        },
      ],
      details: { record: files.record, agent: docs.agent, soul: docs.soul } as never,
    };
  },
});

export const agentCreateTool = defineTool({
  name: "agent_create",
  description:
    "Create one agent. Call it once per agent; several calls in one round are allowed and run in parallel. When more " +
    "than one Telegram bot exists you must ask the owner which bot with the question tool, then pass telegramBot.",
  parameters: Type.Object({
    name: Type.String({ description: "Display name; the id is derived from it" }),
    telegramBot: Type.Optional(Type.String({ description: "Bot registry label, when several bots exist" })),
    responsibility: Type.Optional(Type.String({ description: "One line: what this agent owns" })),
    agentMd: Type.Optional(Type.String({ description: "AGENT.md content. Omit for the template." })),
    soulMd: Type.Optional(Type.String({ description: "SOUL.md content. Omit for the template." })),
    modelId: Type.Optional(Type.String({ description: "Model id; must belong to the configured provider" })),
    provider: Type.Optional(Type.String({ description: "Provider id" })),
    tools: Type.Optional(Type.Array(Type.String(), { description: "Tool names; omit for the default full set" })),
    permissions: Type.Optional(Type.String({ description: "standard, custom or full" })),
    cwd: Type.Optional(Type.String({ description: "Working directory" })),
    mesh: Type.Optional(Type.String({ description: "off, message or full" })),
  }),
  async execute(args, api) {
    const guard = await requireOrchestrator(String(api.conversationId));
    if (typeof guard !== "string") return guard;
    try {
      const files = await createAgent({
        name: args.name,
        telegramBot: args.telegramBot,
        responsibility: args.responsibility,
        agentMd: args.agentMd,
        soulMd: args.soulMd,
        provider: args.provider,
        modelId: args.modelId,
        tools: args.tools,
        permissions: (args.permissions as AgentRecord["permissions"]) ?? undefined,
        cwd: args.cwd,
        mesh: (args.mesh as AgentRecord["mesh"]) ?? undefined,
        caller: "orchestrator",
      });
      return {
        output: [
          {
            type: "text" as const,
            text:
              "Created agent " + files.record.id + " (" + files.record.name + ") on bot " + (files.record.telegramBot ?? "default") +
              " with " + files.record.provider + "/" + files.record.modelId + ".",
          },
        ],
        details: files.record as never,
      };
    } catch (error) {
      if (error instanceof BotChoiceRequired) return refusal(error.message);
      return refusal(error instanceof Error ? error.message : String(error));
    }
  },
});

export const agentUpdateTool = defineTool({
  name: "agent_update",
  description:
    "Change an agent's record: name, model, tools, permissions, cwd, mesh policy, enabled, responsibility or bot. " +
    "Persona text is changed with agent_write_doc, not here.",
  parameters: Type.Object({
    agent: Type.String({ description: "Agent id" }),
    name: Type.Optional(Type.String()),
    responsibility: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    modelId: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(Type.String())),
    permissions: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    mesh: Type.Optional(Type.String()),
    telegramBot: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
  }),
  async execute(args, api) {
    const guard = await requireOrchestrator(String(api.conversationId));
    if (typeof guard !== "string") return guard;
    try {
      const files = await updateAgent({
        id: args.agent,
        name: args.name,
        responsibility: args.responsibility,
        provider: args.provider,
        modelId: args.modelId,
        tools: args.tools,
        permissions: (args.permissions as AgentRecord["permissions"]) ?? undefined,
        cwd: args.cwd,
        mesh: (args.mesh as AgentRecord["mesh"]) ?? undefined,
        telegramBot: args.telegramBot,
        enabled: args.enabled,
        caller: "orchestrator",
      });
      return {
        output: [{ type: "text" as const, text: "Updated agent " + args.agent + (args.enabled === false ? " (disabled)" : "") + "." }],
        details: files.record as never,
      };
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error));
    }
  },
});

export const agentWriteDocTool = defineTool({
  name: "agent_write_doc",
  description:
    "Change another agent's AGENT.md or SOUL.md. Read with agent_read first and pass expectedSha256. Prefer mode patch " +
    "with precise find/replace pairs; replace is for a full rewrite. Every write keeps the previous version in history.",
  parameters: Type.Object({
    agent: Type.String({ description: "Agent id" }),
    doc: Type.String({ description: "agent or soul" }),
    mode: Type.String({ description: "replace, append or patch" }),
    content: Type.Optional(Type.String({ description: "New text for replace/append" })),
    patches: Type.Optional(
      Type.Array(
        Type.Object({
          find: Type.String({ description: "Exact text that appears once" }),
          replace: Type.String({ description: "Replacement text" }),
        }),
      ),
    ),
    expectedSha256: Type.Optional(Type.String({ description: "sha256 from agent_read" })),
    allowEmpty: Type.Optional(Type.Boolean()),
  }),
  async execute(args, api) {
    const guard = await requireOrchestrator(String(api.conversationId));
    if (typeof guard !== "string") return guard;
    if (args.doc !== "agent" && args.doc !== "soul") return refusal("doc must be agent or soul");
    if (args.mode !== "replace" && args.mode !== "append" && args.mode !== "patch") {
      return refusal("mode must be replace, append or patch");
    }
    try {
      const result = await writeAgentDoc({
        agentId: args.agent,
        doc: args.doc,
        mode: args.mode,
        content: args.content,
        patches: args.patches as PatchPair[] | undefined,
        expectedSha256: args.expectedSha256,
        allowEmpty: args.allowEmpty,
        caller: "orchestrator",
      });
      return {
        output: [
          {
            type: "text" as const,
            text:
              "Wrote " + (args.doc === "agent" ? "AGENT.md" : "SOUL.md") + " for " + args.agent + " (" + args.mode + "): " +
              result.lines + " lines, sha256 " + result.sha256.slice(0, 12) + "…, " + result.rebound + " thread(s) rebound.",
          },
        ],
        details: result as never,
      };
    } catch (error) {
      if (error instanceof DocError) return refusal(error.message);
      return refusal(error instanceof Error ? error.message : String(error));
    }
  },
});

export const agentSetEnabledTool = defineTool({
  name: "agent_set_enabled",
  description: "Enable or disable an agent. A disabled agent keeps its threads but cannot start new ones. The orchestrator cannot disable itself.",
  parameters: Type.Object({ agent: Type.String(), enabled: Type.Boolean() }),
  async execute(args, api) {
    const guard = await requireOrchestrator(String(api.conversationId));
    if (typeof guard !== "string") return guard;
    try {
      await setEnabled(args.agent, args.enabled, "orchestrator");
      return { output: [{ type: "text" as const, text: args.agent + " is now " + (args.enabled ? "enabled" : "disabled") + "." }] };
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error));
    }
  },
});

export const agentDeleteTool = defineTool({
  name: "agent_delete",
  description:
    "Delete an agent and hide its threads. confirm must repeat the agent id. The orchestrator cannot delete itself, and " +
    "an agent with active inbox/delegate/schedule threads is refused.",
  parameters: Type.Object({ agent: Type.String(), confirm: Type.String() }),
  async execute(args, api) {
    const guard = await requireOrchestrator(String(api.conversationId));
    if (typeof guard !== "string") return guard;
    try {
      const removed = await deleteAgent(args.agent, { confirm: args.confirm, caller: "orchestrator" });
      return { output: [{ type: "text" as const, text: removed ? "Deleted agent " + args.agent + "." : "No agent " + args.agent + "." }] };
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error));
    }
  },
});

export const agentSuggestTool = defineTool({
  name: "agent_suggest",
  description: "Ask a model for a one-line responsibility for an existing agent, based on its SOUL.md.",
  parameters: Type.Object({ agent: Type.String() }),
  async execute(args, api) {
    const guard = await requireOrchestrator(String(api.conversationId));
    if (typeof guard !== "string") return guard;
    const files = await readAgent(args.agent);
    if (!files) return refusal("unknown agent: " + args.agent);
    const line = await suggestResponsibility(files.soulMd);
    return { output: [{ type: "text" as const, text: line }] };
  },
});

/**
 * Offered to every agent. With no orchestrator the call takes the role immediately; otherwise it
 * reports a request and the owner approves it from Telegram.
 */
export const orchestratorClaimTool = defineTool({
  name: "orchestrator_claim",
  description:
    "Become the orchestrator. If there is no orchestrator this takes effect immediately. If one exists, the owner " +
    "is asked to approve; report that the request was sent and do not claim it worked. Use only when the owner " +
    "asks you to take the role.",
  parameters: Type.Object({}),
  async execute(_args, api) {
    const agentId = await callingAgent(String(api.conversationId));
    if (!agentId) return refusal("This conversation has no agent, so it cannot take the role.");
    try {
      const result = await claimOrchestrator(agentId);
      if (result.status === "already") {
        return { output: [{ type: "text" as const, text: "You are already the orchestrator." }] };
      }
      if (result.status === "claimed") {
        return {
          output: [
            {
              type: "text" as const,
              text: "You are now the orchestrator. The administrative tools are available in this and your existing threads.",
            },
          ],
        };
      }
      return {
        output: [
          {
            type: "text" as const,
            text:
              "Request sent. " + (result.current ?? "another agent") + " is still the orchestrator; the owner must approve " +
              "the change from Telegram.",
          },
        ],
      };
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error));
    }
  },
});

export const botListTool = defineTool({
  name: "bot_list",
  description: "List Telegram bots, the one agent each bot belongs to, and the agents that have no bot. Use before pairing.",
  parameters: Type.Object({}),
  async execute(_args, api) {
    const guard = await requireOrchestrator(String(api.conversationId));
    if (typeof guard !== "string") return guard;
    const [bots, agents] = await Promise.all([listBots(), listAgents()]);
    const lines = bots.map((bot) => {
      const holder = agents.find((agent) => agent.telegramBot === bot);
      return "· " + bot + " → " + (holder ? holder.id + " (" + holder.name + ")" : "unpaired");
    });
    const unpaired = agents.filter((agent) => !agent.telegramBot).map((agent) => agent.id);
    return {
      output: [
        {
          type: "text" as const,
          text:
            "Bots (one bot belongs to one agent):\n" + (lines.join("\n") || "none") +
            "\nUnpaired agents: " + (unpaired.join(", ") || "none"),
        },
      ],
      details: { bots, unpaired } as never,
    };
  },
});

export const botAssignTool = defineTool({
  name: "bot_assign",
  description:
    "Connect one Telegram bot to one agent. The bot's previous agent is unpaired, and the agent's previous bot " +
    "is released. Every agent tool, including MCP, follows the agent, not the bot.",
  parameters: Type.Object({
    bot: Type.String({ description: "Bot registry label" }),
    agent: Type.String({ description: "Agent id" }),
  }),
  async execute(args, api) {
    const guard = await requireOrchestrator(String(api.conversationId));
    if (typeof guard !== "string") return guard;
    try {
      const result = await assignBotToAgent(args.bot, args.agent, "orchestrator");
      return {
        output: [
          {
            type: "text" as const,
            text:
              "Bot " + args.bot + " now belongs to " + args.agent +
              (result.freed.length > 0 ? "; unpaired " + result.freed.join(", ") : "") + ".",
          },
        ],
        details: result as never,
      };
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error));
    }
  },
});

export const botReleaseTool = defineTool({
  name: "bot_release",
  description: "Unpair a Telegram bot from its agent. The bot keeps running but answers with a pairing prompt.",
  parameters: Type.Object({ bot: Type.String({ description: "Bot registry label" }) }),
  async execute(args, api) {
    const guard = await requireOrchestrator(String(api.conversationId));
    if (typeof guard !== "string") return guard;
    try {
      const agents = await releaseBot(args.bot, "orchestrator");
      return { output: [{ type: "text" as const, text: agents.length ? "Unpaired: " + agents.join(", ") : "No agent held " + args.bot + "." }] };
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error));
    }
  },
});

export const mcpListTool = defineTool({
  name: "mcp_list",
  description: "List MCP servers and their tools. MCP tools are global: every agent has them.",
  parameters: Type.Object({}),
  async execute(_args, api) {
    const guard = await requireOrchestrator(String(api.conversationId));
    if (typeof guard !== "string") return guard;
    const servers = mcpStatus();
    const tools = mcpToolInfos();
    const lines = servers.map((server) => "· " + server.name + " · " + (server.connected ? "connected" : server.error ?? "stopped") + " · " + server.tools.length + " tools");
    return {
      output: [
        {
          type: "text" as const,
          text:
            "MCP servers (global):\n" + (lines.join("\n") || "none") +
            "\nTools: " + (tools.map((tool) => tool.registeredName).join(", ") || "none"),
        },
      ],
      details: { servers, tools } as never,
    };
  },
});

export const mcpAddTool = defineTool({
  name: "mcp_add",
  description:
    "Install a global MCP server (stdio command). Every agent receives its tools immediately. Only the owner should ask for this.",
  parameters: Type.Object({
    name: Type.String({ description: "Short lower-case label" }),
    command: Type.String({ description: "Executable, for example npx" }),
    args: Type.Optional(Type.Array(Type.String(), { description: "Command arguments" })),
    env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Environment variables (optional)" })),
  }),
  async execute(args, api) {
    const guard = await requireOrchestrator(String(api.conversationId));
    if (typeof guard !== "string") return guard;
    try {
      const result = await addMcpServer({ name: args.name, command: args.command, args: args.args, env: args.env });
      return {
        output: [
          {
            type: "text" as const,
            text:
              "MCP " + args.name + " connected: " + result.tools.length + " tools. All agents now have: " +
              result.tools.join(", ") + " (" + result.rebound + " conversations rebound).",
          },
        ],
        details: result as never,
      };
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error));
    }
  },
});

export const mcpRemoveTool = defineTool({
  name: "mcp_remove",
  description: "Remove a global MCP server; its tools disappear from every agent.",
  parameters: Type.Object({ name: Type.String() }),
  async execute(args, api) {
    const guard = await requireOrchestrator(String(api.conversationId));
    if (typeof guard !== "string") return guard;
    try {
      const result = await removeMcpServer(args.name);
      return { output: [{ type: "text" as const, text: result.removed ? "Removed " + args.name + " · " + result.rebound + " agents rebound." : "No MCP server " + args.name + "." }] };
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error));
    }
  },
});

export const agentAdminTools: ToolRegistration[] = [
  agentAdminListTool,
  agentReadTool,
  agentCreateTool,
  agentUpdateTool,
  agentWriteDocTool,
  agentSetEnabledTool,
  agentDeleteTool,
  agentSuggestTool,
  botListTool,
  botAssignTool,
  botReleaseTool,
  mcpListTool,
  mcpAddTool,
  mcpRemoveTool,
];

export const agentAdminExtension = defineExtension({
  name: "orchestrator-admin",
  // The claim tool is registered for every conversation (so a model call can resolve it) but only
  // offered where agentChangeOf adds it; the orchestrator-only tools are selected by role.
  tools: [...agentAdminTools, orchestratorClaimTool],
});

export { docHistory };
