import type { DraftFile } from "../types.ts";

/**
 * The composer's drafts.
 *
 * A draft is what the browser gave us, held as base64 until it is sent: the endpoint takes one message with
 * its files inside it, so there is no upload step and no staged object. Nothing here decides policy — the
 * server is authoritative for limits, types and the model's capabilities.
 */

/** Above this the file is refused before it is read, so a huge file is never base64-ed for nothing. */
export const MAX_FILE_BYTES = 12 * 1024 * 1024;

let counter = 0;

/** Read one picked file into the shape the endpoint takes. */
export async function draftOf(file: File): Promise<DraftFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  counter += 1;
  const mimeType = file.type.length > 0 ? file.type : "application/octet-stream";
  return {
    key: `f${counter}-${Date.now()}`,
    name: file.name.length > 0 ? file.name : "untitled",
    mimeType,
    base64: toBase64(bytes),
    bytes: bytes.length,
    // Images get a local preview so the optimistic bubble can show the picture before the server answers.
    ...(mimeType.startsWith("image/") ? { previewUrl: URL.createObjectURL(file) } : {}),
  };
}

/** Standard base64, in chunks: one `fromCharCode` call over megabytes overflows the stack. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

/** Release the object URLs of drafts that were sent or dropped. Called once per draft, on every path. */
export function releaseDrafts(drafts: readonly DraftFile[]): void {
  for (const draft of drafts) {
    if (draft.previewUrl !== undefined) URL.revokeObjectURL(draft.previewUrl);
  }
}
