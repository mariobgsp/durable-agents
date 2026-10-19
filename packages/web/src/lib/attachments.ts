import { attachmentUrl } from "../api.ts";
import type { Attachment, DraftFile } from "../types.ts";

/**
 * What a file looks like in a bubble, whoever it came from.
 *
 * A durable file and a draft are different objects — one is metadata about a block the model was given, the
 * other is bytes still in the browser — but they must render identically, or the optimistic bubble would
 * change shape the moment the real entry arrived. This is the one place that turns either into something to
 * draw.
 */
export type ShownFile = {
  key: string;
  name: string;
  kind: "image" | "document";
  state: "included" | "truncated" | "omitted" | "pending";
  /** Where the picture comes from: the entry's own bytes, or a local preview while it is still a draft. */
  url?: string;
  /** "1.2 MB" / "12,340 characters", or empty when the size is unknown. */
  meta: string;
  reason?: string;
};

/** The files of a durable user message. `entryId` is the entry the bytes are read out of. */
export function shownFiles(
  sessionId: string,
  entryId: string,
  files: readonly Attachment[],
): ShownFile[] {
  return files.map((file, index) => ({
    key: entryId + "-" + index,
    name: file.name,
    kind: file.kind,
    state: file.state,
    ...(file.kind === "image" && file.state !== "omitted"
      ? { url: attachmentUrl(sessionId, entryId, index) }
      : {}),
    meta: file.kind === "document" ? characterText(file.chars) : byteText(file.bytes),
    ...(file.reason === undefined ? {} : { reason: file.reason }),
  }));
}

/** The files still in the composer, echoed before the server has seen them. */
export function shownDrafts(files: readonly DraftFile[]): ShownFile[] {
  return files.map((file) => ({
    key: file.key,
    name: file.name,
    kind: file.mimeType.startsWith("image/") ? "image" : "document",
    state: "pending",
    ...(file.previewUrl === undefined ? {} : { url: file.previewUrl }),
    meta: byteText(file.bytes),
  }));
}

function byteText(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function characterText(chars: number | undefined): string {
  if (chars === undefined) return "";
  return chars.toLocaleString("en-US") + " characters";
}
