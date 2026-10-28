import type { ConversationId, Harness, TaskId } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { liveActivity, liveText, runTaskId, typingAuthors, type LiveView } from "./live.ts";
import { entriesToMsgs, entryToMsg } from "./transcript.ts";
import type { WireFrame } from "./wire.ts";

export type Sender = (frame: WireFrame) => void;
export type EventStreamHandle = { stop: () => Promise<void> };

/**
 * Streaming to the client goes through the conversation watch (not watchEvents): one subscription
 * that yields new entries plus assistant partials. `message_update` from watchEvents is never
 * emitted for this provider, so partials are read straight from `pi.live`.
 *
 * Everything read out of `pi.live` lives in `live.ts`; this file decides when to send it.
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
  let activitySignature = "";

  /** The run's own durable start time, so an elapsed counter survives a reconnect. */
  let currentRunTask: TaskId | undefined;
  let runStart: number | null = null;

  /**
   * The run task's own `startedAt`, read once per run.
   *
   * Durable, so a connection that attaches mid-run (or after a restart) reports the real elapsed time
   * rather than restarting the clock — and `null` when the record cannot be read, which the UI shows as no
   * elapsed time instead of a number nobody observed.
   */
  const runStartOf = async (view: LiveView): Promise<number | null> => {
    const taskId = runTaskId(view);
    if (taskId === currentRunTask) return runStart;
    currentRunTask = taskId;
    runStart = null;
    if (taskId === undefined) return runStart;
    try {
      const record = await conversation.commit((tx) => tx.task(taskId), streamContext);
      const startedAt = (record as { startedAt?: unknown } | undefined)?.startedAt;
      if (typeof startedAt === "number") runStart = startedAt;
    } catch {
      // A task that cannot be read is not an error worth breaking the stream over: no timer is honest.
    }
    return runStart;
  };

  /** The round's status is a whole-list snapshot, so it is only sent when it actually changed. */
  const publishActivity = async (view: LiveView): Promise<void> => {
    const activity = liveActivity(view, { runStart: await runStartOf(view) });
    const signature = JSON.stringify(activity);
    if (signature === activitySignature) return;
    activitySignature = signature;
    send({ type: "activity", activity });
  };

  const publish = async (view: LiveView): Promise<void> => {
    // First, because the tail of this function returns early when only the status changed.
    await publishActivity(view);
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
  };

  for (const entry of watch.value.entries) seen.add(String(entry.id));
  send({ type: "snapshot", entries: entriesToMsgs(watch.value.entries) });
  // A socket that connects mid-answer must still learn who is answering: the transcript already holds it,
  // and without this a reconnect would show an empty "is typing" line for the rest of the round.
  for (const author of typingAuthors(watch.value.entries)) {
    send({ type: "typing", author, state: "start" });
  }
  // Connecting mid-round must show the calls already running, not wait for the next change.
  await publishActivity(watch.value);

  partial = liveText(watch.value);
  if (partial) {
    send({ type: "message-start" });
    send({ type: "delta", text: partial });
  }

  watch.start(async (value) => {
    try {
      await publish(value);
    } catch (error) {
      send({ type: "error", message: String(error) });
    }
  });

  return { stop: () => watch.stop().then(() => undefined) };
}
