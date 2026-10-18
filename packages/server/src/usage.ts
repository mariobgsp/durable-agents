import type { EntryRecord } from "@earendil-works/pi-durable";
import { context, harnessInstance } from "./harness.ts";
import { allSessionRecords, conversationIdFromParam } from "./sessions.ts";

/**
 * Usage report for the graph view: who answered, on which model, at what cost, and how the tools behaved.
 *
 * Everything here is derived from durable state — the session index and each conversation's entries — so the
 * numbers cannot disagree with the transcript. The report is cached briefly because a single visit reads every
 * conversation, which is not something to repeat on every render.
 */
export type UsageBucket = {
  turns: number;
  tokens: number;
  cost: number;
};

export type UsageReport = {
  generatedAt: number;
  totals: UsageBucket & { sessions: number; toolCalls: number };
  agents: (UsageBucket & { id: string; name: string })[];
  models: (UsageBucket & { provider: string; modelId: string })[];
  tools: { name: string; calls: number; errors: number; avgMs: number }[];
  days: { date: string; turns: number; tokens: number }[];
};

const CACHE_MS = 30_000;
const DAYS = 14;
let cache: { at: number; report: UsageReport } | undefined;

type Message = {
  provider?: unknown;
  model?: unknown;
  usage?: { totalTokens?: unknown; cost?: { total?: unknown } };
  timestamp?: unknown;
  toolName?: unknown;
  durationMs?: unknown;
  isError?: unknown;
};

function messageOf(entry: EntryRecord): Message | undefined {
  const model = entry.model;
  if (!Array.isArray(model) || model.length === 0) return undefined;
  const first: unknown = model[0];
  return first && typeof first === "object" ? (first as Message) : undefined;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dayOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Empty bucket, so a caller never has to spell out the zeroes.
 *
 * There is deliberately no latency here: an entry carries no wall-clock time (an assistant message's own
 * `timestamp` is when its request started), so any "reply time" computed from entries would measure queueing
 * and look like a 40 ms answer. The only duration that is really measured is a tool call's.
 */
function bucket(): UsageBucket {
  return { turns: 0, tokens: 0, cost: 0 };
}

function add(target: UsageBucket, usage: Message["usage"]): void {
  target.turns += 1;
  target.tokens += numberOf(usage?.totalTokens);
  target.cost += numberOf(usage?.cost?.total);
}

function finish(target: UsageBucket): UsageBucket {
  return { turns: target.turns, tokens: target.tokens, cost: target.cost };
}

/** The last `DAYS` calendar days, oldest first, with data folded in where it exists. */
function recentDays(filled: Map<string, { turns: number; tokens: number }>): {
  date: string;
  turns: number;
  tokens: number;
}[] {
  const now = new Date();
  const out: { date: string; turns: number; tokens: number }[] = [];
  for (let back = DAYS - 1; back >= 0; back -= 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back));
    const date = day.toISOString().slice(0, 10);
    out.push({ date, ...(filled.get(date) ?? { turns: 0, tokens: 0 }) });
  }
  return out;
}

export async function usageReport(): Promise<UsageReport> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.report;

  const records = (await allSessionRecords()).filter((record) => !record.deletedAt);
  const agentNames = new Map<string, string>();
  try {
    const { listAgents } = await import("./agents.ts");
    for (const agent of await listAgents()) agentNames.set(agent.id, agent.name);
  } catch {
    /* An unreadable agents directory must not hide the rest of the report. */
  }

  // conversation id -> owning agent, for direct threads and for each member's conversation in a group.
  const ownership: { conversationId: string; agentId?: string }[] = [];
  for (const record of records) {
    ownership.push({ conversationId: String(record.id), ...(record.agent ? { agentId: record.agent } : {}) });
    for (const [agentId, memberId] of Object.entries(record.room?.conversations ?? {})) {
      ownership.push({ conversationId: String(memberId), agentId });
    }
  }

  const agents = new Map<string, UsageBucket>();
  const models = new Map<string, UsageBucket>();
  const tools = new Map<string, { calls: number; errors: number; delays: number }>();
  const days = new Map<string, { turns: number; tokens: number }>();
  const totals = bucket();

  const harness = harnessInstance();
  for (const { conversationId, agentId } of ownership) {
    const id = conversationIdFromParam(conversationId);
    if (id === null) continue;
    const conversation = await harness.conversation(id, context);
    if (!conversation) continue;
    const view = await conversation.viewState(context);

    for (const entry of view.value.entries) {
      const message = messageOf(entry);
      if (entry.kind === "pi.assistant") {
        const at = numberOf(message?.timestamp);
        add(totals, message?.usage);
        if (agentId) {
          const target = agents.get(agentId) ?? bucket();
          add(target, message?.usage);
          agents.set(agentId, target);
        }
        const provider = typeof message?.provider === "string" ? message.provider : "unknown";
        const modelId = typeof message?.model === "string" ? message.model : "unknown";
        const key = provider + "/" + modelId;
        const model = models.get(key) ?? bucket();
        add(model, message?.usage);
        models.set(key, model);
        if (at > 0) {
          const day = dayOf(at);
          const slot = days.get(day) ?? { turns: 0, tokens: 0 };
          slot.turns += 1;
          slot.tokens += numberOf(message?.usage?.totalTokens);
          days.set(day, slot);
        }
        continue;
      }
      if (entry.kind === "pi.tool-result") {
        const name = typeof message?.toolName === "string" ? message.toolName : "unknown";
        const slot = tools.get(name) ?? { calls: 0, errors: 0, delays: 0 };
        slot.calls += 1;
        if (message?.isError === true) slot.errors += 1;
        slot.delays += numberOf(message?.durationMs);
        tools.set(name, slot);
      }
    }
  }

  const report: UsageReport = {
    generatedAt: Date.now(),
    totals: {
      ...finish(totals),
      sessions: records.length,
      toolCalls: [...tools.values()].reduce((sum, slot) => sum + slot.calls, 0),
    },
    agents: [...agents.entries()]
      .map(([id, target]) => ({ id, name: agentNames.get(id) ?? id, ...finish(target) }))
      .sort((a, b) => b.turns - a.turns),
    models: [...models.entries()]
      .map(([key, target]) => {
        const cut = key.indexOf("/");
        return { provider: key.slice(0, cut), modelId: key.slice(cut + 1), ...finish(target) };
      })
      .sort((a, b) => b.tokens - a.tokens),
    tools: [...tools.entries()]
      .map(([name, slot]) => ({
        name,
        calls: slot.calls,
        errors: slot.errors,
        avgMs: slot.calls > 0 ? Math.round(slot.delays / slot.calls) : 0,
      }))
      .sort((a, b) => b.calls - a.calls),
    // Always the whole window, empty days included: a chart of "the last 14 days" that silently drops the
    // quiet ones is a chart that lies about the shape of the work.
    days: recentDays(days),
  };

  cache = { at: Date.now(), report };
  return report;
}
