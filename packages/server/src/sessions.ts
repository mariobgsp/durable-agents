import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentChange, Conversation, ConversationId } from "@earendil-works/pi-durable";
import { readAgent, renderInstructions } from "./agents.ts";
import { WATCHDOG_MS, markActive, markIdle, markIdleIfCurrent } from "./activity.ts";
import { context, harnessInstance, toolsByName } from "./harness.ts";
import { resolveDefaultModel, type ModelRef } from "./models.ts";
import { sessionsPath } from "./paths.ts";
import { entriesToMsgs } from "./transcript.ts";
import type { WireMsg } from "./wire.ts";
import type { RoomConfig } from "./rooms.ts";

/** One row in data/sessions.json. `id` is a ConversationId at runtime (a branded number). */
export type SessionRecord = {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Model used by this session; absent on older records. */
  model?: ModelRef;
  /** Agent id used by this session; empty means a plain session. */
  agent?: string;
  kind?: "plain" | "agent" | "group";
  /** Group configuration; present only when kind === "group". */
  room?: RoomConfig;
  /** Soft delete: set when the thread is hidden. The durable rows stay in SQLite until a purge. */
  deletedAt?: number;
};

/** Shape sent to the UI: id is always a string so it is safe in URLs and keys. */
export type WireSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: ModelRef;
  agent?: string;
  kind?: "plain" | "agent" | "group";
  room?: RoomConfig;
  deletedAt?: number;
};

const NEW_TITLE = "New thread";

/**
 * SAFETY: ConversationId is a branded number that we store as-is in
 * data/sessions.json; values from the URL are validated with Number.isSafeInteger.
 */
function asConversationId(value: number): ConversationId {
  return value as ConversationId;
}

/** The only place a string from a URL or query becomes a ConversationId. */
export function conversationIdFromParam(raw: string | null | undefined): ConversationId | null {
  if (raw === null || raw === undefined) return null;
  const numeric = Number(raw);
  return Number.isSafeInteger(numeric) ? asConversationId(numeric) : null;
}

/** Serialise index writes so two parallel requests cannot overwrite each other. */
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

async function readIndex(): Promise<SessionRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(sessionsPath, "utf8")) as { sessions?: SessionRecord[] };
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

async function writeIndex(sessions: readonly SessionRecord[]): Promise<void> {
  await mkdir(dirname(sessionsPath), { recursive: true });
  const tmp = sessionsPath + ".tmp";
  await writeFile(tmp, JSON.stringify({ sessions }, null, 2));
  await rename(tmp, sessionsPath);
}

function toWireSession(record: SessionRecord): WireSession {
  return {
    id: String(record.id),
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.model ? { model: record.model } : {}),
    ...(record.agent ? { agent: record.agent } : {}),
    ...(record.kind ? { kind: record.kind } : {}),
    ...(record.room ? { room: record.room } : {}),
    ...(record.deletedAt ? { deletedAt: record.deletedAt } : {}),
  };
}

export async function listSessions(includeDeleted = false): Promise<WireSession[]> {
  const sessions = await readIndex();
  // One-time migration: older records do not store a model.
  const missing = sessions.some((session) => !session.model);
  if (missing) {
    const model = await resolveDefaultModel();
    for (const session of sessions) session.model ??= model;
    await serialize(() => writeIndex(sessions));
  }
  return sessions
    .filter((session) => includeDeleted || session.deletedAt === undefined)
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
    .map(toWireSession);
}

/** Rename one thread. An empty title is rejected so the list never shows a blank row. */
export async function renameSession(id: string, title: string): Promise<WireSession | null> {
  const next = title.trim();
  if (next.length === 0) return null;
  const updated = await updateSessionRecord(Number(id), { title: next.slice(0, 120) });
  return updated ? toWireSession(updated) : null;
}

/** Soft delete: the thread leaves the list while its transcript stays recoverable in SQLite. */
export async function deleteSession(id: string): Promise<boolean> {
  const updated = await updateSessionRecord(Number(id), { deletedAt: Date.now() });
  return updated !== null;
}

/** Undo a soft delete. */
export async function restoreSession(id: string): Promise<boolean> {
  const updated = await updateSessionRecord(Number(id), { deletedAt: undefined });
  return updated !== null;
}

/** Point one thread at another agent: reconfigure the conversation, then update the record. */
export async function moveSession(id: string, agentId: string): Promise<WireSession | null> {
  const files = await readAgent(agentId);
  if (!files) return null;
  const conversation = await conversationOf(id);
  if (!conversation) return null;
  await conversation.configure(agentChangeOf(files), context);
  const updated = await updateSessionRecord(Number(id), {
    agent: files.record.id,
    model: { provider: files.record.provider, modelId: files.record.modelId },
    updatedAt: Date.now(),
  });
  return updated ? toWireSession(updated) : null;
}

/**
 * Start a fresh context for one thread while keeping its transcript. The handoff note carries the gist
 * into the new context, so the agent does not lose the thread of the conversation.
 */
export async function restartSession(id: string, handoff?: string): Promise<boolean> {
  const conversation = await conversationOf(id);
  if (!conversation) return false;
  let note = handoff?.trim() ?? "";
  if (note.length === 0) {
    const entries = await transcript(id);
    note = entries
      .slice(-6)
      .map((entry) => entry.role + ": " + entry.text.slice(0, 200))
      .join("\n");
  }
  await conversation.reset(note.length > 0 ? "Earlier in this thread:\n" + note : undefined, context);
  return true;
}

export async function findSession(id: string): Promise<SessionRecord | undefined> {
  const numeric = Number(id);
  return (await readIndex()).find((session) => session.id === numeric);
}

/**
 * Update one session record. When the id is unknown a new record is appended (used by createRoom,
 * which has already created the conversation).
 */
export async function updateSessionRecord(
  id: number,
  patch: Partial<SessionRecord>,
): Promise<SessionRecord | null> {
  return serialize(async () => {
    const sessions = await readIndex();
    const index = sessions.findIndex((session) => session.id === id);
    if (index === -1) {
      if (patch.id === undefined || patch.title === undefined) return null;
      const created = patch as SessionRecord;
      sessions.push(created);
      await writeIndex(sessions);
      return created;
    }
    const merged = { ...sessions[index], ...patch } as SessionRecord;
    sessions[index] = merged;
    await writeIndex(sessions);
    return merged;
  });
}

export { readIndex as allSessionRecords, serialize as withIndexLock, toWireSession };

/** Agent change for one conversation: model, thinking, instructions, tools, cwd. */
export function agentChangeOf(files: Awaited<ReturnType<typeof readAgent>>): AgentChange {
  if (!files) return {};
  return {
    model: { provider: files.record.provider, modelId: files.record.modelId },
    thinkingLevel: files.record.thinkingLevel,
    instructions: renderInstructions(files),
    tools: toolsByName(files.record.tools),
    cwd: files.record.cwd ?? null,
  };
}

export async function createSession(title?: string, agentId?: string): Promise<WireSession> {
  const model = await resolveDefaultModel();
  const agentFiles = agentId ? await readAgent(agentId) : null;
  const agentChange: AgentChange = agentFiles ? agentChangeOf(agentFiles) : { model };
  return serialize(async () => {
    const conversation = await harnessInstance().createConversation(
      { ownership: { kind: "ownerless" }, agent: agentChange },
      context,
    );
    const now = Date.now();
    const record: SessionRecord = {
      id: conversation.id,
      title: title?.trim() || NEW_TITLE,
      createdAt: now,
      updatedAt: now,
      model: agentFiles
        ? { provider: agentFiles.record.provider, modelId: agentFiles.record.modelId }
        : model,
      agent: agentFiles?.record.id,
    };
    const sessions = await readIndex();
    sessions.push(record);
    await writeIndex(sessions);
    return toWireSession(record);
  });
}

export async function conversationOf(id: string): Promise<Conversation | undefined> {
  const conversationId = conversationIdFromParam(id);
  if (conversationId === null) return undefined;
  return harnessInstance().conversation(conversationId, context);
}

/** Transcript for REST: read from the conversation's durable view state, not a UI cache. */
export async function transcript(id: string): Promise<WireMsg[]> {
  const conversation = await conversationOf(id);
  if (!conversation) return [];
  const view = await conversation.viewState(context);
  return entriesToMsgs(view.value.entries);
}

/**
 * Mark a session as generating, then clear the mark when its conversation actually goes idle.
 *
 * `waitForIdle` is the durable harness's own signal, so there is no polling and no transcript scanning.
 */
export async function trackActivity(id: string): Promise<void> {
  const epoch = markActive(id);
  await settle(id, epoch);
}

/**
 * Boot-time recovery: `resume()` may have rescheduled work that began before this process did, which
 * nobody marked. Marks active only when the conversation is still busy after a short grace window, so an
 * idle session is never reported as generating.
 */
export async function trackIfBusy(id: string, graceMs = 300): Promise<void> {
  const conversation = await conversationOf(id);
  if (!conversation) return;
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  const probe = conversation.waitForIdle(context).then(mark, mark);
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (settled) return;
  const epoch = markActive(id);
  await probe;
  markIdleIfCurrent(id, epoch);
}

/** Wait for one conversation to go idle, under a watchdog, and clear its mark. */
async function settle(id: string, epoch: number): Promise<void> {
  const conversation = await conversationOf(id);
  if (!conversation) {
    markIdleIfCurrent(id, epoch);
    return;
  }
  const watchdog = setTimeout(() => markIdleIfCurrent(id, epoch), WATCHDOG_MS);
  try {
    await conversation.waitForIdle(context);
  } catch {
    // A failed wait must still clear the mark; otherwise the row would spin forever.
  } finally {
    clearTimeout(watchdog);
    markIdleIfCurrent(id, epoch);
  }
}

export async function sendMessage(id: string, text: string): Promise<{ submissionId: string } | null> {
  const conversation = await conversationOf(id);
  if (!conversation) return null;
  // The submission is durable by the time this call returns; the answer arrives over the WebSocket.
  const submission = await conversation.submit({ type: "input", content: text }, context);
  // Track only after the submission is placed: a waiter started earlier could observe the conversation
  // as already idle and clear the mark before any work began.
  void trackActivity(id);
  const numeric = Number(id);
  await serialize(async () => {
    const sessions = await readIndex();
    const record = sessions.find((session) => session.id === numeric);
    if (!record) return;
    if (!record.title || record.title === NEW_TITLE) record.title = text.slice(0, 48);
    record.updatedAt = Date.now();
    await writeIndex(sessions);
  });
  return { submissionId: String(submission.id) };
}

export async function abortSession(id: string): Promise<boolean> {
  const conversation = await conversationOf(id);
  if (!conversation) return false;
  await conversation.abort(context);
  // Clear immediately rather than waiting for the waiter to observe idle: abort should feel instant.
  markIdle(id);
  return true;
}

/**
 * Re-apply an agent's files to every session that uses it.
 * Called after an agent is edited, so SOUL.md/AGENT.md changes take effect
 * in existing sessions too, not only new ones.
 */
export async function rebindAgent(agentId: string): Promise<number> {
  const files = await readAgent(agentId);
  if (!files) return 0;
  const change = agentChangeOf(files);
  let updated = 0;
  for (const record of await readIndex()) {
    if (record.agent !== agentId) continue;
    const conversation = await conversationOf(String(record.id));
    if (!conversation) continue;
    await conversation.configure(change, context);
    updated += 1;
  }
  return updated;
}
