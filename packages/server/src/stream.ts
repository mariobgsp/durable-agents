import type { ConversationId, EntryRecord, Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { entriesToMsgs, entryToMsg } from "./transcript.ts";
import type { WireFrame, WireTool } from "./wire.ts";

export type Sender = (frame: WireFrame) => void;
export type EventStreamHandle = { stop: () => Promise<void> };

type LiveDoc = { generation?: { attempt?: number; message?: { content?: unknown } } };

/** One slot of the current round, as far as this file cares. See pi-durable's LiveState. */
type LiveSlot = {
  callId?: unknown;
  name?: unknown;
  status?: unknown;
  output?: unknown;
  parentCallId?: unknown;
  diagnostics?: unknown;
};

/** The trace shows one line, so only the tail of a running output is worth sending. */
const OUTPUT_TAIL = 400;

/** The part of ConversationView used here (the original type is not exported by the package). */
type ViewLike = {
  readonly entries: readonly EntryRecord[];
  readonly docs: Readonly<Record<string, unknown>>;
};

/**
 * Text of the assistant message in flight, read from the `pi.live` document.
 * pi-durable publishes partials to that document every `progress.partialIntervalMs`.
 */
function liveText(view: ViewLike): string {
  const live = view.docs["pi.live"] as LiveDoc | undefined;
  const content = live?.generation?.message?.content;
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

function errorDiagnostic(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    const severity = entry && typeof entry === "object" ? (entry as { severity?: unknown }).severity : undefined;
    return severity === "error";
  });
}

/**
 * Tool calls of the current round, read from `pi.live` alongside the partial text.
 *
 * Only top-level calls are published: a code-mode script can make thousands of nested calls, which is a count
 * on the parent, not a thousand rows. `pi.live` is emptied when the run ends, so the trace is empty by the time
 * the round is over — the finished calls stay in the transcript as `pi.tool-result` entries instead.
 */
function liveTools(view: ViewLike): WireTool[] {
  const live = view.docs["pi.live"] as { tools?: unknown; nestedTools?: unknown } | undefined;
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
    const counted = nestedByParent.get(slot.callId) ?? 0;
    const output = typeof slot.output === "string" ? slot.output.slice(-OUTPUT_TAIL) : "";
    tools.push({
      callId: slot.callId,
      name: slot.name,
      status,
      ...(output ? { output } : {}),
      ...(errorDiagnostic(slot.diagnostics) ? { isError: true } : {}),
      ...(counted > 0 ? { nested: counted } : {}),
    });
  }
  return tools;
}

/**
 * Streaming to the client goes through the conversation watch (not watchEvents): one subscription
 * that yields new entries plus assistant partials. `message_update` from watchEvents is never
 * emitted for this provider, so partials are read straight from `pi.live`.
 */
export async function openEventStream(
  harness: Harness,
  conversationId: ConversationId,
  streamContext: Context,
  send: Sender,
): Promise<EventStreamHandle> {
  const conversation = await harness.conversation(conversationId, streamContext);
  if (!conversation) throw new Error("conversation not found");

  const watch = await conversation.watch(streamContext);
  const seen = new Set<string>();
  let partial = "";
  let toolsSignature = "";

  for (const entry of watch.value.entries) seen.add(String(entry.id));
  send({ type: "snapshot", entries: entriesToMsgs(watch.value.entries) });
  // Connecting mid-round must show the calls already running, not wait for the next change.
  publishTools(watch.value);

  partial = liveText(watch.value);
  if (partial) {
    send({ type: "message-start" });
    send({ type: "delta", text: partial });
  }

  watch.start(async (value) => {
    try {
      publish(value);
    } catch (error) {
      send({ type: "error", message: String(error) });
    }
  });

  /** Tool state is a whole-list snapshot, so it is only sent when it actually changed. */
  function publishTools(view: ViewLike): void {
    const tools = liveTools(view);
    const signature = JSON.stringify(tools);
    if (signature === toolsSignature) return;
    toolsSignature = signature;
    send({ type: "tools", tools });
  }

  function publish(view: ViewLike): void {
    // First, because the tail of this function returns early when only the tool state changed.
    publishTools(view);
    let assistantEntry = false;
    for (const entry of view.entries) {
      const id = String(entry.id);
      if (seen.has(id)) continue;
      seen.add(id);
      if (entry.kind === "chat.typing") {
        const data = entry.data as { author?: unknown; state?: unknown } | undefined;
        const author = typeof data?.author === "string" ? data.author : "agent";
        const state = data?.state === "stop" ? "stop" : "start";
        send({ type: "typing", author, state });
        continue;
      }
      const message = entryToMsg(entry);
      if (message) send({ type: "entry", entry: message });
      if (entry.kind === "pi.assistant") {
        assistantEntry = true;
        send({ type: "message-end", text: message?.text ?? "" });
      }
    }

    const next = liveText(view);
    if (next === partial) return;
    if (partial !== "" && next === "") {
      // The generation ended without a final entry (abort/failure): close the bubble.
      partial = "";
      if (!assistantEntry) send({ type: "message-end", text: "" });
      return;
    }
    if (next.startsWith(partial)) {
      const chunk = next.slice(partial.length);
      if (chunk) {
        if (partial === "") send({ type: "message-start" });
        send({ type: "delta", text: chunk });
      }
      partial = next;
      return;
    }
    // A new message (not a continuation): start a fresh bubble.
    send({ type: "message-start" });
    if (next) send({ type: "delta", text: next });
    partial = next;
  }

  return { stop: () => watch.stop().then(() => undefined) };
}
