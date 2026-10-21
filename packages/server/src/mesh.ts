import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Submission, SubmissionId } from "@earendil-works/pi-durable";
import { listAgents } from "./agents.ts";
import { userEntryDataOf, type MeshMeta, type UserVia } from "./attachments.ts";
import { activeIds, startedAt as activityStartedAt } from "./activity.ts";
import { harnessInstance } from "./harness.ts";
import { meshPath } from "./paths.ts";
import { activityOf, ownedThreads, type OwnedThread } from "./roster.ts";
import {
  agentForConversation,
  allSessionRecords,
  conversationOf,
  createSession,
  findSession,
  sendMessage,
} from "./sessions.ts";
import {
  setMeshService,
  type MeshRosterEntry,
  type MeshService,
  type MeshTargetResult,
} from "./mesh-tools.ts";
import { entryToMsg } from "./transcript.ts";

/**
 * The agent network: directed inbox threads, fan-out, delegation and the link index.
 *
 * A message is delivered into a thread the recipient owns, so it runs with the recipient's model and tools.
 * The sender's own thread only records the tool call and its result. This keeps every turn attributable and
 * avoids reconfiguring a shared conversation between two agents.
 */

const MAX_HOPS = 6;
const MAX_MESSAGE_TARGETS = 16;
const MAX_DELEGATE_TARGETS = 4;
const LINK_LIMIT = 1000;
const PREVIEW_LIMIT = 160;

export type MeshLink = {
  id: string;
  batchId: string;
  kind: "message" | "delegate";
  from: string;
  to: string;
  fromThreadId: string;
  threadId: string;
  submissionId?: string;
  requestId: string;
  status: "sent" | "answered" | "failed";
  hop: number;
  preview?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

type MeshState = { version: 1; links: MeshLink[] };

let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

async function readState(): Promise<MeshState> {
  try {
    const parsed = JSON.parse(await readFile(meshPath, "utf8")) as Partial<MeshState>;
    return {
      version: 1,
      links: Array.isArray(parsed.links) ? (parsed.links as MeshLink[]).filter(isLink) : [],
    };
  } catch {
    return { version: 1, links: [] };
  }
}

async function writeState(state: MeshState): Promise<void> {
  await mkdir(dirname(meshPath), { recursive: true });
  const tmp = meshPath + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, meshPath);
}

function isLink(value: unknown): value is MeshLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Partial<MeshLink>;
  return (
    typeof link.id === "string" &&
    typeof link.batchId === "string" &&
    (link.kind === "message" || link.kind === "delegate") &&
    typeof link.from === "string" &&
    typeof link.to === "string" &&
    typeof link.fromThreadId === "string" &&
    typeof link.threadId === "string" &&
    (link.status === "sent" || link.status === "answered" || link.status === "failed")
  );
}

const listeners = new Set<() => void>();
export function subscribeMesh(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* A broken listener must not stop a delivery. */
    }
  }
}

export async function listLinks(): Promise<MeshLink[]> {
  const state = await readState();
  return state.links.toSorted((a, b) => b.createdAt - a.createdAt);
}

async function appendLinks(links: readonly MeshLink[]): Promise<void> {
  if (links.length === 0) return;
  await serialize(async () => {
    const state = await readState();
    const known = new Set(state.links.map((link) => link.requestId));
    const fresh = links.filter((link) => !known.has(link.requestId));
    if (fresh.length === 0) return;
    state.links = [...fresh, ...state.links].slice(0, LINK_LIMIT);
    await writeState(state);
  });
  emit();
}

async function updateLink(id: string, patch: Partial<MeshLink>): Promise<void> {
  let changed = false;
  await serialize(async () => {
    const state = await readState();
    const index = state.links.findIndex((link) => link.id === id);
    if (index === -1) return;
    state.links[index] = { ...state.links[index]!, ...patch, updatedAt: Date.now() };
    await writeState(state);
    changed = true;
  });
  if (changed) emit();
}

/** Remove links that point at a purged thread. Called by the purge route. */
export async function forgetMeshThread(threadId: string): Promise<void> {
  await serialize(async () => {
    const state = await readState();
    const next = state.links.filter((link) => link.threadId !== threadId && link.fromThreadId !== threadId);
    if (next.length === state.links.length) return;
    state.links = next;
    await writeState(state);
  });
  emit();
}

/** Remove links involving a deleted agent. Historical transcripts are untouched. */
export async function forgetMeshAgent(agentId: string): Promise<void> {
  await serialize(async () => {
    const state = await readState();
    const next = state.links.filter((link) => link.from !== agentId && link.to !== agentId);
    if (next.length === state.links.length) return;
    state.links = next;
    await writeState(state);
  });
  emit();
}

type Inbound = { from: string; chain: string[]; hop: number } | undefined;

/** The latest message from another agent in this conversation, if any. */
async function inboundOf(conversationId: string): Promise<Inbound> {
  const conversation = await conversationOf(conversationId);
  if (!conversation) return undefined;
  const view = await conversation.viewState(BACKGROUND_CONTEXT);
  for (const entry of [...view.value.entries].reverse()) {
    const data = userEntryDataOf(entry);
    const mesh = data?.mesh;
    if (!mesh) continue;
    return { from: mesh.from, chain: mesh.chain, hop: mesh.hop };
  }
  return undefined;
}

async function senderOf(conversationId: string): Promise<string | undefined> {
  return agentForConversation(conversationId);
}

type Resolution = { agentId: string; name: string; enabled: boolean } | { target: string; reason: string };

async function resolveTargets(raw: readonly string[], sender: string, limit: number): Promise<Resolution[]> {
  const agents = await listAgents();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const byName = new Map<string, typeof agents>();
  for (const agent of agents) {
    const key = agent.name.trim().toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(agent);
    byName.set(key, list);
  }
  const expanded: string[] = [];
  for (const value of raw) {
    const clean = value.trim().replace(/^@/, "");
    if (clean === "all" || clean === "*") {
      for (const agent of agents) if (agent.id !== sender) expanded.push(agent.id);
      continue;
    }
    expanded.push(clean);
  }
  const seen = new Set<string>();
  const out: Resolution[] = [];
  for (const value of expanded) {
    if (out.length >= limit) {
      out.push({ target: value, reason: "over the per-call target limit" });
      continue;
    }
    let agent = byId.get(value);
    if (!agent) {
      const candidates = byName.get(value.toLowerCase()) ?? [];
      if (candidates.length === 1) agent = candidates[0];
      else if (candidates.length > 1) {
        out.push({ target: value, reason: "ambiguous name; use the id or a longer name" });
        continue;
      }
    }
    if (!agent) {
      out.push({ target: value, reason: "no agent with that id or name" });
      continue;
    }
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    if (agent.id === sender) {
      out.push({ target: agent.id, reason: "an agent cannot target itself" });
      continue;
    }
    if (agent.enabled === false) {
      out.push({ target: agent.id, reason: "this agent is disabled" });
      continue;
    }
    out.push({ agentId: agent.id, name: agent.name, enabled: true });
  }
  return out;
}

function allowedTarget(target: string, sender: string, inbound: Inbound): string | undefined {
  const hop = (inbound?.hop ?? 0) + 1;
  if (hop > MAX_HOPS) return "the agent-to-agent hop limit (" + MAX_HOPS + ") would be exceeded";
  const chain = inbound?.chain ?? [];
  if (target === sender) return "an agent cannot target itself";
  if (chain.includes(target) && target !== inbound?.from) {
    return "this would create an agent-to-agent cycle";
  }
  return undefined;
}

function chainFor(sender: string, inbound: Inbound): string[] {
  const base = inbound?.chain ?? [];
  return [...base, sender].slice(-32);
}

function hopFor(inbound: Inbound): number {
  return (inbound?.hop ?? 0) + 1;
}

const creations = new Map<string, Promise<string>>();

/** Serialize the check-or-create step per meshKey, so two simultaneous messages cannot create two inboxes. */
async function threadFor(key: string, create: () => Promise<string>): Promise<string> {
  const pending = creations.get(key);
  if (pending) return pending;
  const work = (async () => {
    const existing = (await allSessionRecords()).find(
      (record) => record.meshKey === key && record.purpose && !record.deletedAt,
    );
    if (existing) return String(existing.id);
    return create();
  })().finally(() => creations.delete(key));
  creations.set(key, work);
  return work;
}

async function inboxThread(recipient: string, sender: string): Promise<string> {
  const key = "inbox:" + recipient + ":" + sender;
  return threadFor(key, async () => {
    const created = await createSession("Inbox · @" + sender, recipient, {
      purpose: "inbox",
      meshKey: key,
      peer: sender,
    });
    return created.id;
  });
}

async function delegationThread(
  recipient: string,
  sender: string,
  taskId: string,
  task: string,
  title: string | undefined,
): Promise<string> {
  const key = "delegate:" + taskId + ":" + recipient;
  return threadFor(key, async () => {
    const label = (title?.trim() || task.trim().slice(0, 48) || "task").slice(0, 80);
    const created = await createSession("Task · " + label, recipient, {
      purpose: "delegate",
      meshKey: key,
      peer: sender,
    });
    return created.id;
  });
}

function preview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW_LIMIT ? line.slice(0, PREVIEW_LIMIT - 1) + "…" : line;
}

function refusal(target: string, reason: string): MeshTargetResult {
  return { target, ok: false, reason };
}

async function submissionOf(id: string): Promise<Submission | undefined> {
  const numeric = Number(id);
  if (!Number.isSafeInteger(numeric)) return undefined;
  return harnessInstance().submission(numeric as SubmissionId, BACKGROUND_CONTEXT);
}

async function watchMessage(linkId: string, submissionId: string): Promise<void> {
  try {
    const submission = await submissionOf(submissionId);
    if (!submission) {
      await updateLink(linkId, { status: "failed", error: "the submission no longer exists" });
      return;
    }
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    if (settled.status === "done") {
      await updateLink(linkId, { status: "answered" });
    } else {
      await updateLink(linkId, { status: "failed", error: settled.reason });
    }
  } catch (error) {
    await updateLink(linkId, { status: "failed", error: String(error).slice(0, 300) });
  }
}

async function answerOf(conversationId: string, submissionId: string, context: Context): Promise<{
  answer?: string;
  reason?: string;
  tokens?: number;
  cacheRead?: number;
  durationMs?: number;
}> {
  const submission = await submissionOf(submissionId);
  if (!submission) return { reason: "the submission no longer exists" };
  const settled = await submission.wait(context);
  if (settled.status !== "done") return { reason: settled.reason };
  if (settled.type !== "input") return { reason: "the target did not return an answer" };
  const conversation = await conversationOf(conversationId);
  if (!conversation) return { reason: "the target thread no longer exists" };
  const entry = await conversation.commit((tx) => tx.entry(settled.answer), context);
  if (!entry) return { reason: "the answer entry was not found" };
  const message = entryToMsg(entry);
  const usage = message?.usage;
  const duration = (entry.model?.[0] as { durationMs?: unknown } | undefined)?.durationMs;
  return {
    answer: message?.text ?? "(empty answer)",
    ...(usage ? { tokens: usage.totalTokens, cacheRead: usage.cacheRead } : {}),
    ...(typeof duration === "number" ? { durationMs: duration } : {}),
  };
}

function link(
  input: {
    batchId: string;
    kind: "message" | "delegate";
    from: string;
    to: string;
    fromThreadId: string;
    threadId: string;
    submissionId?: string;
    requestId: string;
    hop: number;
    preview: string;
  },
): MeshLink {
  const now = Date.now();
  return {
    id: randomUUID(),
    batchId: input.batchId,
    kind: input.kind,
    from: input.from,
    to: input.to,
    fromThreadId: input.fromThreadId,
    threadId: input.threadId,
    ...(input.submissionId ? { submissionId: input.submissionId } : {}),
    requestId: input.requestId,
    status: "sent",
    hop: input.hop,
    preview: input.preview,
    createdAt: now,
    updatedAt: now,
  };
}

async function messageTarget(input: {
  sender: string;
  fromThreadId: string;
  target: string;
  text: string;
  threadId?: string;
  inbound: Inbound;
  taskId: string;
  batchId: string;
}): Promise<{ result: MeshTargetResult; link?: MeshLink }> {
  const reason = allowedTarget(input.target, input.sender, input.inbound);
  if (reason) return { result: refusal(input.target, reason) };
  let threadId = input.threadId;
  if (threadId) {
    const record = await findSession(threadId);
    if (!record || record.deletedAt || record.room || record.agent !== input.target) {
      return { result: refusal(input.target, "that thread is not a direct thread owned by the target") };
    }
  } else {
    threadId = await inboxThread(input.target, input.sender);
  }
  const requestId = "mesh:" + input.taskId + ":" + input.target;
  const via: UserVia = { kind: "agent", from: input.sender, mode: "message" };
  const mesh: MeshMeta = {
    from: input.sender,
    to: input.target,
    mode: "message",
    chain: chainFor(input.sender, input.inbound),
    hop: hopFor(input.inbound),
  };
  const sent = await sendMessage(
    threadId,
    { text: input.text, requestId },
    "followUp",
    {
      author: input.sender,
      via,
      mesh,
      preamble:
        "Message from @" +
        input.sender +
        " (agent-to-agent). If you want to reply, use agents_message to @" +
        input.sender +
        "; your answer in this thread is visible to your owner.",
    },
  );
  if (!sent) return { result: refusal(input.target, "the target thread could not take the message") };
  const created = link({
    batchId: input.batchId,
    kind: "message",
    from: input.sender,
    to: input.target,
    fromThreadId: input.fromThreadId,
    threadId,
    submissionId: sent.submissionId,
    requestId,
    hop: mesh.hop,
    preview: preview(input.text),
  });
  return { result: { target: input.target, ok: true, threadId }, link: created };
}

async function delegateTarget(input: {
  sender: string;
  fromThreadId: string;
  target: string;
  task: string;
  title?: string;
  inbound: Inbound;
  taskId: string;
  batchId: string;
  context: Context;
}): Promise<{ result: MeshTargetResult; link?: MeshLink }> {
  const reason = allowedTarget(input.target, input.sender, input.inbound);
  if (reason) return { result: refusal(input.target, reason) };
  const started = Date.now();
  const threadId = await delegationThread(input.target, input.sender, input.taskId, input.task, input.title);
  const requestId = "mesh:" + input.taskId + ":" + input.target;
  const via: UserVia = { kind: "agent", from: input.sender, mode: "delegate" };
  const mesh: MeshMeta = {
    from: input.sender,
    to: input.target,
    mode: "delegate",
    chain: chainFor(input.sender, input.inbound),
    hop: hopFor(input.inbound),
  };
  const sent = await sendMessage(
    threadId,
    { text: input.task, requestId },
    "followUp",
    {
      author: input.sender,
      via,
      mesh,
      preamble:
        "Task delegated by @" +
        input.sender +
        ". Complete it and answer here; your answer is returned to @" +
        input.sender +
        ".",
    },
  );
  if (!sent) return { result: refusal(input.target, "the task thread could not take the request") };
  const created = link({
    batchId: input.batchId,
    kind: "delegate",
    from: input.sender,
    to: input.target,
    fromThreadId: input.fromThreadId,
    threadId,
    submissionId: sent.submissionId,
    requestId,
    hop: mesh.hop,
    preview: preview(input.task),
  });
  // The link exists before the wait, so a fleet view opened while the target works can see it.
  await appendLinks([created]);
  const answer = await answerOf(threadId, sent.submissionId, input.context);
  if (answer.reason) {
    await updateLink(created.id, { status: "failed", error: answer.reason });
    return { result: refusal(input.target, answer.reason) };
  }
  await updateLink(created.id, { status: "answered" });
  return {
    result: {
      target: input.target,
      ok: true,
      threadId,
      answer: answer.answer,
      ...(typeof answer.tokens === "number" ? { tokens: answer.tokens } : {}),
      ...(typeof answer.cacheRead === "number" ? { cacheRead: answer.cacheRead } : {}),
      durationMs: Date.now() - started,
    },
  };
}

/** The mesh service installed into the tools. */
export const meshService = {
  async list(): Promise<MeshRosterEntry[]> {
    const agents = await listAgents();
    const records = await allSessionRecords();
    const threads = ownedThreads(records);
    const active = activeIds();
    return agents.map((agent) => {
      const activity = activityOf(agent, threads, active, activityStartedAt);
      return {
        id: agent.id,
        name: agent.name,
        status: activity.status,
        model: agent.provider + "/" + agent.modelId,
        ...(agent.responsibility ? { responsibility: agent.responsibility } : {}),
        ...(activity.current ? { currentThread: activity.current.title } : {}),
      };
    });
  },

  async message(input: {
    conversationId: string;
    taskId: string;
    targets: string[];
    text: string;
    threadId?: string;
  }): Promise<MeshTargetResult[]> {
    const sender = await senderOf(input.conversationId);
    if (!sender) return [{ target: "self", ok: false, reason: "this thread has no agent, so it cannot send" }];
    const text = input.text.trim();
    if (text.length === 0) return [{ target: "self", ok: false, reason: "the message is empty" }];
    const inbound = await inboundOf(input.conversationId);
    const resolved = await resolveTargets(input.targets, sender, MAX_MESSAGE_TARGETS);
    const batchId = input.taskId;
    const links: MeshLink[] = [];
    const results: MeshTargetResult[] = [];
    for (const target of resolved) {
      if ("reason" in target) {
        results.push(refusal(target.target, target.reason));
        continue;
      }
      try {
        const outcome = await messageTarget({
          sender,
          fromThreadId: input.conversationId,
          target: target.agentId,
          text,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          inbound,
          taskId: batchId,
          batchId,
        });
        results.push(outcome.result);
        if (outcome.link) links.push(outcome.link);
      } catch (error) {
        results.push(refusal(target.agentId, "delivery failed: " + String(error).slice(0, 200)));
      }
    }
    await appendLinks(links);
    // Only start the waiters after the links are durable: an instant answer must not update a link that is
    // not stored yet.
    for (const created of links) {
      if (created.submissionId) void watchMessage(created.id, created.submissionId);
    }
    return results;
  },

  async delegate(input: {
    conversationId: string;
    taskId: string;
    targets: string[];
    task: string;
    title?: string;
    context: Context;
  }): Promise<MeshTargetResult[]> {
    const sender = await senderOf(input.conversationId);
    if (!sender) return [{ target: "self", ok: false, reason: "this thread has no agent, so it cannot delegate" }];
    const task = input.task.trim();
    if (task.length === 0) return [{ target: "self", ok: false, reason: "the task is empty" }];
    if (input.targets.some((target) => target.trim() === "all" || target.trim() === "*")) {
      return [{ target: "all", ok: false, reason: "delegate requires explicit targets; use agents_message for all" }];
    }
    if (input.targets.length > MAX_DELEGATE_TARGETS) {
      return [{ target: "all", ok: false, reason: "delegate accepts at most " + MAX_DELEGATE_TARGETS + " targets" }];
    }
    const inbound = await inboundOf(input.conversationId);
    const resolved = await resolveTargets(input.targets, sender, MAX_DELEGATE_TARGETS);
    const batchId = input.taskId;
    const results = await Promise.all(
      resolved.map(async (target): Promise<MeshTargetResult> => {
        if ("reason" in target) return refusal(target.target, target.reason);
        try {
          const outcome = await delegateTarget({
            sender,
            fromThreadId: input.conversationId,
            target: target.agentId,
            task,
            ...(input.title ? { title: input.title } : {}),
            inbound,
            taskId: batchId,
            batchId,
            context: input.context,
          });
          return outcome.result;
        } catch (error) {
          return refusal(target.agentId, "delegation failed: " + String(error).slice(0, 200));
        }
      }),
    );
    return results;
  },
} satisfies MeshService;

setMeshService(meshService);

/**
 * Reconcile links left "sent" by a restart. A submission that still exists keeps a watcher; one that is gone is
 * marked failed rather than pretending an answer arrived.
 */
export async function reconcileMesh(): Promise<void> {
  const links = await listLinks();
  for (const link of links) {
    if (link.status !== "sent" || !link.submissionId) continue;
    void watchMessage(link.id, link.submissionId);
  }
}

/** Expose a typed helper for the fleet view without leaking the whole service. */
export function meshLinks(): Promise<MeshLink[]> {
  return listLinks();
}

/** Used by tests and the fleet snapshot; the caller supplies the current records to avoid a second read. */
export { ownedThreads, activityOf };
export type { OwnedThread };