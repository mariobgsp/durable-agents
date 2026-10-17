import type { EntryRecord } from "@earendil-works/pi-durable";
import type { WireMsg, WireRole } from "./wire.ts";

const BUILTIN_ROLES: Record<string, WireRole> = {
  "pi.user": "user",
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

/**
 * Durable entry -> UI message. Only pi.user and pi.assistant are shown for now;
 * pi.system (prompt/tool deltas), pi.compaction, pi.reset and pi.tool-result are hidden.
 */
export function entryToMsg(entry: EntryRecord): WireMsg | null {
  const builtin = BUILTIN_ROLES[entry.kind];
  const data: unknown = entry.data;
  const author = authorProp(data) ?? null;
  const appText = textProp(data) ?? "";

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
