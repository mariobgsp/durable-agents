import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { Conversation, EntryId, EntryRecord, UserInput } from "@earendil-works/pi-durable";
import type { ImageLimits, ImagePolicy } from "./capabilities.ts";
import { extractDocument } from "./documents.ts";
import { imageProcessor } from "./harness.ts";
import type { WireFile } from "./wire.ts";

/**
 * Attachments: the durable record, the boundary that validates one, and the two reads that serve it.
 *
 * The bytes live in the entry the model was given — the user message's own model content, in SQLite —
 * and `data.files[]` describes that same entry's blocks. Nothing is copied anywhere else, so there is no
 * second store, no dedupe, no garbage collection and no sync problem. That is the whole point of this
 * module: it is the only place that knows how a file becomes part of a message.
 *
 * Bytes and text are converted in memory. A PDF goes to `pdftotext` on stdin, never through a path, so
 * this module creates no temporary file at all.
 */

/** The kind every user message is placed as, in a direct thread and in a group alike. */
export const USER_ENTRY_KIND = "chat.user";

/**
 * What one message may carry, before normalization. The per-message figure is what keeps the base64 body
 * of the POST under its own route limit; the per-file figure is what one attachment may be.
 */
export const ATTACHMENT_LIMITS = {
  maxFiles: 10,
  maxFileBytes: 12 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxDocCharsPerFile: 40_000,
  maxDocCharsPerMessage: 120_000,
} as const;

/** One file as the browser handed it over: base64 of the file's own bytes, unnormalized. */
export type AttachmentDraft = { name: string; mimeType: string; data: string };

export type FileKind = "image" | "document";

/**
 * What the entry keeps about one file.
 *
 * A file the model was given names its content block; a file it was not given says why and has no block,
 * so "omitted" and "has a block" cannot contradict each other. Byte size, MIME type and character count
 * are deliberately absent: they are read back out of the block, in this same immutable entry.
 */
export type FileRef =
  | { name: string; kind: FileKind; state: "included"; block: number; chars?: number }
  | {
      name: string;
      kind: FileKind;
      state: "truncated";
      block: number;
      chars: number;
      code: string;
      reason: string;
    }
  | { name: string; kind: FileKind; state: "omitted"; code: string; reason: string };

/** The durable record of one user message. `userEntryData()` is its only constructor. */
export type UserEntryData = {
  requestId: string;
  text: string;
  author: string | null;
  files: FileRef[];
};

/** The POST body as it arrived: untrusted JSON, made into domain values here and nowhere else. */
export type UserMessageBody = { text?: unknown; attachments?: unknown; requestId?: unknown };

export type PreparedUserMessage = { data: UserEntryData; content: UserInput };

/** A message the server refused. `status` and `code` are transport; `reason` is shown to the user as written. */
export class MessageRefused extends Error {
  readonly status: 400 | 413;
  readonly code: string;

  constructor(status: 400 | 413, code: string, reason: string) {
    super(reason);
    this.name = "MessageRefused";
    this.status = status;
    this.code = code;
  }
}

/**
 * The whole write boundary: validate, normalize, convert and describe.
 *
 * Returns the model content and the durable record together, or throws `MessageRefused`. Nothing is
 * written anywhere before it returns, so a refusal leaves no entry, no file and no spent model call —
 * rerunning the request is the whole fix.
 */
export async function prepareUserMessage(
  body: UserMessageBody,
  policy: ImagePolicy,
  author: string | null = null,
): Promise<PreparedUserMessage> {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const drafts = decodeAttachments(body.attachments);

  const images = drafts.filter((draft) => draft.kind === "image");

  const content: Block[] = [];
  if (text.length > 0) content.push({ type: "text", text });

  const files: FileRef[] = [];
  let documentChars = 0;

  for (const draft of drafts) {
    if (draft.kind === "image") {
      files.push(await addImage(draft, content, requireImageLimits(images.length, policy)));
      continue;
    }
    const added = await addDocument(draft, content, documentChars);
    if (added.state !== "omitted") documentChars += added.chars ?? 0;
    files.push(added);
  }

  if (content.length === 0) {
    throw new MessageRefused(400, "empty", "Nothing to send: no text and no readable file.");
  }
  return { data: userEntryData({ requestId: requestIdOf(body.requestId), text, author }, files), content };
}

/** The only constructor of a user entry's data. A group calls this with no files, and no model content. */
export function userEntryData(
  input: { requestId: string; text: string; author?: string | null },
  files: readonly FileRef[] = [],
): UserEntryData {
  return {
    requestId: input.requestId,
    text: input.text,
    author: input.author ?? null,
    files: [...files],
  };
}

/**
 * Read a user-message record back.
 *
 * `chat.user` is the only kind this writes, but a transcript also holds `pi.user` entries from before
 * this module existed, so both are normalized into one shape and the bubble renderer is written once.
 */
export function userEntryDataOf(entry: EntryRecord): UserEntryData | undefined {
  const data = entry.data as Partial<UserEntryData> | undefined;
  if (entry.kind === USER_ENTRY_KIND) {
    return {
      requestId: typeof data?.requestId === "string" ? data.requestId : "",
      text: typeof data?.text === "string" ? data.text : "",
      author: typeof data?.author === "string" ? data.author : null,
      files: Array.isArray(data?.files) ? (data.files as FileRef[]).filter(isFileRef) : [],
    };
  }
  if (entry.kind === "pi.user") {
    // History only: the text of a legacy entry is its model message, and it has no files.
    return { requestId: "", text: legacyText(entry), author: null, files: [] };
  }
  return undefined;
}

export type ServedFile = { mimeType: string; body: Buffer };

/**
 * The `index`-th file of a user entry, exactly as the model was given it: decoded image bytes, or the
 * extracted document text. Undefined for a wrong entry kind, an out-of-range index, or an omitted file.
 */
export async function readUserFile(
  conversation: Conversation,
  entryId: EntryId,
  index: number,
  context: Context,
): Promise<ServedFile | undefined> {
  const entry = await conversation.commit((tx) => tx.entry(entryId), context);
  // `tx.entry(id)` is a global lookup, so the owning conversation is checked here: without this, any
  // entry's file would be servable through any thread id.
  if (!entry || entry.conversationId !== conversation.id) return undefined;
  const data = userEntryDataOf(entry);
  const file = data?.files[index];
  if (!data || !file || file.state === "omitted") return undefined;
  const block = contentBlock(entry, file.block);
  if (!block) return undefined;
  if (block.type === "image") {
    return { mimeType: block.mimeType, body: Buffer.from(block.data, "base64") };
  }
  return { mimeType: "text/plain; charset=utf-8", body: Buffer.from(block.text, "utf8") };
}

/**
 * The files one durable entry carries, as the wire describes them: metadata only, with byte size and
 * character count derived from the block the model was given rather than stored beside it.
 */
export function wireFilesOf(entry: EntryRecord): WireFile[] {
  const data = userEntryDataOf(entry);
  if (!data) return [];
  return data.files.map((file) => {
    if (file.state === "omitted") {
      return { name: file.name, kind: file.kind, state: file.state, code: file.code, reason: file.reason };
    }
    const block = contentBlock(entry, file.block);
    const derived: WireFile = { name: file.name, kind: file.kind, state: file.state };
    if (file.state === "truncated") {
      derived.code = file.code;
      derived.reason = file.reason;
    }
    if (block?.type === "image") {
      derived.mimeType = block.mimeType;
      derived.bytes = base64Bytes(block.data);
    } else if (block?.type === "text") {
      derived.mimeType = "text/plain";
      derived.chars = file.state === "truncated" ? (file.chars ?? 0) : block.text.length;
    }
    return derived;
  });
}

// ---------- internals ----------

type DecodedDraft = { name: string; mimeType: string; bytes: Uint8Array; kind: FileKind };

/** Shape, count and byte budget of the raw field. The only place `unknown` becomes an attachment. */
function decodeAttachments(raw: unknown): DecodedDraft[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new MessageRefused(400, "bad_attachment", "Attachments must be a list.");
  if (raw.length === 0) return [];
  if (raw.length > ATTACHMENT_LIMITS.maxFiles) {
    throw new MessageRefused(
      400,
      "too_many_files",
      `This message has ${raw.length} files; at most ${ATTACHMENT_LIMITS.maxFiles} can be sent.`,
    );
  }

  let total = 0;
  const drafts: DecodedDraft[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new MessageRefused(400, "bad_attachment", "One of the attachments is not a file.");
    }
    const source = item as { name?: unknown; mimeType?: unknown; data?: unknown };
    const name = fileName(source.name);
    const mimeType = typeof source.mimeType === "string" ? source.mimeType : "application/octet-stream";
    if (typeof source.data !== "string" || source.data.length === 0) {
      throw new MessageRefused(400, "bad_attachment", `${name} arrived without any content.`);
    }
    const bytes = Buffer.from(source.data, "base64");
    if (bytes.length === 0) {
      throw new MessageRefused(400, "bad_attachment", `${name} could not be decoded.`);
    }
    if (bytes.length > ATTACHMENT_LIMITS.maxFileBytes) {
      throw new MessageRefused(413, "file_too_large", `${name} is larger than one file may be.`);
    }
    total += bytes.length;
    if (total > ATTACHMENT_LIMITS.maxTotalBytes) {
      throw new MessageRefused(413, "too_large", "These files are larger than one message can carry.");
    }
    drafts.push({ name, mimeType, bytes, kind: mimeType.startsWith("image/") ? "image" : "document" });
  }
  return drafts;
}

/**
 * The image limits this message may use, or a refusal.
 *
 * The one place the image policy is enforced, called at the moment an image is about to be prepared:
 * before any conversion work, and before anything is durable. Returning the limits is what lets the caller
 * use them without a cast — an image draft implies this function returned.
 */
function requireImageLimits(imageCount: number, policy: ImagePolicy): ImageLimits {
  if (!policy.allowed) throw new MessageRefused(400, policy.code, policy.reason);
  if (imageCount > policy.limits.maxPerMessage) {
    throw new MessageRefused(
      400,
      "too_many_images",
      `This message has ${imageCount} images; at most ${policy.limits.maxPerMessage} can be sent.`,
    );
  }
  return policy.limits;
}

/** One image: normalized by the same processor the `read` tool uses, to this model's own limits. */
async function addImage(
  draft: DecodedDraft,
  content: Block[],
  limits: ImageLimits,
): Promise<FileRef> {
  // Measured on this machine: `prepare()` returns undefined for a Node Buffer and works for a plain
  // Uint8Array, so the bytes are copied before the call. Passing the Buffer through would silently omit
  // every uploaded image.
  const prepared = await imageProcessor().prepare(new Uint8Array(draft.bytes), draft.mimeType, {
    maxWidth: limits.maxWidth,
    maxHeight: limits.maxHeight,
    maxBytes: limits.maxBytes,
  });
  if (!prepared) {
    return {
      name: draft.name,
      kind: "image",
      state: "omitted",
      code: "image-unreadable",
      reason: `${draft.name} could not be read as an image`,
    };
  }
  const block = content.length;
  // The marker is a text block, so a compacted thread still records that an image was attached: the
  // summarizer serializes text blocks only.
  content.push({ type: "text", text: `[attached image: ${draft.name}]` });
  content.push({ type: "image", data: prepared.data, mimeType: prepared.mimeType });
  return { name: draft.name, kind: "image", state: "included", block: block + 1 };
}

/** One document: text inlined under its own budget, with the truncation stated to model and user alike. */
async function addDocument(
  draft: DecodedDraft,
  content: Block[],
  documentChars: number,
): Promise<FileRef> {
  const extracted = await extractDocument(draft.bytes, draft.name, draft.mimeType);
  if (!extracted.ok) {
    return { name: draft.name, kind: "document", state: "omitted", code: extracted.code, reason: extracted.reason };
  }

  const budget = Math.min(
    ATTACHMENT_LIMITS.maxDocCharsPerFile,
    Math.max(0, ATTACHMENT_LIMITS.maxDocCharsPerMessage - documentChars),
  );
  const kept = extracted.text.slice(0, budget);
  if (kept.trim().length === 0) {
    return {
      name: draft.name,
      kind: "document",
      state: "omitted",
      code: "empty",
      reason: `${draft.name} has no readable text`,
    };
  }

  const block = content.length;
  const header = `File: ${draft.name} (${draft.mimeType})\n\n`;
  const truncated = kept.length < extracted.text.length;
  const total = extracted.text.length.toLocaleString("en-US");
  const marker = truncated
    ? `\n\n[truncated: the first ${kept.length.toLocaleString("en-US")} of ${total} characters of ${draft.name}]`
    : "";
  content.push({ type: "text", text: header + kept + marker });
  if (!truncated) return { name: draft.name, kind: "document", state: "included", block, chars: kept.length };
  return {
    name: draft.name,
    kind: "document",
    state: "truncated",
    block,
    chars: kept.length,
    code: "document-truncated",
    reason: `only the first ${kept.length.toLocaleString("en-US")} of ${total} characters were sent`,
  };
}

/** The content blocks of an input entry, read structurally: `model[0].content`. */
type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function contentBlock(entry: EntryRecord, index: number): Block | undefined {
  const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const block = content[index] as Block | undefined;
  if (!block || typeof block !== "object") return undefined;
  if (block.type === "text" && typeof block.text === "string") return block;
  if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") return block;
  return undefined;
}

/** Text of a legacy `pi.user` entry, from its model message. */
function legacyText(entry: EntryRecord): string {
  const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text ?? "") : ""))
    .filter((part) => part.length > 0)
    .join("\n");
}

/** Bytes behind a base64 string, from its length: 3 bytes per 4 characters, minus the padding. */
function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** A filename is display-only, so it is cleaned and capped, never trusted and never used as a path. */
function fileName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/[\r\n\u0000]/g, " ").trim() : "";
  return name.length > 0 ? name.slice(0, 120) : "untitled";
}

/** The request id an entry echoes back, so a client drops exactly its own local echo. */
export function requestIdOf(raw: unknown): string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 128 ? raw : randomUUID();
}

/** Whether a value read back out of `entry.data` is a file reference we wrote. */
function isFileRef(value: unknown): value is FileRef {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<FileRef>;
  return (
    typeof file.name === "string" &&
    (file.kind === "image" || file.kind === "document") &&
    (file.state === "included" || file.state === "truncated" || file.state === "omitted")
  );
}
