import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AttachmentDraft } from "../../core/src/attachments.ts";
import { mimeForName } from "../../core/src/artifacts.ts";
import type { DiscordAttachment } from "./types.ts";

/** Discord's default upload ceiling for a bot; boosted guilds can be higher, but this is the safe cap. */
export const DISCORD_FILE_LIMIT = 25 * 1024 * 1024;
export const DISCORD_TOTAL_LIMIT = 50 * 1024 * 1024;
export const DISCORD_MAX_FILES = 10;

const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

function safeName(value: string): string {
  return basename(value).replace(/[\r\n\u0000]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "file";
}

function isDiscordCdn(url: URL): boolean {
  return (url.protocol === "https:" || url.protocol === "http:") && CDN_HOSTS.has(url.hostname);
}

/**
 * Download attachments immediately: Discord's CDN URLs are signed and expire.
 *
 * Hosts are allowlisted so a malicious message cannot make the daemon fetch an internal address.
 */
export async function downloadDiscordAttachments(
  attachments: readonly DiscordAttachment[],
): Promise<AttachmentDraft[]> {
  const selected = attachments.slice(0, DISCORD_MAX_FILES);
  let total = 0;
  const drafts: AttachmentDraft[] = [];
  for (const attachment of selected) {
    if (!Number.isFinite(attachment.size) || attachment.size <= 0) continue;
    if (attachment.size > DISCORD_FILE_LIMIT) {
      throw new Error("attachment " + safeName(attachment.filename) + " is larger than 25 MB");
    }
    if (total + attachment.size > DISCORD_TOTAL_LIMIT) {
      throw new Error("attachments are larger than 50 MB in total");
    }
    let url: URL;
    try {
      url = new URL(attachment.url);
    } catch {
      continue;
    }
    if (!isDiscordCdn(url)) throw new Error("attachment URL is not on the Discord CDN");
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("could not download " + safeName(attachment.filename) + ": HTTP " + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) continue;
    if (bytes.byteLength > DISCORD_FILE_LIMIT) throw new Error("attachment " + safeName(attachment.filename) + " is larger than 25 MB");
    total += bytes.byteLength;
    drafts.push({
      name: safeName(attachment.filename),
      mimeType: attachment.content_type ?? mimeForName(attachment.filename),
      data: bytes.toString("base64"),
    });
  }
  return drafts;
}

export type OutboundDiscordFile = { name: string; data: Uint8Array; mimeType: string };

/** Read one generated artifact for upload, enforcing the same ceiling as an inbound file. */
export async function outboundDiscordFile(path: string, name: string): Promise<OutboundDiscordFile> {
  const info = await stat(path);
  if (info.size <= 0) throw new Error("the file is empty");
  if (info.size > DISCORD_FILE_LIMIT) throw new Error("the file is larger than 25 MB");
  return {
    name: safeName(name),
    data: await readFile(path),
    mimeType: mimeForName(name),
  };
}
