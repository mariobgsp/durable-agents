import { context, harnessInstance } from "./harness.ts";
import { markActive, markIdle, markIdleIfCurrent } from "./activity.ts";
import type { WireUsage } from "./wire.ts";
import { readAgent } from "./agents.ts";
import {
  MessageRefused,
  USER_ENTRY_KIND,
  requestIdOf,
  userEntryData,
  type UserMessageBody,
} from "./attachments.ts";
import { claimAll, overseeAll } from "./nyahut.ts";
import { planTargets, mentionsIn } from "./router.ts";
import { entryToMsg } from "./transcript.ts";
import {
  agentChangeOf,
  allSessionRecords,
  conversationOf,
  conversationIdFromParam,
  toWireSession,
  updateSessionRecord,
  type SessionRecord,
  type WireSession,
} from "./sessions.ts";
import type { AgentChange, Conversation, SettledSubmissionRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";

export type RoomMode = "nyahut" | "moderator" | "silent";

export type RoomConfig = {
  members: string[];
  mode: RoomMode;
  /** Agent id that moderates (mode "moderator"). */
  moderator?: string;
  /** Total agent-to-agent hop budget for one user message. */
  maxHops: number;
  /** How many members may answer one message (used by nyahut mode). */
  maxResponders: number;
  ifNobodyClaims: "highest" | "silent";
  /** conversation per member, dibuat saat pertama kali dipakai. */
  conversations: Record<string, number>;
  /** User-message counter for this room; keeps requestId unique per message. */
  seq?: number;
  /** Identity the user picks for the group itself, so it reads differently from a single agent. */
  color?: string;
  avatar?: string;
};

export const DEFAULT_ROOM: Omit<RoomConfig, "members"> = {
  mode: "nyahut",
  maxHops: 6,
  maxResponders: 3,
  ifNobodyClaims: "highest",
  conversations: {},
};

/** How many trailing entries are sent to a member as group context. */
const DIGEST_ENTRIES = 14;

function roomOf(record: SessionRecord): RoomConfig {
  const room = record.room;
  if (!room) throw new Error("this session is not a group");
  return {
    members: room.members ?? [],
    mode: room.mode ?? DEFAULT_ROOM.mode,
    moderator: room.moderator,
    maxHops: room.maxHops ?? DEFAULT_ROOM.maxHops,
    maxResponders: room.maxResponders ?? DEFAULT_ROOM.maxResponders,
    ifNobodyClaims: room.ifNobodyClaims ?? DEFAULT_ROOM.ifNobodyClaims,
    conversations: room.conversations ?? {},
    seq: room.seq ?? 0,
    // These two MUST be carried here: roomOf() rebuilds the room field by field, so a field that is
    // missing from this object is dropped on read, and the next updateRoom() patch would wipe it.
    color: typeof room.color === "string" && room.color ? room.color : undefined,
    avatar: typeof room.avatar === "string" && room.avatar ? room.avatar : undefined,
  };
}

export async function isRoom(id: string): Promise<boolean> {
  const numeric = Number(id);
  const record = (await allSessionRecords()).find((session) => session.id === numeric);
  return Boolean(record?.room);
}

export async function createRoom(title: string, members: readonly string[]): Promise<WireSession> {
  const valid: string[] = [];
  for (const member of members) {
    if (await readAgent(member)) valid.push(member);
  }
  if (valid.length === 0) throw new Error("a group needs at least one existing agent");

  const conversation = await harnessInstance().createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: undefined } },
    context,
  );
  const now = Date.now();
  const record: SessionRecord = {
    id: conversation.id,
    title: title.trim() || "New group",
    createdAt: now,
    updatedAt: now,
    kind: "group",
    room: { ...DEFAULT_ROOM, members: valid, moderator: valid[0] },
  };
  await updateSessionRecord(record.id, record);
  return toWireSession(record);
}

export async function updateRoom(id: string, patch: Partial<RoomConfig>): Promise<WireSession | null> {
  const numeric = Number(id);
  const record = (await allSessionRecords()).find((session) => session.id === numeric);
  if (!record?.room) return null;
  const room = { ...roomOf(record), ...patch };
  const updated = await updateSessionRecord(numeric, {
    room: {
      ...room,
      members: room.members.filter((member) => typeof member === "string"),
      moderator:
        room.moderator && room.members.includes(room.moderator) ? room.moderator : room.members[0],
    },
  });
  return updated ? toWireSession(updated) : null;
}

/** A member's conversation inside the room; created once and stored on the room record. */
async function memberConversation(roomId: string, agentId: string): Promise<Conversation> {
  const numeric = Number(roomId);
  const record = (await allSessionRecords()).find((session) => session.id === numeric);
  if (!record?.room) throw new Error("group not found");
  const room = roomOf(record);
  const known = room.conversations[agentId];
  if (known !== undefined) {
    const existing = await harnessInstance().conversation(conversationIdFromParam(String(known))!, context);
    if (existing) return existing;
  }
  const files = await readAgent(agentId);
  if (!files) throw new Error("agent not found: " + agentId);
  const agent: AgentChange = agentChangeOf(files);
  const created = await harnessInstance().createConversation(
    { ownership: { kind: "ownerless" }, agent },
    context,
  );
  await updateSessionRecord(numeric, {
    room: { ...room, conversations: { ...room.conversations, [agentId]: created.id } },
  });
  return created;
}

async function writeEntry(
  roomId: string,
  kind: string,
  data: JsonValue,
): Promise<void> {
  const conversation = await conversationOf(roomId);
  if (!conversation) throw new Error("group not found");
  await conversation.submit({ type: "write", entry: { kind, data } }, context);
}

/**
 * Answer text of a submission. `settled.answer` holds the **EntryId** of the answer entry
 * (not the text), so the entry is read through tx and rendered with `entryToMsg`.
 */
async function answerText(
  conversation: Conversation,
  settled: SettledSubmissionRecord,
): Promise<{ text: string; usage?: WireUsage }> {
  if (settled.type !== "input" || settled.status !== "done") {
    return { text: "(no answer · status " + settled.status + ")" };
  }
  const entry = await conversation.commit((tx) => tx.entry(settled.answer), context);
  const message = entry ? entryToMsg(entry) : null;
  return { text: message?.text ?? (entry ? "(empty answer)" : "(answer entry not found)"), ...(message?.usage ? { usage: message.usage } : {}) };
}

function addUsage(total: WireUsage, usage: WireUsage | undefined): void {
  if (!usage) return;
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  total.cost += usage.cost;
}

function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1) + "s";
}

/** Room timeline digest so every member hears the same conversation. */
async function digest(roomId: string): Promise<string> {
  const conversation = await conversationOf(roomId);
  if (!conversation) return "";
  const view = await conversation.viewState(context);
  const lines: string[] = [];
  for (const entry of view.value.entries) {
    const data = entry.data as { text?: unknown; author?: unknown } | undefined;
    const text = typeof data?.text === "string" ? data.text : "";
    if (!text) continue;
    const author = typeof data?.author === "string" ? data.author : "user";
    lines.push(author + ": " + text);
  }
  return lines.slice(-DIGEST_ENTRIES).join("\n");
}

export type PostResult = { targets: string[]; answered: string[]; reason: string };

/** Post a user message to the room, then run the relevant members (and agent-to-agent replies). */
/**
 * Post to a group.
 *
 * The whole multi-agent flow runs inside this call (claim, answer, oversee), so the activity window is
 * exactly its duration — which is why this does not use `waitForIdle`: the member conversations are
 * separate conversations, and the room's own idle signal would fire before they finish.
 */
export async function postToRoom(roomId: string, body: UserMessageBody): Promise<PostResult> {
  const text = typeof body.text === "string" ? body.text : "";
  // A group has no single model-visible entry, so an attachment would have to be copied once per member.
  // Refused before the room writes anything, so the transcript is untouched by the attempt.
  if (Array.isArray(body.attachments) && body.attachments.length > 0) {
    throw new MessageRefused(
      400,
      "group_attachments",
      "A group cannot take attachments: every member would need its own copy. Send it in a direct thread.",
    );
  }
  if (text.trim().length === 0) {
    throw new MessageRefused(400, "empty", "Nothing to send: no text and no readable file.");
  }
  const startedAt = Date.now();
  const epoch = markActive(roomId);
  try {
    return await runRoomFlow(roomId, text, body, startedAt);
  } finally {
    markIdleIfCurrent(roomId, epoch);
  }
}

async function runRoomFlow(
  roomId: string,
  text: string,
  body: UserMessageBody,
  startedAt: number,
): Promise<PostResult> {
  const numeric = Number(roomId);
  const record = (await allSessionRecords()).find((session) => session.id === numeric);
  if (!record?.room) throw new Error("group not found");
  const room = roomOf(record);

  // The room's own entry is the UI's record of the message: it carries no model content (a room has no
  // model), and the same constructor the direct path uses, so the transcript renders one kind of bubble.
  await writeEntry(
    roomId,
    USER_ENTRY_KIND,
    userEntryData({ requestId: requestIdOf(body.requestId), text, author: null }),
  );

  // Message number; requestId must be unique per message so an old submission is not reused.
  const seq = (room.seq ?? 0) + 1;
  await updateSessionRecord(numeric, { room: { ...room, seq }, updatedAt: Date.now() });

  const planned = planTargets(room.mode, room.moderator, text, room.members);
  const answered: string[] = [];
  const notes: { author: string; text: string }[] = [];
  const runUsage: WireUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  let runTurns = 0;
  const spoken = new Set<string>();
  let queue: string[] = [];
  let hops = 0;

  if (room.mode === "nyahut") {
    // Phase 1: who feels responsible. A failed judgement means no claim.
    const brief = await digest(roomId);
    const claims = await claimAll(room.members, text, brief);
    const claimants = claims
      .filter((claim) => claim.claim)
      .toSorted((a, b) => b.confidence - a.confidence)
      .slice(0, room.maxResponders);
    if (claimants.length > 0) {
      queue = claimants.map((claim) => claim.member);
      await writeEntry(roomId, "room.claim", {
        text:
          "Claim: " +
          claimants.map((claim) => "@" + claim.member + (claim.reason ? " (" + claim.reason + ")" : "")).join(" · "),
      });
    } else {
      const best = claims.toSorted((a, b) => b.confidence - a.confidence)[0];
      if (room.ifNobodyClaims === "silent" || !best) {
        await writeEntry(roomId, "room.no-claim", {
          text: "Nobody felt responsible — mention @name to call someone.",
        });
        return { targets: [], answered, reason: "no claim" };
      }
      queue = [best.member];
      await writeEntry(roomId, "room.no-claim", {
        text: "No claim; @" + best.member + " answers (highest confidence).",
      });
    }
  } else {
    queue = planned.targets;
  }

  if (queue.length === 0) {
    await writeEntry(roomId, "room.no-target", { text: "Nobody was called — mention @name to call someone." });
    return { targets: [], answered, reason: planned.reason };
  }

  while (queue.length > 0 && hops < room.maxHops) {
    const agentId = queue.shift();
    if (agentId === undefined) break;
    // One agent answers once per user message: this stops @pirate ↔ @chef ping-pong.
    if (spoken.has(agentId)) continue;
    spoken.add(agentId);
    hops += 1;
    await writeEntry(roomId, "chat.typing", { author: agentId, state: "start" });
    try {
      const conversation = await memberConversation(roomId, agentId);
      const brief = await digest(roomId);
      const prompt =
        "Recent group conversation:\n" +
        brief +
        "\n\nYou are " +
        agentId +
        ". Answer as " +
        agentId +
        ". If the question suits another member better, mention @name in your answer. Keep it short.";
      // The member conversation is what is actually generating; marking it lets the fleet name the member
      // instead of treating the whole room as one anonymous busy thread. The room mark above still covers
      // the orchestration as a whole.
      const memberEpoch = markActive(String(conversation.id));
      let answer: { text: string; usage?: WireUsage };
      try {
        const submission = await conversation.submit(
          {
            type: "input",
            content: prompt,
            requestId: "room:" + roomId + ":" + seq + ":" + hops + ":" + agentId,
          },
          context,
        );
        const settled = await submission.wait(context);
        answer = await answerText(conversation, settled);
      } finally {
        markIdleIfCurrent(String(conversation.id), memberEpoch);
      }
      await writeEntry(roomId, "chat.agent-message", { text: answer.text, author: agentId });
      answered.push(agentId);
      notes.push({ author: agentId, text: answer.text });
      addUsage(runUsage, answer.usage);
      runTurns += answer.usage ? 1 : 0;
      const next = mentionsIn(answer.text, room.members).filter((member) => member !== agentId);
      queue = [...next, ...queue];
    } catch (error) {
      await writeEntry(roomId, "room.error", {
        text: "Failed to run @" + agentId + ": " + String(error),
      });
    } finally {
      await writeEntry(roomId, "chat.typing", { author: agentId, state: "stop" });
    }
  }

  // Phase 3: the rest oversee, once per message, and only add when needed.
  if (room.mode === "nyahut" && notes.length > 0) {
    const overseers = room.members.filter((member) => !spoken.has(member));
    if (overseers.length > 0) {
      const oversight = await overseeAll(overseers, text, notes);
      for (const note of oversight) {
        if (!note.add) continue;
        await writeEntry(roomId, "chat.note", { text: note.text, author: note.member });
      }
    }
  }

  const endedAt = Date.now();
  if (runTurns > 0) {
    const text =
      "Group run · " +
      seconds(endedAt - startedAt) +
      " · " +
      runUsage.totalTokens.toLocaleString("en-US") +
      " tokens · " +
      runUsage.cacheRead.toLocaleString("en-US") +
      " cached";
    await writeEntry(roomId, "room.usage", {
      text,
      run: {
        startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt - startedAt),
        turns: runTurns,
        usage: runUsage,
      },
    });
  }

  await updateSessionRecord(numeric, { updatedAt: Date.now() });
  return { targets: planned.targets, answered, reason: planned.reason };
}

/** Abort the room: its conversation plus every member conversation already created. */
export async function abortRoom(id: string): Promise<boolean> {
  // Room conversation first, then the member conversations already created.
  const conversation = await conversationOf(id);
  if (!conversation) return false;
  markIdle(id);
  await conversation.abort(context);
  const numeric = Number(id);
  const record = (await allSessionRecords()).find((session) => session.id === numeric);
  if (record?.room) {
    for (const memberId of Object.values(roomOf(record).conversations)) {
      const memberConversationHandle = await harnessInstance().conversation(
        conversationIdFromParam(String(memberId))!,
        context,
      );
      await memberConversationHandle?.abort(context);
    }
  }
  return true;
}