import type { ConversationId, EntryRecord, Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { entriesToMsgs, entryToMsg } from "./transcript.ts";
import type { WireFrame } from "./wire.ts";

export type Sender = (frame: WireFrame) => void;
export type EventStreamHandle = { stop: () => Promise<void> };

type LiveDoc = { generation?: { attempt?: number; message?: { content?: unknown } } };

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

  for (const entry of watch.value.entries) seen.add(String(entry.id));
  send({ type: "snapshot", entries: entriesToMsgs(watch.value.entries) });

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

  function publish(view: ViewLike): void {
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
