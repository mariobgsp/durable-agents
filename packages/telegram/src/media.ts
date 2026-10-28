import type { AttachmentDraft } from "../../core/src/attachments.ts";
import { BotApi } from "./client.ts";
import type { TgMessage } from "./types.ts";

/** Telegram files become the same AttachmentDraft a browser upload produces. */
const MAX_FILE = 12 * 1024 * 1024;

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

export async function attachmentFromMessage(api: BotApi, message: TgMessage): Promise<AttachmentDraft | undefined> {
  let fileId: string | undefined;
  let name = "file";
  let mimeType = "application/octet-stream";

  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    fileId = largest?.file_id;
    name = "photo.jpg";
    mimeType = "image/jpeg";
  } else if (message.document) {
    fileId = message.document.file_id;
    name = message.document.file_name ?? "document";
    mimeType = message.document.mime_type ?? "application/octet-stream";
    if ((message.document.file_size ?? 0) > MAX_FILE) throw new MediaError("the document is larger than 12 MB");
  }

  if (!fileId) return undefined;
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new MediaError("Telegram did not return a file path");
  const bytes = await api.downloadFile(file.file_path, MAX_FILE);
  return { name, mimeType, data: Buffer.from(bytes).toString("base64") };
}

export function captionOf(message: TgMessage): string {
  return (message.caption ?? message.text ?? "").trim();
}
