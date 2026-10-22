/// <reference types="svelte" />
import { api } from "./api.ts";
import { releaseDrafts } from "./lib/files.ts";
import { IDLE_ACTIVITY, type Activity, type AgentRecord, type ContextInfo, type DisplaySnapshot, type DraftFile, type FleetSnapshot, type Msg, type Session, type SystemSnapshot } from "./types.ts";
import { DEFAULT_DISPLAY, applyDisplay } from "./lib/display.ts";
import { connect, connectPresence, type Frame } from "./ws.ts";
import { loadNotifyPrefs, playChime, showDesktopNotification } from "./lib/notify.ts";

export const store = $state({
  sessions: [] as Session[],
  agents: [] as AgentRecord[],
  currentId: null as string | null,
  entries: [] as Msg[],
  /**
   * Messages already sent whose durable entry has not arrived yet (local echo).
   *
   * Matched by `requestId`, never by text: a message can carry only files and no text at all, so there is
   * nothing to compare.
   */
  pending: [] as { requestId: string; text: string; files: DraftFile[]; at: number }[],
  streamingText: "",
  /** Members currently answering in a group. */
  typing: [] as string[],
  live: false,
  busy: false,
  /** Session ids the server reports as generating, for every thread and not just the open one. */
  active: [] as string[],
  /** The live roster and recent A2A links, sent with presence. */
  fleet: null as FleetSnapshot | null,
  /** The global display, fetched at boot and updated live by the display frame. */
  display: null as DisplaySnapshot | null,
  /** One small completion notice; a batch of finishes is coalesced into a count. */
  completionToast: null as { sessionId: string; title: string; count: number; at: number } | null,
  /**
   * The round's status. One whole-list snapshot from the server, so there is nothing to diff and a missed
   * start/stop pair cannot leave a row spinning.
   */
  activity: IDLE_ACTIVITY as Activity,
  /** Ticked only while a phase is live: every elapsed label reads this one number. */
  now: Date.now(),
  /** Context used against the model's window, for the caption under the composer. */
  context: null as ContextInfo | null,
  /** Models of the connected providers, grouped for the composer's picker. Loaded once per tab. */
  modelGroups: [] as { provider: string; models: { id: string; name: string }[] }[],
  connection: "idle" as "idle" | "open" | "closed",
  error: null as string | null,
  /** The app's own facts and last operation, from `GET /api/system`. */
  system: null as SystemSnapshot | null,
  systemOperationError: null as string | null,
  /** The client's view of a restart, which spans two processes and cannot be read from one snapshot. */
  restart: null as RestartTracker | null,
});

export type RestartTracker =
  | { state: "waiting"; previousPid: number; since: number }
  | { state: "stopping"; since: number }
  | { state: "returned"; downtimeMs: number | null }
  | { state: "missed"; since: number };

let disconnect: (() => void) | null = null;
let openToken = 0;
/** The activity list of the previous presence frame; null until the first frame has been seen. */
let presenceBaseline: Set<string> | null = null;

/**
 * One interval for every elapsed label, running only while something is running.
 *
 * A status that is not moving needs no clock: an idle frame stays completely still, which is what keeps this
 * app cheap on an OLED panel.
 */
let clock: number | undefined;
function watchClock(): void {
  const running = store.activity.phase !== null;
  if (running && clock === undefined) {
    clock = window.setInterval(() => {
      store.now = Date.now();
    }, 500);
  } else if (!running && clock !== undefined) {
    window.clearInterval(clock);
    clock = undefined;
  }
}

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

/** Drop local echoes whose own entries have arrived, and release the previews of the ones that landed. */
function reconcilePending(): void {
  if (store.pending.length === 0) return;
  const arrived = new Set<string>();
  for (const entry of store.entries) {
    if (entry.role === "user" && entry.requestId) arrived.add(entry.requestId);
  }
  if (arrived.size === 0) return;
  const landed = store.pending.filter((item) => arrived.has(item.requestId));
  if (landed.length === 0) return;
  releaseDrafts(landed.flatMap((item) => item.files));
  store.pending = store.pending.filter((item) => !arrived.has(item.requestId));
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
      // The answer just grew the context, so the caption is stale until this lands.
      void loadContext();
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
    case "presence": {
      const next = new Set(frame.active);
      const finished = presenceBaseline
        ? [...presenceBaseline].filter((id) => !next.has(id))
        : [];
      presenceBaseline = next;
      store.active = frame.active;
      if (finished.length > 0) announceCompletions(finished);
      break;
    }
    case "fleet":
      store.fleet = frame.fleet;
      break;
    case "display":
      store.display = frame.display;
      applyDisplay(frame.display);
      break;
    case "activity":
      store.activity = frame.activity;
      watchClock();
      break;
    default:
      break;
  }
}

/**
 * Sound, a toast, or a desktop notification when a run leaves the active list.
 *
 * Only real sessions are announced: a group's member conversations are active too, but the room's own id is
 * the one the owner can open. The first presence frame is a baseline, so a page load never announces work
 * that was already running.
 */
function announceCompletions(ids: readonly string[]): void {
  const prefs = loadNotifyPrefs();
  const hidden = document.visibilityState === "hidden" || !document.hasFocus();
  const seen = new Set<string>();
  let toast: { sessionId: string; title: string; count: number; at: number } | null = null;
  let shouldChime = false;

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const session = store.sessions.find((entry) => entry.id === id);
    if (!session) continue;
    if (session.deletedAt) continue;
    const agent = session.agent ? store.agents.find((entry) => entry.id === session.agent) : undefined;
    const label = agent?.name || (session.kind === "group" ? session.title : session.title);
    const current = id === store.currentId;
    shouldChime = true;

    if (prefs.desktop && (hidden || !current)) {
      showDesktopNotification(
        {
          sessionId: id,
          title: label + " finished",
          body: session.title,
        },
        prefs.sound,
      );
    }

    if (prefs.toast && !hidden && !current) {
      if (toast === null) {
        toast = { sessionId: id, title: label + " finished", count: 1, at: Date.now() };
      } else {
        toast.count += 1;
        toast.at = Date.now();
      }
    }
  }

  if (shouldChime && prefs.sound) playChime();
  if (toast) store.completionToast = toast;
}

export function dismissCompletionToast(): void {
  store.completionToast = null;
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
  presenceBaseline = null;
  store.active = [];
  store.fleet = null;
}

export async function loadSessions(includeDeleted = false): Promise<boolean> {
  try {
    const { sessions } = await api.sessions(includeDeleted);
    store.sessions = sessions;
    return true;
  } catch (err) {
    report(err);
    return false;
  }
}

/**
 * Read the caption's two numbers. Failure is silent and clears the caption: a thread must never break over a
 * meter, and the next message-end retries it anyway.
 */
export async function loadContext(): Promise<void> {
  const current = store.currentId;
  if (!current) {
    store.context = null;
    return;
  }
  try {
    const info = await api.context(current);
    if (store.currentId === current) store.context = info;
  } catch {
    if (store.currentId === current) store.context = null;
  }
}

/** Models grouped by the providers that actually hold credentials; loaded once per tab. */
export async function loadModelGroups(): Promise<void> {
  if (store.modelGroups.length > 0) return;
  try {
    const { providers } = await api.providers();
    const connected = providers.filter((row) => row.configured);
    const groups = await Promise.all(
      connected.map(async (row) => {
        const { models } = await api.models(row.id);
        return { provider: row.id, models: models.map((model) => ({ id: model.id, name: model.name })) };
      }),
    );
    store.modelGroups = groups.filter((group) => group.models.length > 0);
  } catch (err) {
    report(err);
  }
}

/** Ask the server to rewrite this thread's context; the result arrives in the transcript as a pill. */
export async function compactThread(): Promise<boolean> {
  const current = store.currentId;
  if (!current) return false;
  try {
    await api.compact(current);
    return true;
  } catch (err) {
    report(err);
    return false;
  }
}

/** Switch the model from the composer. An agent thread moves its agent, and the server decides which. */
export async function setThreadModel(provider: string, modelId: string): Promise<void> {
  const current = store.currentId;
  if (!current) return;
  try {
    await api.setModel(current, provider, modelId);
    await loadSessions();
    await loadContext();
  } catch (err) {
    report(err);
  }
}

export async function loadAgents(): Promise<boolean> {
  try {
    const { agents } = await api.agents();
    store.agents = agents;
    return true;
  } catch (err) {
    report(err);
    return false;
  }
}

/** The REST fallback for a fleet page opened before the presence socket's first frame. */
export async function loadFleet(): Promise<boolean> {
  try {
    store.fleet = await api.fleet();
    return true;
  } catch (err) {
    report(err);
    return false;
  }
}

/** Fetch the saved display before the shell is shown; a failure falls back to the built-in defaults. */
export async function loadDisplay(): Promise<boolean> {
  try {
    store.display = await api.display();
    applyDisplay(store.display);
    return true;
  } catch (err) {
    report(err);
    applyDisplay({ ...DEFAULT_DISPLAY, updatedAt: Date.now() });
    return false;
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
  store.activity = IDLE_ACTIVITY;
  watchClock();
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
  void loadContext();
}

export function closeSession(): void {
  disconnect?.();
  disconnect = null;
  openToken += 1;
  store.currentId = null;
  store.busy = false;
  store.activity = IDLE_ACTIVITY;
  watchClock();
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

/**
 * Grant or revoke Full Access for one thread.
 *
 * The list is reloaded so the chip follows the record, and nothing touches the agent: the grant lives on the
 * thread, so the next thread this agent starts is back at the agent's own tier.
 */
export async function setThreadGrant(id: string, grant: "full" | null): Promise<void> {
  try {
    await api.setSessionGrant(id, grant);
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

/**
 * Send one message, with its files.
 *
 * The echo is placed immediately so the composer can clear, and it is dropped by `requestId` when the durable
 * entry arrives. On a refusal the echo is removed, the error is shown, and the error is rethrown so the
 * composer can put the draft back where the user left it — the server wrote nothing, so nothing is lost.
 *
 * `whenBusy: "steer"` folds the message into the run that is generating instead of queueing behind it.
 */
export async function send(
  draft: { text: string; files: DraftFile[] },
  whenBusy?: "steer" | "followUp",
): Promise<void> {
  const id = store.currentId;
  const value = draft.text.trim();
  if (!id || (value.length === 0 && draft.files.length === 0)) return;
  store.error = null;
  store.busy = true;
  const requestId = crypto.randomUUID();
  store.pending = [...store.pending, { requestId, text: value, files: draft.files, at: Date.now() }];
  store.sessions = store.sessions.map((session) =>
    session.id === id ? { ...session, updatedAt: Date.now() } : session,
  );
  try {
    await api.send(id, {
      text: value,
      requestId,
      attachments: draft.files.map((file) => ({
        name: file.name,
        mimeType: file.mimeType,
        data: file.base64,
      })),
      ...(whenBusy ? { whenBusy } : {}),
    });
  } catch (error) {
    store.busy = false;
    store.pending = store.pending.filter((item) => item.requestId !== requestId);
    report(error);
    throw error;
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

// ---------- system: facts, update, restart ----------

let systemTimer: number | undefined;
let restartTimer: number | undefined;

function systemMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the process facts. A failure during a restart is expected, not an error to show.
 *
 * `store.restart` is the one place that knows the process is supposed to be gone.
 */
export async function loadSystem(): Promise<void> {
  try {
    store.system = await api.system();
    if (store.restart === null || store.restart.state === "returned") store.systemOperationError = null;
  } catch (error) {
    if (store.restart === null || store.restart.state === "returned") {
      store.systemOperationError = systemMessageOf(error);
    }
  }
}

function stopSystemTimer(): void {
  if (systemTimer !== undefined) {
    window.clearInterval(systemTimer);
    systemTimer = undefined;
  }
}

/** Poll once a second while an operation runs; stop as soon as the server reports nothing running. */
export function watchSystem(): void {
  if (systemTimer !== undefined) return;
  void loadSystem();
  systemTimer = window.setInterval(() => {
    void loadSystem();
    if (store.system?.current === null) stopSystemTimer();
  }, 1000);
}

export function unwatchSystem(): void {
  stopSystemTimer();
  if (restartTimer !== undefined) {
    window.clearInterval(restartTimer);
    restartTimer = undefined;
  }
}

/** Start (or join) the update. The server owns it from here, so navigating away loses nothing. */
export async function startSystemUpdate(): Promise<void> {
  store.systemOperationError = null;
  store.restart = null;
  try {
    await api.startUpdate();
    await loadSystem();
    watchSystem();
  } catch (error) {
    store.systemOperationError = systemMessageOf(error);
  }
}

/**
 * Ask the process to leave, then watch for a *different* pid.
 *
 * The response already says whether anything will bring it back (`restarting` vs `stopped`); the poll only
 * proves it. A bare `npm start` never returns, so the UI says so instead of spinning forever.
 */
export async function startSystemRestart(): Promise<void> {
  const previousPid = store.system?.process.pid ?? 0;
  store.systemOperationError = null;
  store.restart = null;
  try {
    const operation = await api.startRestart();
    store.restart =
      operation.state.name === "stopped"
        ? { state: "stopping", since: Date.now() }
        : { state: "waiting", previousPid, since: Date.now() };
    if (store.restart.state === "waiting") waitForRestart(previousPid);
  } catch (error) {
    store.systemOperationError = systemMessageOf(error);
  }
}

async function restartTick(previousPid: number, since: number): Promise<void> {
  try {
    const snapshot = await api.system();
    store.system = snapshot;
    if (snapshot.process.pid === previousPid) return;
    const last = snapshot.last;
    const downtimeMs =
      last?.state.name === "done" && last.state.outcome.kind === "restart"
        ? last.state.outcome.downtimeMs
        : null;
    store.restart = { state: "returned", downtimeMs };
    store.systemOperationError = null;
    if (restartTimer !== undefined) {
      window.clearInterval(restartTimer);
      restartTimer = undefined;
    }
    // The WebSocket reconnects on its own; the thread list and its activity are reloaded here.
    await loadSessions();
  } catch {
    if (Date.now() - since > 20_000) {
      if (restartTimer !== undefined) {
        window.clearInterval(restartTimer);
        restartTimer = undefined;
      }
      store.restart = { state: "missed", since: Date.now() };
    }
  }
}

function waitForRestart(previousPid: number): void {
  if (restartTimer !== undefined) window.clearInterval(restartTimer);
  const since = Date.now();
  restartTimer = window.setInterval(() => {
    void restartTick(previousPid, since);
  }, 500);
}