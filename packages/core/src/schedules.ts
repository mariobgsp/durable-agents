import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { isActive } from "./activity.ts";
import { readAgent } from "./agents.ts";
import { nextRuns, CronError } from "./cron.ts";
import { harnessInstance } from "./harness.ts";
import { schedulesPath } from "./paths.ts";
import {
  allSessionRecords,
  conversationOf,
  createSession,
  findSession,
  renameSession,
  sendMessage,
} from "./sessions.ts";
import { entryToMsg } from "./transcript.ts";
import type { UserVia } from "./attachments.ts";

/**
 * Per-agent cron schedules.
 *
 * A schedule owns one dedicated thread: every run is a normal user input there, so the answer, the run
 * summary, the transcript and the usage report all work without a second execution path. The scheduler is
 * one process-wide interval; it reads the durable store on each tick, so a restart needs no reconstruction.
 */

export type ScheduleStatus = "running" | "done" | "skipped" | "failed" | "interrupted";

export type ScheduleRecord = {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastScheduledFor?: number;
  lastStatus?: ScheduleStatus;
  lastError?: string;
  lastDurationMs?: number;
  lastTokens?: number;
  lastCacheRead?: number;
  lastSubmissionId?: string;
  nextRunAt?: number;
  runCount: number;
  missedRuns: number;
  threadId?: number;
};

export type WireSchedule = Omit<ScheduleRecord, "threadId"> & { threadId?: string };

type ScheduleState = { version: 1; schedules: ScheduleRecord[] };

export class ScheduleError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, code: string, message: string) {
    super(message);
    this.name = "ScheduleError";
    this.code = code;
    this.status = status;
  }
}

let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

function timezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

async function readState(): Promise<ScheduleState> {
  try {
    const parsed = JSON.parse(await readFile(schedulesPath, "utf8")) as Partial<ScheduleState>;
    return {
      version: 1,
      schedules: Array.isArray(parsed.schedules) ? (parsed.schedules as ScheduleRecord[]).filter(isRecord) : [],
    };
  } catch {
    return { version: 1, schedules: [] };
  }
}

async function writeState(state: ScheduleState): Promise<void> {
  await mkdir(dirname(schedulesPath), { recursive: true });
  const tmp = schedulesPath + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, schedulesPath);
}

function isRecord(value: unknown): value is ScheduleRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ScheduleRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.agentId === "string" &&
    typeof record.name === "string" &&
    typeof record.prompt === "string" &&
    typeof record.cron === "string" &&
    typeof record.enabled === "boolean"
  );
}

const listeners = new Set<() => void>();
export function subscribeSchedules(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* One broken listener must not stop a schedule. */
    }
  }
}

function toWire(record: ScheduleRecord): WireSchedule {
  const { threadId, ...rest } = record;
  return { ...rest, ...(threadId === undefined ? {} : { threadId: String(threadId) }) };
}

export async function listSchedules(agentId?: string): Promise<WireSchedule[]> {
  const state = await readState();
  return state.schedules
    .filter((record) => !agentId || record.agentId === agentId)
    .toSorted((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER))
    .map(toWire);
}

export async function findSchedule(id: string): Promise<ScheduleRecord | undefined> {
  return (await readState()).schedules.find((record) => record.id === id);
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (name.length === 0) throw new ScheduleError(400, "invalid_name", "A schedule needs a name.");
  return name.slice(0, 80);
}

function cleanPrompt(value: unknown): string {
  const prompt = typeof value === "string" ? value.trim() : "";
  if (prompt.length === 0) throw new ScheduleError(400, "invalid_prompt", "A schedule needs a prompt.");
  return prompt.slice(0, 20_000);
}

function nextAfter(expression: string, from: number): number | undefined {
  try {
    return nextRuns(expression, from, 1)[0];
  } catch (error) {
    if (error instanceof CronError) {
      throw new ScheduleError(400, "invalid_cron", error.message);
    }
    throw error;
  }
}

export type ScheduleInput = {
  agentId: string;
  name: string;
  prompt: string;
  cron: string;
  enabled?: boolean;
};

export async function createSchedule(input: ScheduleInput): Promise<WireSchedule> {
  const agent = await readAgent(input.agentId);
  if (!agent) throw new ScheduleError(404, "agent_not_found", "Agent not found: " + input.agentId);
  const name = cleanName(input.name);
  const prompt = cleanPrompt(input.prompt);
  const cron = typeof input.cron === "string" ? input.cron.trim() : "";
  if (cron.length === 0) throw new ScheduleError(400, "invalid_cron", "A schedule needs a cron expression.");
  const enabled = input.enabled !== false;
  const now = Date.now();
  const nextRunAt = enabled ? nextAfter(cron, now) : undefined;
  const record: ScheduleRecord = {
    id: randomUUID(),
    agentId: agent.record.id,
    name,
    prompt,
    cron,
    enabled,
    createdAt: now,
    updatedAt: now,
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    runCount: 0,
    missedRuns: 0,
  };
  await serialize(async () => {
    const state = await readState();
    state.schedules.push(record);
    await writeState(state);
  });
  emit();
  return toWire(record);
}

export type SchedulePatch = Partial<Pick<ScheduleRecord, "name" | "prompt" | "cron" | "enabled">>;

export async function updateSchedule(id: string, patch: SchedulePatch): Promise<WireSchedule> {
  let updated: ScheduleRecord | undefined;
  await serialize(async () => {
    const state = await readState();
    const index = state.schedules.findIndex((record) => record.id === id);
    if (index === -1) throw new ScheduleError(404, "schedule_not_found", "Schedule not found.");
    const current = state.schedules[index]!;
    const name = patch.name === undefined ? current.name : cleanName(patch.name);
    const prompt = patch.prompt === undefined ? current.prompt : cleanPrompt(patch.prompt);
    const cron = patch.cron === undefined ? current.cron : patch.cron.trim();
    const enabled = patch.enabled === undefined ? current.enabled : patch.enabled;
    if (cron.length === 0) throw new ScheduleError(400, "invalid_cron", "A schedule needs a cron expression.");
    const nextRunAt = enabled ? nextAfter(cron, Date.now()) : undefined;
    const next: ScheduleRecord = {
      ...current,
      name,
      prompt,
      cron,
      enabled,
      updatedAt: Date.now(),
      ...(nextRunAt === undefined ? { nextRunAt: undefined } : { nextRunAt }),
    };
    if (nextRunAt === undefined) delete next.nextRunAt;
    state.schedules[index] = next;
    await writeState(state);
    updated = next;
  });
  if (updated?.threadId) {
    const record = updated;
    // Keep the visible thread title in step with the schedule name. A missing thread is recreated next run.
    await renameSession(String(record.threadId), "Cron · " + record.name).catch(() => undefined);
  }
  emit();
  if (!updated) throw new ScheduleError(404, "schedule_not_found", "Schedule not found.");
  return toWire(updated);
}

export async function deleteSchedule(id: string): Promise<boolean> {
  let removed = false;
  await serialize(async () => {
    const state = await readState();
    const next = state.schedules.filter((record) => record.id !== id);
    if (next.length === state.schedules.length) return;
    state.schedules = next;
    removed = true;
    await writeState(state);
  });
  if (removed) emit();
  return removed;
}

/** Delete every schedule owned by an agent. Called when the agent itself is deleted. */
export async function deleteSchedulesForAgent(agentId: string): Promise<number> {
  let removed = 0;
  await serialize(async () => {
    const state = await readState();
    const next = state.schedules.filter((record) => record.agentId !== agentId);
    removed = state.schedules.length - next.length;
    if (removed === 0) return;
    state.schedules = next;
    await writeState(state);
  });
  if (removed > 0) emit();
  return removed;
}

/** Called when a schedule thread is purged: the next run creates a fresh one. */
export async function forgetScheduleThread(threadId: string): Promise<void> {
  let changed = false;
  await serialize(async () => {
    const state = await readState();
    for (const record of state.schedules) {
      if (String(record.threadId) !== threadId) continue;
      delete record.threadId;
      changed = true;
    }
    if (changed) await writeState(state);
  });
  if (changed) emit();
}

const running = new Set<string>();
let ticking = false;

async function patchRecord(id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord | undefined> {
  let updated: ScheduleRecord | undefined;
  await serialize(async () => {
    const state = await readState();
    const index = state.schedules.findIndex((record) => record.id === id);
    if (index === -1) return;
    state.schedules[index] = { ...state.schedules[index]!, ...patch, updatedAt: Date.now() };
    await writeState(state);
    updated = state.schedules[index]!;
  });
  if (updated) emit();
  return updated;
}

async function note(threadId: number, text: string): Promise<void> {
  const conversation = await conversationOf(String(threadId));
  if (!conversation) return;
  await conversation.submit(
    { type: "write", entry: { kind: "schedule.note", data: { text } } },
    BACKGROUND_CONTEXT,
  );
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 400);
}

async function ensureThread(record: ScheduleRecord): Promise<number> {
  if (record.threadId !== undefined) {
    const existing = await findSession(String(record.threadId));
    if (existing && !existing.deletedAt && existing.agent === record.agentId) return record.threadId;
  }
  const created = await createSession("Cron · " + record.name, record.agentId, {
    purpose: "schedule",
    scheduleId: record.id,
  });
  const id = Number(created.id);
  await patchRecord(record.id, { threadId: id });
  return id;
}

async function watchRun(
  scheduleId: string,
  threadId: number,
  submissionId: string,
  startedAt: number,
): Promise<void> {
  try {
    const numeric = Number(submissionId);
    const submission = Number.isSafeInteger(numeric)
      ? await harnessInstance().submission(numeric as SubmissionId, BACKGROUND_CONTEXT)
      : undefined;
    if (!submission) {
      await patchRecord(scheduleId, {
        lastStatus: "failed",
        lastError: "the run submission no longer exists",
        lastDurationMs: Date.now() - startedAt,
      });
      return;
    }
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    if (settled.status !== "done") {
      await patchRecord(scheduleId, {
        lastStatus: "failed",
        lastError: settled.reason,
        lastDurationMs: Date.now() - startedAt,
      });
      return;
    }
    let tokens: number | undefined;
    let cacheRead: number | undefined;
    if (settled.type === "input") {
      const conversation = await conversationOf(String(threadId));
      const entry = conversation ? await conversation.commit((tx) => tx.entry(settled.answer), BACKGROUND_CONTEXT) : undefined;
      const message = entry ? entryToMsg(entry) : null;
      if (message?.usage) {
        tokens = message.usage.totalTokens;
        cacheRead = message.usage.cacheRead;
      }
    }
    await patchRecord(scheduleId, {
      lastStatus: "done",
      lastDurationMs: Date.now() - startedAt,
      ...(tokens === undefined ? {} : { lastTokens: tokens }),
      ...(cacheRead === undefined ? {} : { lastCacheRead: cacheRead }),
      lastError: undefined,
    });
  } catch (error) {
    await patchRecord(scheduleId, {
      lastStatus: "failed",
      lastError: messageOf(error),
      lastDurationMs: Date.now() - startedAt,
    });
  }
}

async function executeSchedule(record: ScheduleRecord, dueAt: number): Promise<{ accepted: boolean; threadId?: string; submissionId?: string; reason?: string }> {
  if (running.has(record.id)) return { accepted: false, reason: "already running" };
  running.add(record.id);
  const startedAt = Date.now();
  try {
    const agent = await readAgent(record.agentId);
    const nextRunAt = record.enabled ? nextAfter(record.cron, Date.now()) : undefined;
    if (!agent) {
      await patchRecord(record.id, {
        lastStatus: "failed",
        lastError: "agent not found",
        lastRunAt: startedAt,
        lastScheduledFor: dueAt,
        ...(nextRunAt === undefined ? { nextRunAt: undefined } : { nextRunAt }),
      });
      return { accepted: false, reason: "agent not found" };
    }
    if (agent.record.enabled === false) {
      await patchRecord(record.id, {
        lastStatus: "skipped",
        lastError: "agent is disabled",
        lastRunAt: startedAt,
        lastScheduledFor: dueAt,
        ...(nextRunAt === undefined ? { nextRunAt: undefined } : { nextRunAt }),
      });
      return { accepted: false, reason: "agent is disabled" };
    }
    const threadId = await ensureThread(record);
    if (isActive(String(threadId))) {
      await note(threadId, "Skipped " + new Date(startedAt).toLocaleString() + ": the previous run is still working.");
      await patchRecord(record.id, {
        lastStatus: "skipped",
        lastError: "previous run still working",
        lastRunAt: startedAt,
        lastScheduledFor: dueAt,
        ...(nextRunAt === undefined ? { nextRunAt: undefined } : { nextRunAt }),
      });
      return { accepted: false, threadId: String(threadId), reason: "previous run still working" };
    }
    const requestId = "schedule:" + record.id + ":" + dueAt;
    await patchRecord(record.id, {
      lastStatus: "running",
      lastRunAt: startedAt,
      lastScheduledFor: dueAt,
      lastError: undefined,
      lastSubmissionId: undefined,
      ...(nextRunAt === undefined ? { nextRunAt: undefined } : { nextRunAt }),
    });
    const via: UserVia = { kind: "schedule", id: record.id, name: record.name };
    const sent = await sendMessage(
      String(threadId),
      { text: record.prompt, requestId },
      "followUp",
      {
        via,
        preamble:
          'Scheduled run "' +
          record.name +
          '" (' +
          record.cron +
          "). This prompt was sent automatically by your owner's schedule.",
      },
    );
    if (!sent) {
      await patchRecord(record.id, { lastStatus: "failed", lastError: "thread could not take the run" });
      return { accepted: false, threadId: String(threadId), reason: "thread could not take the run" };
    }
    await patchRecord(record.id, {
      lastSubmissionId: sent.submissionId,
      lastStatus: "running",
      runCount: record.runCount + 1,
    });
    void watchRun(record.id, threadId, sent.submissionId, startedAt);
    return { accepted: true, threadId: String(threadId), submissionId: sent.submissionId };
  } catch (error) {
    let nextRunAt: number | undefined;
    try {
      nextRunAt = nextRuns(record.cron, Date.now(), 1)[0];
    } catch {
      nextRunAt = undefined;
    }
    await patchRecord(record.id, {
      lastStatus: "failed",
      lastError: messageOf(error),
      lastRunAt: startedAt,
      lastScheduledFor: dueAt,
      ...(nextRunAt === undefined ? { enabled: false, nextRunAt: undefined } : { nextRunAt }),
    });
    return { accepted: false, reason: messageOf(error) };
  } finally {
    running.delete(record.id);
  }
}

/** One scheduler tick: due, enabled schedules run one at a time. Returns the ids that were attempted. */
export async function tickSchedules(now = Date.now()): Promise<string[]> {
  if (ticking) return [];
  ticking = true;
  const attempted: string[] = [];
  try {
    const state = await readState();
    for (const record of state.schedules) {
      if (!record.enabled || record.nextRunAt === undefined || record.nextRunAt > now) continue;
      attempted.push(record.id);
      await executeSchedule(record, record.nextRunAt);
    }
  } finally {
    ticking = false;
  }
  return attempted;
}

export async function runScheduleNow(id: string): Promise<{ accepted: boolean; threadId?: string; submissionId?: string; reason?: string }> {
  const record = await findSchedule(id);
  if (!record) throw new ScheduleError(404, "schedule_not_found", "Schedule not found.");
  if (running.has(id)) throw new ScheduleError(409, "schedule_busy", "This schedule is already running.");
  return executeSchedule(record, Date.now());
}

/** Recompute the next run on boot; missed windows are counted, never replayed in a burst. */
export async function reconcileSchedules(): Promise<void> {
  await serialize(async () => {
    const state = await readState();
    let changed = false;
    const now = Date.now();
    for (const record of state.schedules) {
      if (record.lastStatus === "running") {
        const submissionId = record.lastSubmissionId ? Number(record.lastSubmissionId) : Number.NaN;
        const submission = Number.isSafeInteger(submissionId)
          ? await harnessInstance().submission(submissionId as SubmissionId, BACKGROUND_CONTEXT)
          : undefined;
        if (submission) {
          void watchRun(record.id, record.threadId ?? 0, record.lastSubmissionId!, record.lastRunAt ?? now);
          continue;
        }
        record.lastStatus = "interrupted";
        record.lastError = "the server restarted while this run was working";
        changed = true;
      }
      if (!record.enabled) {
        if (record.nextRunAt !== undefined) {
          delete record.nextRunAt;
          changed = true;
        }
        continue;
      }
      try {
        const next = nextRuns(record.cron, now, 1)[0];
        if (next === undefined) continue;
        if (record.nextRunAt !== undefined && record.nextRunAt < now) {
          record.missedRuns = (record.missedRuns ?? 0) + 1;
          changed = true;
        }
        if (record.nextRunAt !== next) {
          record.nextRunAt = next;
          changed = true;
        }
      } catch (error) {
        record.enabled = false;
        record.lastError = "cron no longer parses: " + messageOf(error);
        delete record.nextRunAt;
        changed = true;
      }
    }
    if (changed) await writeState(state);
  });
  emit();
}

let timer: NodeJS.Timeout | undefined;

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tickSchedules().catch((error) => console.warn("schedule tick failed: " + messageOf(error)));
  }, 15_000);
  timer.unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Test-only helpers used by the PI_E2E routes; they still go through the same execution path. */
export async function forceScheduleDue(id: string): Promise<boolean> {
  const record = await findSchedule(id);
  if (!record) return false;
  await patchRecord(id, { nextRunAt: Date.now() - 1 });
  return true;
}

export function previewSchedule(cron: string, count = 5): { timezone: string; times: number[] } {
  try {
    return { timezone: timezone(), times: nextRuns(cron, Date.now(), count) };
  } catch (error) {
    if (error instanceof CronError) throw new ScheduleError(400, "invalid_cron", error.message);
    throw error;
  }
}

export { timezone as scheduleTimezone };

/** Every live or recently finished schedule, for the fleet summary. */
export async function scheduleSummary(): Promise<{ id: string; agentId: string; name: string; cron: string; enabled: boolean; nextRunAt?: number; lastStatus?: ScheduleStatus }[]> {
  return (await listSchedules()).map((record) => ({
    id: record.id,
    agentId: record.agentId,
    name: record.name,
    cron: record.cron,
    enabled: record.enabled,
    ...(record.nextRunAt === undefined ? {} : { nextRunAt: record.nextRunAt }),
    ...(record.lastStatus === undefined ? {} : { lastStatus: record.lastStatus }),
  }));
}