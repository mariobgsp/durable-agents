import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { dataDir } from "./paths.ts";

/**
 * Files an agent generates and attaches to a thread.
 *
 * The bytes live under data/artifacts/<conversation>/<artifact-id>; the entry carries only metadata. That keeps
 * a PDF out of every transcript read and lets the download route stream it from disk. The entry is the durable
 * index: a file without an entry is never shown, and a purged conversation removes both.
 */
export type ArtifactInfo = {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
};

export const ARTIFACT_LIMIT = 64 * 1024 * 1024;

const MIME: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  yaml: "application/yaml; charset=utf-8",
  yml: "application/yaml; charset=utf-8",
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  ts: "text/typescript; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function artifactsDir(): string {
  return resolve(dataDir, "artifacts");
}

function conversationDir(conversationId: string): string {
  // Conversation ids are numeric strings. Anything else must never reach a path.
  if (!/^[0-9]+$/.test(conversationId)) throw new Error("invalid conversation id for an artifact");
  return resolve(artifactsDir(), conversationId);
}

export function artifactName(name: string): string {
  const clean = basename(name).replace(/[\r\n\u0000]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 0 ? clean.slice(0, 120) : "file";
}

export function mimeForName(name: string): string {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  return MIME[extension] ?? "application/octet-stream";
}

/** Never put a model-provided header value straight on the wire. */
function safeMime(value: string, name: string): string {
  const clean = value.trim();
  return /^[\w.+-]+\/[\w.+-]+(?:;\s*charset=[\w-]+)?$/i.test(clean) ? clean : mimeForName(name);
}

function assertSize(bytes: number): void {
  if (bytes <= 0) throw new Error("the file is empty");
  if (bytes > ARTIFACT_LIMIT) throw new Error("the file is larger than 64 MB");
}

/** Write one artifact and return the metadata the entry will carry. */
export async function saveArtifact(
  conversationId: string,
  name: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<ArtifactInfo> {
  assertSize(bytes.byteLength);
  const id = randomUUID();
  const cleanName = artifactName(name);
  const dir = conversationDir(conversationId);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, id), bytes);
  return {
    id,
    name: cleanName,
    mimeType: safeMime(mimeType, cleanName),
    bytes: bytes.byteLength,
  };
}

/** The bytes of an artifact, or undefined for an unknown or malformed id. */
export async function readArtifact(conversationId: string, artifactId: string): Promise<Buffer | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(artifactId)) return undefined;
  try {
    const path = resolve(conversationDir(conversationId), artifactId);
    // The id shape check already prevents traversal; this is a second belt for a future caller.
    if (!path.startsWith(conversationDir(conversationId) + "/")) return undefined;
    return await readFile(path);
  } catch {
    return undefined;
  }
}

/** Remove every generated file for one conversation. Called by purge, after the export. */
export async function removeArtifacts(conversationId: string): Promise<void> {
  try {
    await rm(conversationDir(conversationId), { recursive: true, force: true });
  } catch {
    /* A missing directory is already clean. */
  }
}

/** Bytes on disk, for the Storage panel. */
export async function artifactsBytes(): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const info = await stat(path).catch(() => null);
        total += info?.size ?? 0;
      }
    }
  };
  await walk(artifactsDir());
  return total;
}