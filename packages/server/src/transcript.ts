import type { EntryRecord } from "@earendil-works/pi-durable";
import { userEntryDataOf, wireFilesOf } from "./attachments.ts";
import type { WireMsg, WireRole } from "./wire.ts";

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
};

function nestedCount(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const calls = (value as { calls?: unknown }).calls;
  return Array.isArray(calls) ? calls.length : 0;
}

/** One elided line from a longer text: a tool result is a paragraph, and only its gist belongs in chat. */
function firstLine(text: string, limit = 200): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed.length > limit ? trimmed.slice(0, limit) + "\u2026" : trimmed;
  }
  return "";
}

/**
 * The structured reason a call failed, from the result's own diagnostics.
 *
 * A failed call's model-visible text is the diagnostics block rendered between `<harness>` tags, so taking its
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
    ts: 0,
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
      ts: 0,
      kind: entry.kind,
      author: null,
      data: entry.data ?? null,
    };
  }

  const builtin = BUILTIN_ROLES[entry.kind];
  const data: unknown = entry.data;
  const author = authorProp(data) ?? null;
  const appText = textProp(data) ?? "";

  // A user message, in one shape: `chat.user` (what this app writes) and the `pi.user` entries written
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
      ts: 0,
      kind: entry.kind,
      author: user.author,
      ...(user.requestId.length > 0 ? { requestId: user.requestId } : {}),
      ...(files.length > 0 ? { files } : {}),
      data: entry.data ?? null,
    };
  }

  if (!builtin) {
    // Application entry (e.g. chat.user / chat.deliver): shown only when it carries text.
    if (!appText) return null;
    return {
      id: String(entry.id),
      role: entry.kind.startsWith("room.") ? "system" : author ? "assistant" : "user",
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
  return {
    id: String(entry.id),
    role: builtin,
    text,
    ts: 0,
    kind: entry.kind,
    author,
    data: entry.data ?? null,
  };
}

export function entriesToMsgs(entries: readonly EntryRecord[]): WireMsg[] {
  const out: WireMsg[] = [];
  for (const entry of entries) {
    const message = entryToMsg(entry);
    if (message) out.push(message);
  }
  return out;
}
