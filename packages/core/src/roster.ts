import type { AgentRecord } from "./agents.ts";
import type { SessionRecord } from "./sessions.ts";

/**
 * Who owns which conversation, and which agent is working right now.
 *
 * A direct thread, a purpose thread and a group member conversation all belong to one agent. Keeping that
 * mapping in one place is what lets the mesh tool and the fleet view agree about status; two copies would
 * eventually disagree about a member conversation or a renamed thread.
 */
export type OwnedThread = {
  conversationId: string;
  agentId: string;
  /** The thread the owner sees in the sidebar. A group member conversation uses the room's title. */
  sessionId: string;
  title: string;
  purpose?: "inbox" | "delegate" | "schedule";
  updatedAt: number;
};

/** Every owned conversation, optionally including soft-deleted ones (usage wants them; the roster does not). */
export function ownedThreads(records: readonly SessionRecord[], includeDeleted = false): OwnedThread[] {
  const out: OwnedThread[] = [];
  for (const record of records) {
    if (!includeDeleted && record.deletedAt) continue;
    if (record.agent) {
      out.push({
        conversationId: String(record.id),
        agentId: record.agent,
        sessionId: String(record.id),
        title: record.title,
        ...(record.purpose ? { purpose: record.purpose } : {}),
        updatedAt: record.updatedAt,
      });
    }
    for (const [agentId, memberId] of Object.entries(record.room?.conversations ?? {})) {
      out.push({
        conversationId: String(memberId),
        agentId,
        sessionId: String(record.id),
        title: record.title,
        updatedAt: record.updatedAt,
      });
    }
  }
  return out;
}

export type AgentActivity = {
  status: "working" | "idle" | "disabled";
  since: number | null;
  active: OwnedThread[];
  current: OwnedThread | null;
  threads: OwnedThread[];
};

/** Resolve one agent's visible threads and whether any of them is generating. */
export function activityOf(
  agent: AgentRecord,
  threads: readonly OwnedThread[],
  activeIds: readonly string[],
  startedAt: (id: string) => number | undefined,
): AgentActivity {
  const mine = threads.filter((thread) => thread.agentId === agent.id);
  const activeSet = new Set(activeIds);
  const active = mine.filter((thread) => activeSet.has(thread.conversationId));
  let since: number | null = null;
  for (const thread of active) {
    const at = startedAt(thread.conversationId);
    if (typeof at === "number" && (since === null || at < since)) since = at;
  }
  const sorted = active.toSorted((a, b) => b.updatedAt - a.updatedAt);
  return {
    status: agent.enabled === false ? "disabled" : active.length > 0 ? "working" : "idle",
    since,
    active,
    current: sorted[0] ?? null,
    threads: mine.toSorted((a, b) => b.updatedAt - a.updatedAt),
  };
}
