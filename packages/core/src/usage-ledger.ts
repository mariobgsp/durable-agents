import { appendFile, readFile } from "node:fs/promises";
import type { Usage } from "@earendil-works/pi-ai";
import { usageLedgerPath } from "./paths.ts";

/**
 * Spend from model calls that have no conversation entry of their own.
 *
 * Nyahut's claim/oversee passes and the responsibility suggestion are stateless: they never enter a
 * transcript, so the answer-based usage report cannot see them. This append-only ledger is their home. It is
 * deliberately not a second copy of conversational usage: a conversation's own entries remain the source of
 * truth, and only calls with no conversation are written here.
 */
export type StatelessUsageEvent = {
  at: number;
  source: string;
  agentId?: string;
  provider: string;
  modelId: string;
  usage: Usage;
};

let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Read one stored usage object defensively: an older line may not have every counter. */
function usageOf(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    totalTokens?: unknown;
    cost?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; total?: unknown };
  };
  if (usage.totalTokens === undefined && usage.input === undefined) return undefined;
  return {
    input: numberOf(usage.input),
    output: numberOf(usage.output),
    cacheRead: numberOf(usage.cacheRead),
    cacheWrite: numberOf(usage.cacheWrite),
    totalTokens: numberOf(usage.totalTokens),
    cost: {
      input: numberOf(usage.cost?.input),
      output: numberOf(usage.cost?.output),
      cacheRead: numberOf(usage.cost?.cacheRead),
      cacheWrite: numberOf(usage.cost?.cacheWrite),
      total: numberOf(usage.cost?.total),
    },
  };
}

/**
 * Append one stateless call. A failed ledger write must never fail the model call that produced it: the
 * spend is already real, and losing the line is a reporting gap, not a reason to lose the answer.
 */
export async function recordStatelessUsage(event: {
  source: string;
  agentId?: string;
  provider: string;
  modelId: string;
  usage: Usage;
  at?: number;
}): Promise<void> {
  const line: StatelessUsageEvent = {
    at: typeof event.at === "number" && Number.isFinite(event.at) ? event.at : Date.now(),
    source: event.source,
    ...(event.agentId ? { agentId: event.agentId } : {}),
    provider: event.provider,
    modelId: event.modelId,
    usage: event.usage,
  };
  await serialize(async () => {
    try {
      await appendFile(usageLedgerPath, JSON.stringify(line) + "\n", "utf8");
    } catch (error) {
      console.warn("could not record stateless usage: " + String(error));
    }
  });
}

/** Every readable event, oldest first. Malformed lines are skipped rather than breaking the report. */
export async function readStatelessUsage(): Promise<StatelessUsageEvent[]> {
  let raw: string;
  try {
    raw = await readFile(usageLedgerPath, "utf8");
  } catch {
    return [];
  }
  const events: StatelessUsageEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const event = parsed as {
      at?: unknown;
      source?: unknown;
      agentId?: unknown;
      provider?: unknown;
      modelId?: unknown;
      usage?: unknown;
    };
    const usage = usageOf(event.usage);
    if (typeof event.at !== "number" || typeof event.source !== "string") continue;
    if (typeof event.provider !== "string" || typeof event.modelId !== "string" || !usage) continue;
    events.push({
      at: event.at,
      source: event.source,
      ...(typeof event.agentId === "string" ? { agentId: event.agentId } : {}),
      provider: event.provider,
      modelId: event.modelId,
      usage,
    });
  }
  return events.sort((a, b) => a.at - b.at);
}
