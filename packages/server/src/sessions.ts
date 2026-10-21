import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentChange, Conversation, ConversationId, EntryId, ToolRegistration } from "@earendil-works/pi-durable";
import { readAgent, renderInstructions, writeAgent } from "./agents.ts";
import {
  USER_ENTRY_KIND,
  prepareUserMessage,
  type UserMessageBody,
  type UserMessageOptions,
} from "./attachments.ts";
import { imagePolicy, type ImagePolicy } from "./capabilities.ts";
import { rememberTool } from "./remember.ts";
import { WATCHDOG_MS, markActive, markIdle, markIdleIfCurrent } from "./activity.ts";
import { context, harnessInstance, toolsByName } from "./harness.ts";
import { meshToolsFor } from "./mesh-tools.ts";
import { fileTools } from "./file-tools.ts";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER, models, resolveDefaultModel, type ModelRef } from "./models.ts";
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
  /**
   * Full Access granted to this thread alone.
   *
   * Per-thread and non-sticky on purpose: full access is a decision about a task, not about a persona, so it
   * lives on the thread that was granted it rather than on the agent, and a new thread starts at the agent's
   * own tier. The transcript is then the record of when it was allowed.
   */
  grant?: "full";
  /** Soft delete: set when the thread is hidden. The durable rows stay in SQLite until a purge. */
  deletedAt?: number;
  /**
   * Why this thread exists beyond a normal conversation. Purpose threads are created by the agent network or
   * the scheduler; they stay under their agent's section but are refused by Move so their metadata cannot lie.
   */
  purpose?: "inbox" | "delegate" | "schedule";
  /** Stable lookup key for a purpose thread: inbox:<recipient>:<sender> or delegate:<task>:<target>. */
  meshKey?: string;
  /** The schedule that owns this thread. */
  scheduleId?: string;
  /** The other agent in a directed inbox/delegation thread. */
  peer?: string;
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
  grant?: "full";
  deletedAt?: number;
  purpose?: "inbox" | "delegate" | "schedule";
  meshKey?: string;
  scheduleId?: string;
  peer?: string;
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

/** The same guard for an entry id, used by the attachment route. */
export function entryIdFromParam(raw: string | null | undefined): EntryId | null {
  if (raw === null || raw === undefined) return null;
  const numeric = Number(raw);
  return Number.isSafeInteger(numeric) ? (numeric as EntryId) : null;
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
    ...(record.grant ? { grant: record.grant } : {}),
    ...(record.deletedAt ? { deletedAt: record.deletedAt } : {}),
    ...(record.purpose ? { purpose: record.purpose } : {}),
    ...(record.meshKey ? { meshKey: record.meshKey } : {}),
    ...(record.scheduleId ? { scheduleId: record.scheduleId } : {}),
    ...(record.peer ? { peer: record.peer } : {}),
  };
}

/** The extra fields a purpose thread carries when it is created. */
export type SessionOrigin = {
  purpose: "inbox" | "delegate" | "schedule";
  meshKey?: string;
  scheduleId?: string;
  peer?: string;
};

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

/**
 * Grant or revoke Full Access for one thread.
 *
 * Nothing here touches the agent's own tier, which is what makes the grant non-sticky: the next thread the
 * agent starts is back at Standard (or Custom), and this thread carries the decision until it is revoked.
 */
export async function setSessionGrant(id: string, grant: "full" | null): Promise<WireSession | null> {
  const updated = await updateSessionRecord(Number(id), { grant: grant ?? undefined });
  return updated ? toWireSession(updated) : null;
}

/**
 * Remove a thread's record for good.
 *
 * A purge is not a soft delete: the rows are already gone, so hiding the record would offer a Restore that
 * cannot work and would leave a thread answering 200 with an empty transcript.
 */
export async function removeSessionRecord(id: string): Promise<boolean> {
  return serialize(async () => {
    const sessions = await readIndex();
    const remaining = sessions.filter((session) => session.id !== Number(id));
    if (remaining.length === sessions.length) return false;
    await writeIndex(remaining);
    return true;
  });
}

/** Point one thread at another agent: reconfigure the conversation, then update the record. */
export async function moveSession(id: string, agentId: string): Promise<WireSession | null> {
  const existing = await findSession(id);
  // A purpose thread's agent is part of its identity (an inbox is the recipient's; a schedule belongs to its
  // owner). Moving it would leave the mesh/schedule metadata pointing at a thread that no longer runs that agent.
  if (!existing || existing.purpose) return null;
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

/**
 * Which agent owns a conversation: a direct thread's own agent, or one member's conversation inside a group.
 * The `remember` tool needs this because it is shared by every conversation.
 */
export async function agentForConversation(conversationId: string): Promise<string | undefined> {
  for (const record of await readIndex()) {
    if (record.deletedAt) continue;
    if (record.agent && String(record.id) === conversationId) return record.agent;
    for (const [agentId, id] of Object.entries(record.room?.conversations ?? {})) {
      if (String(id) === conversationId) return agentId;
    }
  }
  return undefined;
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
  // Mesh tools follow the agent's own mesh policy. A name is enabled once, even if an old tool list and the
  // policy both mention it; the registry replaces a same-name tool, but the offered list should not repeat.
  const meshTools = meshToolsFor(files.record.mesh);
  const meshNames = new Set(meshTools.map((tool) => tool.name));
  const byName = new Map<string, ToolRegistration>();
  // The policy is authoritative even for an older agent.json whose tool list mentions agents_*: an agent
  // switched to "message" must not keep a delegate tool merely because its list still names it.
  const selected = toolsByName(files.record.tools).filter(
    (tool) => !tool.name.startsWith("agents_") || meshNames.has(tool.name),
  );
  for (const tool of [...selected, rememberTool, ...meshTools, ...fileTools]) {
    byName.set(tool.name, tool);
  }
  return {
    model: { provider: files.record.provider, modelId: files.record.modelId },
    thinkingLevel: files.record.thinkingLevel,
    instructions: renderInstructions(files),
    // `remember` is always offered: keeping memory is part of being an agent, not a tool the owner has to
    // switch on first. Mesh tools follow the agent's policy; everything else comes from its own list.
    tools: [...byName.values()],
    cwd: files.record.cwd ?? null,
  };
}

export async function createSession(
  title?: string,
  agentId?: string,
  origin?: SessionOrigin,
): Promise<WireSession> {
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
      ...(origin ? origin : {}),
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

/** What the composer shows under the box: this thread's context against the model's window. */
export type ContextInfo = {
  /** Tokens the next request would carry: the last answer's prompt plus what it committed. */
  usedTokens: number;
  maxTokens?: number;
  provider: string;
  modelId: string;
  /** Where the model comes from, so the UI can say what the picker actually edits. */
  source: "session" | "agent";
};

/**
 * Read the context size from the last assistant entry's usage rather than summing the transcript: usage is what
 * the provider actually charged for the prompt, which is the number the window is measured against.
 */
export async function contextInfo(id: string): Promise<ContextInfo | null> {
  const record = await findSession(id);
  if (!record) return null;
  const conversation = await conversationOf(id);
  if (!conversation) return null;

  const view = await conversation.viewState(context);
  let usedTokens = 0;
  for (const entry of [...view.value.entries].reverse()) {
    if (entry.kind !== "pi.assistant") continue;
    const message = Array.isArray(entry.model) ? (entry.model[0] as { usage?: { totalTokens?: unknown } }) : undefined;
    const total = message?.usage?.totalTokens;
    if (typeof total === "number") {
      usedTokens = total;
      break;
    }
  }

  const ref = await modelRefOf(record);
  const model = models.getModel(ref.provider, ref.modelId);
  return {
    usedTokens,
    ...(typeof model?.contextWindow === "number" ? { maxTokens: model.contextWindow } : {}),
    provider: ref.provider,
    modelId: ref.modelId,
    source: record.agent ? "agent" : "session",
  };
}

/**
 * Point a thread at another model.
 *
 * An agent thread follows its agent, so changing it there would silently diverge from AGENT.md's model; the
 * agent's own record is updated and every thread of that agent is reconfigured instead. A plain thread has no
 * agent, so its own record carries the model.
 */
export async function setSessionModel(
  id: string,
  ref: { provider: string; modelId: string },
): Promise<{ changed: "session" | "agent" } | null> {
  const record = await findSession(id);
  if (!record) return null;

  if (record.agent) {
    const files = await readAgent(record.agent);
    if (!files) return null;
    await writeAgent({ ...files.record, id: files.record.id, provider: ref.provider, modelId: ref.modelId });
    await rebindAgent(files.record.id);
    return { changed: "agent" };
  }

  const conversation = await conversationOf(id);
  if (!conversation) return null;
  await conversation.configure({ model: ref }, context);
  await updateSessionRecord(Number(id), { model: ref, updatedAt: Date.now() });
  return { changed: "session" };
}

/**
 * Ask the harness to rewrite this thread's context now instead of waiting for the automatic threshold.
 *
 * The task runs in the background: the transcript shows a pill when it lands, and the conversation keeps working
 * meanwhile. The context caption only drops after the next answer, because it reads the last request's usage.
 */
export async function compactSession(id: string): Promise<boolean> {
  const conversation = await conversationOf(id);
  if (!conversation) return false;
  await conversation.compact(undefined, context);
  return true;
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

/**
 * Which model this thread answers with.
 *
 * One resolver, because the answer has two readers that must not disagree: the context caption and the
 * attachment pre-flight. An agent thread follows its agent's record; a plain thread carries its own.
 */
async function modelRefOf(record: SessionRecord): Promise<ModelRef> {
  const agent = record.agent ? await readAgent(record.agent) : null;
  return agent
    ? { provider: agent.record.provider, modelId: agent.record.modelId }
    : (record.model ?? { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL_ID });
}

/**
 * Whether this thread may send images, and the limits to normalize them to.
 *
 * Reads the agent's own `vision: "off"` switch, which is what finally enforces it, and the model's own
 * `input` list, because pi-ai would otherwise swallow an image into a placeholder string.
 */
export async function attachmentPolicy(record: SessionRecord): Promise<ImagePolicy> {
  const ref = await modelRefOf(record);
  const visionOff = record.agent ? (await readAgent(record.agent))?.record.vision === "off" : false;
  return imagePolicy(ref, visionOff);
}

/**
 * Place one user message.
 *
 * `whenBusy` is pi-durable's own routing for a message that arrives mid-run: `steer` folds it into the turn
 * that is generating, `followUp` queues it for after that turn, `reject` fails the submission. The default is
 * follow-up, so an ordinary send can never be swallowed by a run that happens to be in flight.
 *
 * The body is validated and converted first, so a refused message leaves no entry, no file and no spent
 * model call. `requestId` travels with the submission as well as inside the entry: pi-durable returns the
 * existing submission for a known id, which is what makes a double-click or a retry harmless.
 */
export async function sendMessage(
  id: string,
  body: UserMessageBody,
  whenBusy: "steer" | "followUp" | "reject" = "followUp",
  options?: UserMessageOptions,
): Promise<{ submissionId: string } | null> {
  const record = await findSession(id);
  if (!record) return null;
  const conversation = await conversationOf(id);
  if (!conversation) return null;

  const { data, content } = await prepareUserMessage(body, await attachmentPolicy(record), options);
  // The submission is durable by the time this call returns; the answer arrives over the WebSocket.
  const submission = await conversation.submit(
    {
      type: "input",
      requestId: data.requestId,
      content,
      entry: { kind: USER_ENTRY_KIND, data },
      whenBusy,
    },
    context,
  );
  // Track only after the submission is placed: a waiter started earlier could observe the conversation
  // as already idle and clear the mark before any work began.
  void trackActivity(id);
  const numeric = Number(id);
  await serialize(async () => {
    const sessions = await readIndex();
    const index = sessions.findIndex((session) => session.id === numeric);
    if (index === -1) return;
    const current = sessions[index];
    if (!current) return;
    // An attachment-only message has no text to name the thread after, so its first file names it.
    if (!current.title || current.title === NEW_TITLE) {
      const source = data.text.length > 0 ? data.text : (data.files[0]?.name ?? "");
      if (source.length > 0) current.title = source.slice(0, 48);
    }
    current.updatedAt = Date.now();
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
    // Keep the record's model in step with the agent, or the model chip on every thread of this agent lies
    // after the owner picks another model in the editor.
    await updateSessionRecord(record.id, {
      model: { provider: files.record.provider, modelId: files.record.modelId },
    });
    updated += 1;
  }
  return updated;
}