import type { EntryRecord } from "@earendil-works/pi-durable";
import { userEntryDataOf, wireFilesOf } from "./attachments.ts";
import type { WireArtifact, WireMsg, WireRole, WireRun, WireUsage } from "./wire.ts";

/** Only the assistant is still a builtin here: a user message is read through its own record (below). */
const BUILTIN_ROLES: Record<string, WireRole> = {
  "pi.assistant": "assistant",
};

function textProp(source: unknown): string | undefined {
  if (typeof source !== "object" || source === null || !("text" in source)) return undefined;
  const value: unknown = source.text;
  return typeof value === "string" ? value : undefined;
}

function authorProp(source: unknown): string | undefined {
  if (typeof source !== "object" || source === null || !("author" in source)) return undefined;
  const value: unknown = source.author;
  return typeof value === "string" ? value : undefined;
}

/** Text from pi-ai content: a string, a block list or one block. thinking/toolCall blocks are ignored. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(textOf)
      .filter((part) => part.length > 0)
      .join("\n");
  }
  return textProp(value) ?? "";
}

function textOfMessage(message: unknown): string {
  if (typeof message !== "object" || message === null || !("content" in message)) return "";
  return textOf(message.content);
}

/** A finished tool call, read structurally so a shape change in pi-ai cannot break the transcript. */
type ToolResultLike = {
  toolName?: unknown;
  content?: unknown;
  isError?: unknown;
  durationMs?: unknown;
  nestedCalls?: unknown;
  timestamp?: unknown;
};

type AssistantLike = {
  usage?: unknown;
  stopReason?: unknown;
  timestamp?: unknown;
  durationMs?: unknown;
};

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** What one response cost, from the provider's own usage object. Undefined when it reported none. */
function usageOf(value: unknown): WireUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    totalTokens?: unknown;
    cost?: { total?: unknown };
  };
  const has =
    usage.input !== undefined ||
    usage.output !== undefined ||
    usage.totalTokens !== undefined ||
    usage.cacheRead !== undefined;
  if (!has) return undefined;
  return {
    input: numberOf(usage.input),
    output: numberOf(usage.output),
    cacheRead: numberOf(usage.cacheRead),
    cacheWrite: numberOf(usage.cacheWrite),
    totalTokens: numberOf(usage.totalTokens),
    cost: numberOf(usage.cost?.total),
  };
}

function emptyUsage(): WireUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function addUsage(target: WireUsage, usage: WireUsage | undefined): void {
  if (!usage) return;
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
  target.cost += usage.cost;
}

function firstMessage(entry: EntryRecord): unknown {
  return Array.isArray(entry.model) ? entry.model[0] : undefined;
}

function assistantInfoOf(entry: EntryRecord): AssistantLike | undefined {
  if (entry.kind !== "pi.assistant") return undefined;
  const message = firstMessage(entry);
  return message && typeof message === "object" ? (message as AssistantLike) : undefined;
}

function messageTimestampOf(entry: EntryRecord): number {
  const message = firstMessage(entry);
  if (!message || typeof message !== "object") return 0;
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : 0;
}

/** One elided line from a longer text: a tool result is a paragraph, and only its gist belongs in chat. */
function firstLine(text: string, limit = 200): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed.length > limit ? trimmed.slice(0, limit) + "…" : trimmed;
  }
  return "";
}

/**
 * The structured reason a call failed, from the result's own diagnostics.
 *
 * A failed call's model-visible text is the diagnostics block rendered between <harness> tags, so taking its
 * first line gives the tag rather than the message. The diagnostic is the same reason, unrendered, which is
 * what a reader wants on the line — and it is the only reason a policy block leaves.
 */
function diagnosticText(data: unknown): string | undefined {
  const diagnostics = (data as { diagnostics?: unknown } | undefined)?.diagnostics;
  if (!Array.isArray(diagnostics)) return undefined;
  for (const entry of diagnostics) {
    if (!entry || typeof entry !== "object") continue;
    const { severity, message } = entry as { severity?: unknown; message?: unknown };
    if (severity === "error" && typeof message === "string" && message.length > 0) return message;
  }
  return undefined;
}

function nestedCount(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const calls = (value as { calls?: unknown }).calls;
  return Array.isArray(calls) ? calls.length : 0;
}

/**
 * One line for a tool call that has finished.
 *
 * This is what makes the trace durable. `pi.live` holds a call only while it runs, so without this line a
 * session would forget that a tool was ever used — and the model's own toolCall blocks are dropped as
 * text. A skill, an MCP tool and a coding tool all arrive here the same way, so all of them leave a line.
 */
function toolResultLine(entry: EntryRecord): WireMsg | null {
  if (entry.kind !== "pi.tool-result") return null;
  const first = Array.isArray(entry.model) ? (entry.model[0] as unknown) : undefined;
  if (!first || typeof first !== "object") return null;
  const result = first as ToolResultLike;
  if (typeof result.toolName !== "string") return null;
  const nested = nestedCount(result.nestedCalls);
  return {
    id: String(entry.id),
    role: "tool",
    text: diagnosticText(entry.data) ?? firstLine(textOf(result.content)),
    ts: numberOf(result.timestamp),
    kind: entry.kind,
    author: null,
    tool: {
      name: result.toolName,
      isError: result.isError === true,
      ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
      ...(nested > 0 ? { nested } : {}),
    },
    data: entry.data ?? null,
  };
}

/** Read generated-file metadata structurally; an incomplete array is not rendered. */
function artifactsOf(value: unknown): WireArtifact[] {
  if (!Array.isArray(value)) return [];
  const out: WireArtifact[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const file = item as { id?: unknown; name?: unknown; mimeType?: unknown; bytes?: unknown };
    if (typeof file.id !== "string" || typeof file.name !== "string") continue;
    out.push({
      id: file.id,
      name: file.name,
      mimeType: typeof file.mimeType === "string" ? file.mimeType : "application/octet-stream",
      bytes: numberOf(file.bytes),
    });
  }
  return out;
}

/** A room/run summary entry carries its own run. Validate it rather than trusting arbitrary JSON. */
function runOf(value: unknown): WireRun | undefined {
  if (!value || typeof value !== "object") return undefined;
  const run = value as {
    startedAt?: unknown;
    endedAt?: unknown;
    durationMs?: unknown;
    turns?: unknown;
    usage?: unknown;
  };
  if (typeof run.startedAt !== "number" || typeof run.endedAt !== "number") return undefined;
  if (typeof run.durationMs !== "number" || typeof run.turns !== "number") return undefined;
  return {
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: Math.max(0, run.durationMs),
    turns: Math.max(0, Math.round(run.turns)),
    usage: usageOf(run.usage) ?? emptyUsage(),
  };
}

/**
 * Durable entry -> UI message. pi.user and pi.assistant become bubbles, pi.tool-result becomes one line of
 * tool trace and pi.compaction becomes one pill. pi.system (prompt and tool deltas) and pi.reset stay
 * hidden: they are bookkeeping, not conversation.
 */
export function entryToMsg(entry: EntryRecord): WireMsg | null {
  const toolLine = toolResultLine(entry);
  if (toolLine) return toolLine;

  // A compaction rewrote the context. One pill is enough information about it; the summary itself is
  // already inside the conversation the model sees. The reason is worth keeping: "by hand" and "the window
  // was about to overflow" mean different things when you are reading a long thread back.
  if (entry.kind === "pi.compaction") {
    const reason = (entry.data as { reason?: unknown } | undefined)?.reason;
    return {
      id: String(entry.id),
      role: "system",
      text: typeof reason === "string" ? "Context compacted (" + reason + ")" : "Context compacted",
      ts: messageTimestampOf(entry),
      kind: entry.kind,
      author: null,
      data: entry.data ?? null,
    };
  }

  // A completed group run is written as one entry: the UI shows one line, and the session total can sum it.
  if (entry.kind === "room.usage") {
    const data = entry.data as { text?: unknown; run?: unknown } | undefined;
    const text = textProp(data) ?? "Group run completed";
    const run = runOf(data?.run);
    return {
      id: String(entry.id),
      role: "system",
      text,
      ts: run?.endedAt ?? 0,
      kind: entry.kind,
      author: null,
      ...(run ? { run } : {}),
      data: entry.data ?? null,
    };
  }

  // A generated file is its own timeline card: the bytes are on disk, the entry only carries metadata.
  if (entry.kind === "chat.file") {
    const data = entry.data as { text?: unknown; author?: unknown; artifacts?: unknown } | undefined;
    const artifacts = artifactsOf(data?.artifacts);
    if (artifacts.length === 0) return null;
    return {
      id: String(entry.id),
      role: "assistant",
      text: textProp(data) ?? "Generated file",
      ts: 0,
      kind: entry.kind,
      author: authorProp(data) ?? null,
      artifacts,
      data: entry.data ?? null,
    };
  }

  const builtin = BUILTIN_ROLES[entry.kind];
  const data: unknown = entry.data;
  const author = authorProp(data) ?? null;
  const appText = textProp(data) ?? "";

  // A user message, in one shape: chat.user (what this app writes) and the pi.user entries written
  // before it existed both normalize through the same reader, so the bubble is rendered once. An
  // attachment-only message has no text and must still produce a bubble, which is why files count.
  const user = userEntryDataOf(entry);
  if (user) {
    const files = wireFilesOf(entry);
    const text = user.text || appText;
    if (text.length === 0 && files.length === 0) return null;
    return {
      id: String(entry.id),
      role: "user",
      text,
      ts: messageTimestampOf(entry),
      kind: entry.kind,
      author: user.author,
      ...(user.requestId.length > 0 ? { requestId: user.requestId } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(user.via ? { via: user.via } : {}),
      data: entry.data ?? null,
    };
  }

  if (!builtin) {
    // Application entry (e.g. chat.user / chat.deliver): shown only when it carries text.
    if (!appText) return null;
    const system = entry.kind.startsWith("room.") || entry.kind.startsWith("schedule.");
    return {
      id: String(entry.id),
      role: system ? "system" : author ? "assistant" : "user",
      text: appText,
      ts: 0,
      kind: entry.kind,
      author,
      data: entry.data ?? null,
    };
  }

  const messages: readonly unknown[] = entry.model ?? [];
  const modelText = messages
    .map(textOfMessage)
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
  const text = modelText || appText;
  if (!text) return null;
  const info = assistantInfoOf(entry);
  const usage = usageOf(info?.usage);
  return {
    id: String(entry.id),
    role: builtin,
    text,
    ts: typeof info?.timestamp === "number" ? info.timestamp : 0,
    kind: entry.kind,
    author,
    ...(usage ? { usage } : {}),
    data: entry.data ?? null,
  };
}

type OpenRun = {
  startedAt: number;
  usage: WireUsage;
  turns: number;
  endedAt: number;
  /** Sum of assistant durations plus the longest tool call; a floor when a provider gives no duration. */
  workMs: number;
  lastAssistantId: string | undefined;
};

function runOfOpen(open: OpenRun): WireRun | undefined {
  if (!open.lastAssistantId) return undefined;
  const startedAt = open.startedAt > 0 ? open.startedAt : open.endedAt;
  const endedAt = Math.max(startedAt, open.endedAt);
  return {
    startedAt,
    endedAt,
    // Tool time is part of the wait. In particular, a provider that reports no response duration still
    // leaves a durable tool duration, so a tool-heavy run cannot show 0 ms.
    durationMs: Math.max(0, Math.round(Math.max(endedAt - startedAt, open.workMs))),
    turns: open.turns,
    usage: open.usage,
  };
}

/**
 * Attach one run summary to the final assistant of each run.
 *
 * A steer is a user entry in the middle of a run, so it does not start a second run: the run stays open
 * until an assistant answer whose stopReason is not toolUse. The first user timestamp is the start, which
 * includes queueing and tool time — the wall-clock span the owner actually waited for. A run with no
 * assistant has nothing to summarize, and a legacy entry without timestamps falls back to the assistant's
 * own timestamp.
 */
export function entriesToMsgs(entries: readonly EntryRecord[]): WireMsg[] {
  const out: WireMsg[] = [];
  const byId = new Map<string, WireMsg>();
  for (const entry of entries) {
    const message = entryToMsg(entry);
    if (!message) continue;
    out.push(message);
    byId.set(message.id, message);
  }

  let open: OpenRun | undefined;
  const close = (): void => {
    if (!open) return;
    const run = runOfOpen(open);
    if (run && open.lastAssistantId) {
      const target = byId.get(open.lastAssistantId);
      if (target) target.run = run;
    }
    open = undefined;
  };

  for (const entry of entries) {
    const message = byId.get(String(entry.id));

    if (message?.role === "user") {
      if (!open) {
        open = {
          startedAt: message.ts,
          usage: emptyUsage(),
          turns: 0,
          endedAt: message.ts,
          workMs: 0,
          lastAssistantId: undefined,
        };
      }
      // A steer while a run is open is part of that run; do not reset the clock.
      continue;
    }

    if (entry.kind === "pi.tool-result") {
      const result = firstMessage(entry) as { durationMs?: unknown; timestamp?: unknown } | undefined;
      if (open) {
        const toolMs = typeof result?.durationMs === "number" ? Math.max(0, result.durationMs) : 0;
        open.workMs = Math.max(open.workMs, toolMs);
        if (typeof result?.timestamp === "number") open.endedAt = Math.max(open.endedAt, result.timestamp);
      }
      continue;
    }

    // Process an assistant entry even when it has no visible text (a tool-call-only round): its usage is
    // part of the run, and the final answer is a later entry.
    const info = assistantInfoOf(entry);
    if (!info) continue;
    const at = typeof info.timestamp === "number" ? info.timestamp : (message?.ts ?? 0);
    if (!open) {
      open = { startedAt: at, usage: emptyUsage(), turns: 0, endedAt: at, workMs: 0, lastAssistantId: undefined };
    }
    addUsage(open.usage, usageOf(info.usage));
    open.turns += 1;
    if (message) open.lastAssistantId = message.id;
    const duration = typeof info.durationMs === "number" ? info.durationMs : 0;
    open.workMs += Math.max(0, duration);
    open.endedAt = Math.max(open.endedAt, at + Math.max(0, duration));

    if (info.stopReason !== "toolUse") close();
  }
  close();
  return out;
}