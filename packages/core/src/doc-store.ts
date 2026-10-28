import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { agentsDir, readAgent } from "./agents.ts";
import { rebindAgent } from "./sessions.ts";

/**
 * AGENT.md and SOUL.md are the persona. The orchestrator and the CLI may change them, but only
 * through this module: a hash guard against a stale read, a bounded patch mode, a size cap, a short
 * history, and a rebind so every existing thread sees the new text on its next request.
 *
 * MEMORY.md is deliberately not writable here. Memory belongs to the agent that wrote it; an
 * orchestrator editing another agent's memory would turn a private notebook into a remote control.
 */

export type DocName = "agent" | "soul";
export type DocMode = "replace" | "append" | "patch";

const DOC_FILE: Record<DocName, string> = { agent: "AGENT.md", soul: "SOUL.md" };
const MAX_BYTES = 64 * 1024;
const HISTORY_KEEP = 5;

export type DocInfo = { doc: DocName; text: string; sha256: string; lines: number };

export type PatchPair = { find: string; replace: string };

export type WriteDocInput = {
  agentId: string;
  doc: DocName;
  mode: DocMode;
  content?: string;
  patches?: PatchPair[];
  expectedSha256?: string;
  allowEmpty?: boolean;
  caller: string;
};

export type WriteDocResult = {
  doc: DocName;
  sha256: string;
  previousSha256: string;
  lines: number;
  historyPath?: string;
  rebound: number;
};

export class DocError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocError";
  }
}

function validId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(id);
}

function docPath(agentId: string, doc: DocName): string {
  if (!validId(agentId)) throw new DocError("invalid agent id: " + agentId);
  return resolve(agentsDir, agentId, DOC_FILE[doc]);
}

function historyDir(agentId: string): string {
  return resolve(agentsDir, agentId, ".history");
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalise(text: string): string {
  // Control characters would make a prompt unreadable; CRLF is normalised; a trailing newline is kept.
  const clean = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  return clean.endsWith("\n") ? clean : clean + "\n";
}

function lineCount(text: string): number {
  return text.trim().length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function readDoc(agentId: string, doc: DocName): Promise<DocInfo> {
  const files = await readAgent(agentId);
  if (!files) throw new DocError("unknown agent: " + agentId);
  const text = await readText(docPath(agentId, doc));
  return { doc, text, sha256: sha(text), lines: lineCount(text) };
}

export async function readDocs(agentId: string): Promise<{ agent: DocInfo; soul: DocInfo }> {
  return { agent: await readDoc(agentId, "agent"), soul: await readDoc(agentId, "soul") };
}

function applyPatches(text: string, patches: readonly PatchPair[]): string {
  if (patches.length === 0) throw new DocError("patch needs at least one find/replace pair");
  let next = text;
  for (const [index, pair] of patches.entries()) {
    if (typeof pair?.find !== "string" || pair.find.length === 0) {
      throw new DocError("patch " + (index + 1) + ": find must be a non-empty string");
    }
    const matches = next.split(pair.find).length - 1;
    if (matches === 0) throw new DocError("patch " + (index + 1) + ": the find text does not appear");
    if (matches > 1) throw new DocError("patch " + (index + 1) + ": the find text appears " + matches + " times; make it unique");
    next = next.replace(pair.find, pair.replace ?? "");
  }
  return next;
}

export type DocChange = {
  agentId: string;
  doc: DocName;
  caller: string;
  previousSha256: string;
  sha256: string;
  mode: DocMode;
};

const listeners = new Set<(event: DocChange) => void>();

export function subscribeDocChanges(listener: (event: DocChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: DocChange): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* a broken listener must not fail a write */
    }
  }
}

/** Write a document through the guard rails and rebind the agent's threads. */
export async function writeDoc(input: WriteDocInput): Promise<WriteDocResult> {
  const files = await readAgent(input.agentId);
  if (!files) throw new DocError("unknown agent: " + input.agentId);
  const path = docPath(input.agentId, input.doc);
  const previous = await readText(path);
  const previousSha256 = sha(previous);
  if (input.expectedSha256 && input.expectedSha256 !== previousSha256) {
    throw new DocError(
      "the document changed since it was read (current sha256 " + previousSha256 + "); read it again before writing",
    );
  }

  let next: string;
  if (input.mode === "replace") {
    if (!input.allowEmpty && (!input.content || input.content.trim().length === 0)) {
      throw new DocError("refusing to replace " + DOC_FILE[input.doc] + " with empty content (pass allowEmpty to force)");
    }
    next = input.content ?? "";
  } else if (input.mode === "append") {
    if (!input.content || input.content.trim().length === 0) throw new DocError("append needs content");
    next = previous.trimEnd() + "\n\n" + input.content;
  } else {
    next = applyPatches(previous, input.patches ?? []);
  }

  next = normalise(next);
  const bytes = Buffer.byteLength(next, "utf8");
  if (bytes > MAX_BYTES) throw new DocError("the document would be " + bytes + " bytes; the cap is " + MAX_BYTES);

  // History first, so a crash after the rename still leaves the previous version recoverable.
  let historyPath: string | undefined;
  if (previous.trim().length > 0) {
    const dir = historyDir(input.agentId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    historyPath = resolve(dir, DOC_FILE[input.doc].replace(".md", "") + "." + stamp + ".md");
    await writeFile(historyPath, previous, { mode: 0o600 });
    const entries = (await readdir(dir))
      .filter((name) => name.startsWith(DOC_FILE[input.doc].replace(".md", "") + "."))
      .sort();
    for (const old of entries.slice(0, Math.max(0, entries.length - HISTORY_KEEP))) {
      await rm(resolve(dir, old), { force: true }).catch(() => undefined);
    }
  }

  const tmp = path + ".tmp";
  await writeFile(tmp, next, { mode: 0o600 });
  await rename(tmp, path);

  const rebound = await rebindAgent(input.agentId).catch(() => 0);
  const event: DocChange = {
    agentId: input.agentId,
    doc: input.doc,
    caller: input.caller,
    previousSha256,
    sha256: sha(next),
    mode: input.mode,
  };
  emit(event);
  return { doc: input.doc, sha256: event.sha256, previousSha256, lines: lineCount(next), historyPath, rebound };
}

export type HistoryEntry = { file: string; timestamp: string; bytes: number };

export async function docHistory(agentId: string, doc: DocName): Promise<HistoryEntry[]> {
  const dir = historyDir(agentId);
  const prefix = DOC_FILE[doc].replace(".md", "") + ".";
  const names = await readdir(dir).catch(() => []);
  const entries: HistoryEntry[] = [];
  for (const name of names.filter((entry) => entry.startsWith(prefix)).sort()) {
    const info = await stat(resolve(dir, name)).catch(() => undefined);
    entries.push({
      file: resolve(dir, name),
      timestamp: name.slice(prefix.length).replace(/\.md$/, ""),
      bytes: info?.size ?? 0,
    });
  }
  return entries;
}

/** Restore one history entry by its timestamp (the part of the file name before .md). */
export async function restoreDoc(agentId: string, doc: DocName, timestamp: string): Promise<WriteDocResult> {
  const file = resolve(historyDir(agentId), DOC_FILE[doc].replace(".md", "") + "." + timestamp + ".md");
  if (!file.startsWith(historyDir(agentId) + "/")) throw new DocError("invalid history path");
  const text = await readFile(file, "utf8").catch(() => "");
  if (!text) throw new DocError("no history entry " + timestamp + " for " + DOC_FILE[doc]);
  return writeDoc({ agentId, doc, mode: "replace", content: text, caller: "restore" });
}
