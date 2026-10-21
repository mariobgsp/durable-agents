import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Usage } from "@earendil-works/pi-ai";
import { context, harnessInstance } from "./harness.ts";
import { allSessionRecords, conversationIdFromParam } from "./sessions.ts";
import { readStatelessUsage } from "./usage-ledger.ts";

/**
 * Usage report for the Usage view and the fleet's per-agent totals.
 *
 * Everything here is derived from durable state — the session index, each conversation's entries, and the
 * stateless-call ledger — so the numbers cannot disagree with the transcript. The report is cached briefly
 * because a single visit reads every conversation, which is not something to repeat on every render.
 */
export type UsageNumbers = {
  turns: number;
  tokens: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type UsagePeriod =
  | "today"
  | "yesterday"
  | "last7"
  | "last30"
  | "thisMonth"
  | "lastMonth"
  | "all";

export type UsageReport = {
  generatedAt: number;
  timezone: string;
  firstAt: number | null;
  totals: UsageNumbers & { sessions: number; toolCalls: number };
  periods: Record<UsagePeriod, UsageNumbers>;
  agents: { id: string; name: string; all: UsageNumbers; today: UsageNumbers; month: UsageNumbers }[];
  models: (UsageNumbers & { provider: string; modelId: string })[];
  tools: { name: string; calls: number; errors: number; avgMs: number }[];
  days: (UsageNumbers & { date: string })[];
  months: (UsageNumbers & { month: string })[];
  stateless: UsageNumbers;
};

const CACHE_MS = 15_000;
let cache: { at: number; report: UsageReport } | undefined;

type Message = {
  provider?: unknown;
  model?: unknown;
  usage?: Usage;
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

function empty(): UsageNumbers {
  return { turns: 0, tokens: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function add(target: UsageNumbers, usage: Usage | undefined): void {
  if (!usage) return;
  target.turns += 1;
  target.tokens += numberOf(usage.totalTokens);
  target.cost += numberOf(usage.cost?.total);
  target.input += numberOf(usage.input);
  target.output += numberOf(usage.output);
  target.cacheRead += numberOf(usage.cacheRead);
  target.cacheWrite += numberOf(usage.cacheWrite);
}

function addAll(target: UsageNumbers, usage: Usage | undefined): void {
  add(target, usage);
}

function merge(target: UsageNumbers, source: UsageNumbers): void {
  target.turns += source.turns;
  target.tokens += source.tokens;
  target.cost += source.cost;
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
}

function copy(target: UsageNumbers): UsageNumbers {
  return {
    turns: target.turns,
    tokens: target.tokens,
    cost: target.cost,
    input: target.input,
    output: target.output,
    cacheRead: target.cacheRead,
    cacheWrite: target.cacheWrite,
  };
}

/** Local calendar day, which is what an owner means by "today". */
function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function monthKey(timestamp: number): string {
  return dayKey(timestamp).slice(0, 7);
}

function dayKeyOfDate(date: Date): string {
  return dayKey(date.getTime());
}

function monthKeyOfDate(date: Date): string {
  return monthKey(date.getTime());
}

/** Today's and this month's keys in the server's own zone. */
function nowKeys(now = Date.now()): { today: string; month: string } {
  const date = new Date(now);
  return { today: dayKeyOfDate(date), month: monthKeyOfDate(date) };
}

/**
 * Every local day from the first record through today, oldest first, including empty days.
 * A chart of "the last N days" that silently drops quiet days lies about the shape of the work.
 */
function allDays(
  filled: Map<string, UsageNumbers>,
  firstAt: number | null,
): (UsageNumbers & { date: string })[] {
  if (firstAt === null) return [];
  const start = new Date(firstAt);
  const end = new Date();
  const out: (UsageNumbers & { date: string })[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12, 0, 0, 0);
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 12, 0, 0, 0);
  // A clock that moved backwards must not create an unbounded series.
  let guard = 0;
  while (cursor.getTime() <= last.getTime() && guard < 20_000) {
    const key = dayKeyOfDate(cursor);
    out.push({ date: key, ...copy(filled.get(key) ?? empty()) });
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }
  return out;
}

/** Every local month from the first record through the current month, zero-filled. */
function allMonths(
  filled: Map<string, UsageNumbers>,
  firstAt: number | null,
): (UsageNumbers & { month: string })[] {
  if (firstAt === null) return [];
  const start = new Date(firstAt);
  const end = new Date();
  const out: (UsageNumbers & { month: string })[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1, 12, 0, 0, 0);
  const last = new Date(end.getFullYear(), end.getMonth(), 1, 12, 0, 0, 0);
  let guard = 0;
  while (cursor.getTime() <= last.getTime() && guard < 1_200) {
    const key = monthKeyOfDate(cursor);
    out.push({ month: key, ...copy(filled.get(key) ?? empty()) });
    cursor.setMonth(cursor.getMonth() + 1);
    guard += 1;
  }
  return out;
}

function periodsFrom(days: (UsageNumbers & { date: string })[], totals: UsageNumbers): Record<UsagePeriod, UsageNumbers> {
  const periods: Record<UsagePeriod, UsageNumbers> = {
    today: empty(),
    yesterday: empty(),
    last7: empty(),
    last30: empty(),
    thisMonth: empty(),
    lastMonth: empty(),
    all: copy(totals),
  };
  if (days.length === 0) return periods;
  const now = new Date();
  const today = dayKeyOfDate(now);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0, 0);
  const yesterdayKey = dayKeyOfDate(yesterday);
  const sevenStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 12, 0, 0, 0);
  const thirtyStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29, 12, 0, 0, 0);
  const thisMonth = monthKeyOfDate(now);
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1, 12, 0, 0, 0);
  const lastMonth = monthKeyOfDate(lastMonthDate);
  for (const day of days) {
    const date = new Date(day.date + "T12:00:00");
    if (day.date === today) merge(periods.today, day);
    if (day.date === yesterdayKey) merge(periods.yesterday, day);
    if (date.getTime() >= sevenStart.getTime()) merge(periods.last7, day);
    if (date.getTime() >= thirtyStart.getTime()) merge(periods.last30, day);
    if (day.date.slice(0, 7) === thisMonth) merge(periods.thisMonth, day);
    if (day.date.slice(0, 7) === lastMonth) merge(periods.lastMonth, day);
  }
  return periods;
}

export async function usageReport(fresh = false): Promise<UsageReport> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.report;

  const records = await allSessionRecords();
  const agentNames = new Map<string, string>();
  try {
    const { listAgents } = await import("./agents.ts");
    for (const agent of await listAgents()) agentNames.set(agent.id, agent.name);
  } catch {
    /* An unreadable agents directory must not hide the rest of the report. */
  }

  // conversation id -> owning agent, for direct threads, purpose threads and each member's group conversation.
  const ownership: { conversationId: string; agentId?: string }[] = [];
  for (const record of records) {
    ownership.push({ conversationId: String(record.id), ...(record.agent ? { agentId: record.agent } : {}) });
    for (const [agentId, memberId] of Object.entries(record.room?.conversations ?? {})) {
      ownership.push({ conversationId: String(memberId), agentId });
    }
  }

  const agents = new Map<string, { all: UsageNumbers; today: UsageNumbers; month: UsageNumbers }>();
  const models = new Map<string, UsageNumbers>();
  const tools = new Map<string, { calls: number; errors: number; delays: number }>();
  const days = new Map<string, UsageNumbers>();
  const months = new Map<string, UsageNumbers>();
  const totals = empty();
  const { today, month: currentMonth } = nowKeys();
  let firstAt: number | null = null;

  const addDay = (at: number, usage: Usage | undefined): void => {
    if (!usage || at <= 0) return;
    const day = dayKey(at);
    const slot = days.get(day) ?? empty();
    add(slot, usage);
    days.set(day, slot);
    const mo = monthKey(at);
    const monthSlot = months.get(mo) ?? empty();
    add(monthSlot, usage);
    months.set(mo, monthSlot);
    if (firstAt === null || at < firstAt) firstAt = at;
  };

  const addAgent = (agentId: string | undefined, at: number, usage: Usage | undefined): void => {
    if (!agentId || !usage) return;
    const slot = agents.get(agentId) ?? { all: empty(), today: empty(), month: empty() };
    add(slot.all, usage);
    if (at > 0) {
      if (dayKey(at) === today) add(slot.today, usage);
      if (monthKey(at) === currentMonth) add(slot.month, usage);
    }
    agents.set(agentId, slot);
  };

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
        addAll(totals, message?.usage);
        addAgent(agentId, at, message?.usage);
        addDay(at, message?.usage);
        const provider = typeof message?.provider === "string" ? message.provider : "unknown";
        const modelId = typeof message?.model === "string" ? message.model : "unknown";
        const key = provider + "/" + modelId;
        const model = models.get(key) ?? empty();
        add(model, message?.usage);
        models.set(key, model);
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

  const stateless = empty();
  for (const event of await readStatelessUsage()) {
    add(stateless, event.usage);
    addAll(totals, event.usage);
    addAgent(event.agentId, event.at, event.usage);
    addDay(event.at, event.usage);
    const key = event.provider + "/" + event.modelId;
    const model = models.get(key) ?? empty();
    add(model, event.usage);
    models.set(key, model);
  }

  const dayRows = allDays(days, firstAt);
  const monthRows = allMonths(months, firstAt);
  const periods = periodsFrom(dayRows, totals);

  const report: UsageReport = {
    generatedAt: Date.now(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    firstAt,
    totals: {
      ...copy(totals),
      sessions: records.length,
      toolCalls: [...tools.values()].reduce((sum, slot) => sum + slot.calls, 0),
    },
    periods,
    agents: [...agents.entries()]
      .map(([id, target]) => ({
        id,
        name: agentNames.get(id) ?? id,
        all: copy(target.all),
        today: copy(target.today),
        month: copy(target.month),
      }))
      .sort((a, b) => b.all.turns - a.all.turns),
    models: [...models.entries()]
      .map(([key, target]) => {
        const cut = key.indexOf("/");
        return { provider: key.slice(0, cut), modelId: key.slice(cut + 1), ...copy(target) };
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
    days: dayRows,
    months: monthRows,
    stateless: copy(stateless),
  };

  cache = { at: Date.now(), report };
  return report;
}