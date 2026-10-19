import type { EntryRecord, TaskId } from "@earendil-works/pi-durable";
import type { RunPhase, WireActivity, WireTool } from "./wire.ts";

/**
 * Everything read out of `pi.live` and `pi.inbox`, in one module.
 *
 * The phase is *derived*, never stored and never timed: every row of the table below is a signal that was
 * actually observed, so the indicator cannot narrate a stage that did not happen. "Thinking" requires
 * thinking tokens, "writing" requires text, "tool" requires a call that is not done, and a run with no
 * output yet says "starting" rather than guessing.
 */

/** The part of `ConversationView` this module reads (the original type is not exported by the package). */
export type LiveView = {
  readonly entries: readonly EntryRecord[];
  readonly docs: Readonly<Record<string, unknown>>;
};

/** One slot of the current round, as far as this file cares. See pi-durable's LiveState. */
type LiveSlot = {
  callId?: unknown;
  name?: unknown;
  status?: unknown;
  output?: unknown;
  parentCallId?: unknown;
  diagnostics?: unknown;
};

/** The part of `pi.live` this file reads. */
type LiveDoc = {
  run?: { taskId?: unknown };
  generation?: {
    attempt?: unknown;
    message?: { content?: unknown };
    retry?: { at?: unknown };
  };
  tools?: unknown;
  nestedTools?: unknown;
  compactions?: unknown;
};

/** The trace shows one line, so only the tail of a running output is worth sending. */
const OUTPUT_TAIL = 400;

function liveDoc(view: LiveView): LiveDoc | undefined {
  return view.docs["pi.live"] as LiveDoc | undefined;
}

/** Text of the assistant message in flight, from the committed partial in `pi.live`. */
export function liveText(view: LiveView): string {
  const content = liveDoc(view)?.generation?.message?.content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block && typeof block === "object") {
      const value = (block as { text?: unknown }).text;
      if (typeof value === "string") text += value;
    }
  }
  return text;
}

/** Whether the partial carries a non-empty block of this type. */
function partialHasBlock(view: LiveView, type: "text" | "thinking"): boolean {
  const content = liveDoc(view)?.generation?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const typed = block as { type?: unknown; text?: unknown; thinking?: unknown };
    if (typed.type !== type) return false;
    const value = type === "text" ? typed.text : typed.thinking;
    return typeof value === "string" && value.trim().length > 0;
  });
}

function errorDiagnostic(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    const severity =
      entry && typeof entry === "object" ? (entry as { severity?: unknown }).severity : undefined;
    return severity === "error";
  });
}

/**
 * The calls of the current round, read from `pi.live` alongside the partial text.
 *
 * Only top-level calls are published: a code-mode script can make thousands of nested calls, which is a
 * count on the parent, not a thousand rows. `since` is when *this connection* first saw the call, so a
 * connection that attached mid-call reports no elapsed time instead of inventing one.
 */
export function liveTools(
  view: LiveView,
  seen: Map<string, number>,
  now: number,
): WireTool[] {
  const live = liveDoc(view);
  const slots = Array.isArray(live?.tools) ? (live.tools as LiveSlot[]) : [];
  const nested = Array.isArray(live?.nestedTools) ? (live.nestedTools as LiveSlot[]) : [];

  const nestedByParent = new Map<string, number>();
  for (const child of nested) {
    if (typeof child.parentCallId !== "string") continue;
    nestedByParent.set(child.parentCallId, (nestedByParent.get(child.parentCallId) ?? 0) + 1);
  }

  const tools: WireTool[] = [];
  for (const slot of slots) {
    if (typeof slot.callId !== "string" || typeof slot.name !== "string") continue;
    const status = slot.status === "running" || slot.status === "done" ? slot.status : "pending";
    if (status !== "done" && !seen.has(slot.callId)) seen.set(slot.callId, now);
    const counted = nestedByParent.get(slot.callId) ?? 0;
    const output = typeof slot.output === "string" ? slot.output.slice(-OUTPUT_TAIL) : "";
    const since = seen.get(slot.callId);
    tools.push({
      callId: slot.callId,
      name: slot.name,
      status,
      ...(output ? { output } : {}),
      ...(errorDiagnostic(slot.diagnostics) ? { isError: true } : {}),
      ...(counted > 0 ? { nested: counted } : {}),
      ...(status !== "done" && since !== undefined ? { since } : {}),
    });
  }

  // Forget calls that left the round, so a long session's map cannot grow without bound.
  const live_calls = new Set(tools.map((tool) => tool.callId));
  for (const callId of seen.keys()) if (!live_calls.has(callId)) seen.delete(callId);
  return tools;
}

/** Inputs admitted and waiting for the next boundary: ids and modes only, never their content. */
export function queuedInputs(view: LiveView): { requestId: string; mode: "steer" | "followUp" }[] {
  const inbox = view.docs["pi.inbox"] as { items?: unknown } | undefined;
  if (!Array.isArray(inbox?.items)) return [];
  const queued: { requestId: string; mode: "steer" | "followUp" }[] = [];
  for (const item of inbox.items) {
    if (!item || typeof item !== "object") continue;
    const entry = (item as { mode?: unknown; entry?: unknown });
    if (entry.mode !== "steer" && entry.mode !== "followUp") continue;
    const data = (entry.entry as { data?: unknown } | undefined)?.data;
    const requestId = (data as { requestId?: unknown } | undefined)?.requestId;
    if (typeof requestId === "string" && requestId.length > 0) {
      queued.push({ requestId, mode: entry.mode });
    }
  }
  return queued;
}

/** The run task in flight, or undefined when the conversation is idle. */
export function runTaskId(view: LiveView): TaskId | undefined {
  const value = liveDoc(view)?.run?.taskId;
  // SAFETY: a task id is a number on the wire (`Id<"task">` is a branded number); this is the boundary
  // where the untyped document value becomes the typed id the transaction API takes.
  return typeof value === "number" ? (value as TaskId) : undefined;
}

/**
 * The phase table, first match wins. This function is the only copy of the order.
 *
 * `runStart` is the run task's own durable `startedAt`, resolved by the caller once per run: null when it
 * could not be read, in which case the UI shows no elapsed time rather than a number nobody observed.
 */
export function liveActivity(
  view: LiveView,
  seen: Map<string, number>,
  input: { now: number; runStart: number | null },
): WireActivity {
  const live = liveDoc(view);
  const calls = liveTools(view, seen, input.now);
  const counts = {
    pending: calls.filter((call) => call.status === "pending").length,
    running: calls.filter((call) => call.status === "running").length,
    done: calls.filter((call) => call.status === "done").length,
    nested: calls.reduce((total, call) => total + (call.nested ?? 0), 0),
  };

  let phase: RunPhase | null = null;
  if (Array.isArray(live?.compactions) && live.compactions.length > 0) phase = "compacting";
  else if (live?.generation?.retry !== undefined) phase = "retrying";
  else if (calls.some((call) => call.status !== "done")) phase = "tool";
  else if (partialHasBlock(view, "text")) phase = "writing";
  else if (partialHasBlock(view, "thinking")) phase = "thinking";
  else if (live?.run !== undefined) phase = "starting";

  const attempt = live?.generation?.attempt;
  const retryAt = live?.generation?.retry?.at;
  return {
    phase,
    since: phase === null ? null : input.runStart,
    calls,
    counts,
    queued: queuedInputs(view),
    ...(typeof attempt === "number" ? { attempt } : {}),
    ...(typeof retryAt === "number" ? { retryAt } : {}),
  };
}

/**
 * The members holding an open `chat.typing` entry.
 *
 * Read from the transcript rather than tracked in memory, so a socket that connects mid-answer still
 * learns who is answering — today's client clears its list on open and would otherwise show nothing.
 */
export function typingAuthors(entries: readonly EntryRecord[]): string[] {
  const open = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "chat.typing") continue;
    const data = entry.data as { author?: unknown; state?: unknown } | undefined;
    if (typeof data?.author !== "string") continue;
    if (data.state === "stop") open.delete(data.author);
    else open.add(data.author);
  }
  return [...open];
}
