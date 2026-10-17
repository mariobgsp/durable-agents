/// <reference types="svelte" />
import { api } from "./api.ts";
import type { AgentRecord, Msg, Session } from "./types.ts";
import { connect, connectPresence, type Frame } from "./ws.ts";

export const store = $state({
  sessions: [] as Session[],
  agents: [] as AgentRecord[],
  currentId: null as string | null,
  entries: [] as Msg[],
  /** Messages already sent whose durable entry has not arrived yet (local echo). */
  pending: [] as { text: string; at: number }[],
  streamingText: "",
  /** Members currently answering in a group. */
  typing: [] as string[],
  live: false,
  busy: false,
  /** Session ids the server reports as generating, for every thread and not just the open one. */
  active: [] as string[],
  connection: "idle" as "idle" | "open" | "closed",
  error: null as string | null,
});

let disconnect: (() => void) | null = null;
let openToken = 0;

/** Streaming text is buffered and written to $state once per frame: that is what keeps the UI smooth. */
let buffer = "";
let scheduled = false;

function scheduleFlush(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    store.streamingText = buffer;
  });
}

function resetStream(): void {
  buffer = "";
  store.streamingText = "";
  store.live = false;
}

/** Drop local echoes that have arrived as real entries. */
function reconcilePending(): void {
  if (store.pending.length === 0) return;
  const texts = new Set<string>();
  for (const entry of store.entries) {
    if (entry.role === "user") texts.add(entry.text.trim());
  }
  const remaining: { text: string; at: number }[] = [];
  for (const item of store.pending) {
    if (!texts.has(item.text.trim())) remaining.push(item);
  }
  if (remaining.length !== store.pending.length) store.pending = remaining;
}

function setEntries(entries: Msg[]): void {
  store.entries = entries;
  reconcilePending();
}

function upsertEntry(entry: Msg): void {
  if (store.entries.some((existing) => existing.id === entry.id)) return;
  store.entries = [...store.entries, entry];
  reconcilePending();
}

function onFrame(frame: Frame): void {
  switch (frame.type) {
    case "snapshot":
    case "refresh":
      setEntries(frame.entries);
      if (!store.live) resetStream();
      break;
    case "entry":
      upsertEntry(frame.entry);
      break;
    case "message-start":
      buffer = "";
      store.live = true;
      store.busy = true;
      store.streamingText = "";
      break;
    case "delta":
      buffer += frame.text;
      scheduleFlush();
      break;
    case "message-end":
      buffer = "";
      store.streamingText = "";
      store.live = false;
      store.busy = false;
      void refreshEntries();
      break;
    case "log":
      store.connection = frame.text.includes("connection lost") ? "closed" : "open";
      break;
    case "error":
      store.error = frame.message;
      store.busy = false;
      resetStream();
      break;
    case "typing":
      store.typing =
        frame.state === "start"
          ? store.typing.includes(frame.author)
            ? store.typing
            : [...store.typing, frame.author]
          : store.typing.filter((name) => name !== frame.author);
      break;
    case "presence":
      store.active = frame.active;
      break;
    case "tool":
    default:
      break;
  }
}

function report(error: unknown): void {
  store.error = error instanceof Error ? error.message : String(error);
}

async function refreshEntries(): Promise<void> {
  const id = store.currentId;
  if (!id) return;
  try {
    const { entries } = await api.messages(id);
    if (store.currentId !== id) return;
    setEntries(entries);
  } catch (err) {
    report(err);
  }
}

/**
 * True when this session is generating.
 *
 * Presence is the source of truth rather than local state, which also covers returning to a thread
 * before its first token arrives: there `store.busy` is false and `store.live` is still false.
 * The sidebar excludes the open thread, because the chat shows the indicator for that one.
 */
export function isReplying(id: string | null | undefined): boolean {
  return id !== null && id !== undefined && store.active.includes(id);
}

let disconnectPresence: (() => void) | null = null;

/** Open the presence channel once per tab; safe to call repeatedly. */
export function watchActivity(): void {
  if (disconnectPresence) return;
  disconnectPresence = connectPresence(onFrame);
}

export function unwatchActivity(): void {
  disconnectPresence?.();
  disconnectPresence = null;
  store.active = [];
}

export async function loadSessions(includeDeleted = false): Promise<void> {
  try {
    const { sessions } = await api.sessions(includeDeleted);
    store.sessions = sessions;
  } catch (err) {
    report(err);
  }
}

export async function loadAgents(): Promise<void> {
  try {
    const { agents } = await api.agents();
    store.agents = agents;
  } catch (err) {
    report(err);
  }
}

export async function openSession(id: string): Promise<void> {
  if (store.currentId === id) return;
  closeSession();
  const token = ++openToken;
  store.currentId = id;
  store.entries = [];
  store.pending = [];
  store.typing = [];
  // Scoped to the thread we are actually looking at: switching away clears the local spinner, and
  // presence takes over for whatever is genuinely still generating.
  store.busy = false;
  resetStream();
  try {
    const { entries } = await api.messages(id);
    if (token !== openToken) return;
    setEntries(entries);
  } catch (err) {
    report(err);
  }
  if (token !== openToken) return;
  store.connection = "open";
  disconnect = connect(id, onFrame);
}

export function closeSession(): void {
  disconnect?.();
  disconnect = null;
  openToken += 1;
  store.currentId = null;
  store.busy = false;
  store.connection = "idle";
}

export async function createSession(title?: string, agentId?: string): Promise<Session | null> {
  try {
    const session = await api.createSession(title, agentId);
    await loadSessions();
    return session;
  } catch (err) {
    report(err);
    return null;
  }
}

/** Start a thread that belongs to one agent section. */
export async function createThreadForAgent(agentId: string): Promise<Session | null> {
  const agent = store.agents.find((entry) => entry.id === agentId);
  return createSession("Thread · " + (agent?.name ?? agentId), agentId);
}

export async function renameThread(id: string, title: string): Promise<boolean> {
  try {
    await api.renameSession(id, title);
    await loadSessions();
    return true;
  } catch (err) {
    report(err);
    return false;
  }
}

export async function deleteThread(id: string): Promise<void> {
  try {
    await api.deleteSession(id);
    if (store.currentId === id) closeSession();
    await loadSessions();
  } catch (err) {
    report(err);
  }
}

export async function restoreThread(id: string): Promise<void> {
  try {
    await api.restoreSession(id);
    await loadSessions();
  } catch (err) {
    report(err);
  }
}

export async function moveThread(id: string, agentId: string): Promise<void> {
  try {
    await api.moveSession(id, agentId);
    await loadSessions();
  } catch (err) {
    report(err);
  }
}

/** Fresh context for one thread, keeping its transcript. */
export async function restartThread(id: string): Promise<void> {
  try {
    await api.restartSession(id);
    await refreshEntries();
  } catch (err) {
    report(err);
  }
}

export async function setAgentEnabled(id: string, enabled: boolean): Promise<void> {
  try {
    await api.setAgentEnabled(id, enabled);
    await loadAgents();
  } catch (err) {
    report(err);
  }
}

export async function updateRoomMode(id: string, mode: "nyahut" | "moderator" | "silent"): Promise<void> {
  try {
    await api.updateRoom(id, { mode });
  } catch (err) {
    report(err);
  }
}

export async function send(text: string): Promise<void> {
  const id = store.currentId;
  const value = text.trim();
  if (!id || !value) return;
  store.error = null;
  store.busy = true;
  store.pending = [...store.pending, { text: value, at: Date.now() }];
  store.sessions = store.sessions.map((session) =>
    session.id === id ? { ...session, updatedAt: Date.now() } : session,
  );
  try {
    await api.send(id, value);
  } catch (err) {
    report(err);
    store.busy = false;
    store.pending = store.pending.filter((item) => item.text !== value);
  }
}

export async function abort(): Promise<void> {
  const id = store.currentId;
  if (!id) return;
  try {
    await api.abort(id);
  } catch (err) {
    report(err);
  }
}

