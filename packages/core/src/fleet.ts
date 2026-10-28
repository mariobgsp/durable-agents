import { activeIds, startedAt as activityStartedAt } from "./activity.ts";
import { listAgents } from "./agents.ts";
import { policyOf, type PermissionPolicy } from "./permissions.ts";
import { listLinks, type MeshLink } from "./mesh.ts";
import { activityOf, ownedThreads } from "./roster.ts";
import { allSessionRecords } from "./sessions.ts";
import { scheduleSummary, scheduleTimezone, type ScheduleStatus } from "./schedules.ts";

/**
 * The compact fleet view: every agent, what it is doing now, and the recent agent-to-agent traffic.
 *
 * This is assembled from the session index, the in-memory activity registry, the mesh link index and the
 * schedule store. It deliberately does not scan transcripts or usage: the roster updates on activity
 * changes, and a token report is a separate cached read.
 */
export type FleetStatus = "working" | "idle" | "disabled";

export type FleetThread = { id: string; title: string; purpose?: "inbox" | "delegate" | "schedule" };

export type FleetSchedule = {
  id: string;
  agentId: string;
  name: string;
  cron: string;
  enabled: boolean;
  nextRunAt?: number;
  lastStatus?: ScheduleStatus;
};

export type FleetAgent = {
  id: string;
  name: string;
  color?: string;
  avatar?: string;
  model: { provider: string; modelId: string };
  responsibility?: string;
  enabled: boolean;
  policy: PermissionPolicy;
  mesh: "off" | "message" | "full";
  status: FleetStatus;
  since: number | null;
  activeThreads: FleetThread[];
  currentThread: FleetThread | null;
  threadCount: number;
  lastActiveAt: number | null;
  links: { inbound: number; outbound: number; active: number };
  schedules: { total: number; enabled: number; nextRunAt?: number; nextName?: string };
};

export type FleetLink = {
  id: string;
  batchId: string;
  kind: "message" | "delegate";
  from: string;
  to: string;
  fromThreadId: string;
  threadId: string;
  status: "sent" | "answered" | "failed";
  hop: number;
  preview?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  active: boolean;
};

export type FleetSnapshot = {
  generatedAt: number;
  timezone: string;
  agents: FleetAgent[];
  links: FleetLink[];
  schedules: FleetSchedule[];
  totals: { agents: number; working: number; idle: number; disabled: number; activeLinks: number };
};

function toThread(thread: { sessionId: string; title: string; purpose?: "inbox" | "delegate" | "schedule" }): FleetThread {
  return {
    id: thread.sessionId,
    title: thread.title,
    ...(thread.purpose ? { purpose: thread.purpose } : {}),
  };
}

function toFleetLink(link: MeshLink, active: Set<string>): FleetLink {
  return {
    id: link.id,
    batchId: link.batchId,
    kind: link.kind,
    from: link.from,
    to: link.to,
    fromThreadId: link.fromThreadId,
    threadId: link.threadId,
    status: link.status,
    hop: link.hop,
    ...(link.preview ? { preview: link.preview } : {}),
    ...(link.error ? { error: link.error } : {}),
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    active: active.has(link.threadId) || active.has(link.fromThreadId),
  };
}

export async function fleetSnapshot(): Promise<FleetSnapshot> {
  const [agents, records, links, schedules] = await Promise.all([
    listAgents(),
    allSessionRecords(),
    listLinks(),
    scheduleSummary(),
  ]);
  const threads = ownedThreads(records);
  const active = activeIds();
  const activeSet = new Set(active);
  const fleetLinks = links.slice(0, 30).map((link) => toFleetLink(link, activeSet));

  const rows: FleetAgent[] = agents.map((agent) => {
    const activity = activityOf(agent, threads, active, activityStartedAt);
    const mine = threads.filter((thread) => thread.agentId === agent.id);
    const lastActiveAt = mine.reduce<number | null>(
      (latest, thread) => (latest === null || thread.updatedAt > latest ? thread.updatedAt : latest),
      activity.since,
    );
    const inbound = fleetLinks.filter((link) => link.to === agent.id).length;
    const outbound = fleetLinks.filter((link) => link.from === agent.id).length;
    const activeLinks = fleetLinks.filter(
      (link) => (link.from === agent.id || link.to === agent.id) && link.active,
    ).length;
    const ownSchedules = schedules.filter((schedule) => schedule.agentId === agent.id);
    const next = ownSchedules
      .filter((schedule) => schedule.enabled && schedule.nextRunAt !== undefined)
      .toSorted((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0];
    return {
      id: agent.id,
      name: agent.name,
      ...(agent.color ? { color: agent.color } : {}),
      ...(agent.avatar ? { avatar: agent.avatar } : {}),
      model: { provider: agent.provider, modelId: agent.modelId },
      ...(agent.responsibility ? { responsibility: agent.responsibility } : {}),
      enabled: agent.enabled !== false,
      policy: policyOf(agent),
      mesh: agent.mesh ?? "full",
      status: activity.status,
      since: activity.since,
      activeThreads: activity.active.map(toThread),
      currentThread: activity.current ? toThread(activity.current) : null,
      threadCount: mine.length,
      lastActiveAt,
      links: { inbound, outbound, active: activeLinks },
      schedules: {
        total: ownSchedules.length,
        enabled: ownSchedules.filter((schedule) => schedule.enabled).length,
        ...(next?.nextRunAt === undefined ? {} : { nextRunAt: next.nextRunAt }),
        ...(next?.name ? { nextName: next.name } : {}),
      },
    };
  });

  const working = rows.filter((agent) => agent.status === "working").length;
  const disabled = rows.filter((agent) => agent.status === "disabled").length;
  return {
    generatedAt: Date.now(),
    timezone: scheduleTimezone(),
    agents: rows,
    links: fleetLinks,
    schedules: schedules.map((schedule) => ({
      id: schedule.id,
      agentId: schedule.agentId,
      name: schedule.name,
      cron: schedule.cron,
      enabled: schedule.enabled,
      ...(schedule.nextRunAt === undefined ? {} : { nextRunAt: schedule.nextRunAt }),
      ...(schedule.lastStatus === undefined ? {} : { lastStatus: schedule.lastStatus }),
    })),
    totals: {
      agents: rows.length,
      working,
      idle: rows.length - working - disabled,
      disabled,
      activeLinks: fleetLinks.filter((link) => link.active).length,
    },
  };
}
