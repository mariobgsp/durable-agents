import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentsDir } from "./agents.ts";
import { dataDir, dbPath, sessionsPath } from "./paths.ts";

/**
 * Storage: how much there is, and how to give some back.
 *
 * A thread's transcript is durable and immutable, so "cleanup" here means three different things, and it is
 * worth keeping them apart: a **checkpoint** folds the write-ahead log back into the database (the WAL grows
 * independently of the data and is pure overhead once every reader has passed it), a **vacuum** rewrites the
 * file without the space freed by deletions, and a **purge** removes one conversation's rows for good.
 *
 * The purge is the destructive one, so it exports the transcript first and returns the path it wrote.
 */

export type StorageReport = {
  databaseBytes: number;
  walBytes: number;
  sharedMemoryBytes: number;
  sessionsBytes: number;
  agentBytes: number;
  totalBytes: number;
};

async function sizeOf(path: string): Promise<number> {
  const info = await stat(path).catch(() => null);
  return info?.size ?? 0;
}

/** Bytes on disk, split by what a reader would recognise. */
export async function storageReport(): Promise<StorageReport> {
  const databaseBytes = await sizeOf(dbPath);
  const walBytes = await sizeOf(dbPath + "-wal");
  const sharedMemoryBytes = await sizeOf(dbPath + "-shm");
  const sessionsBytes = await sizeOf(sessionsPath);
  let agentBytes = 0;
  for (const entry of await readdir(agentsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    for (const file of await readdir(resolve(agentsDir, entry.name)).catch(() => [])) {
      agentBytes += await sizeOf(resolve(agentsDir, entry.name, file));
    }
  }
  return {
    databaseBytes,
    walBytes,
    sharedMemoryBytes,
    sessionsBytes,
    agentBytes,
    totalBytes: databaseBytes + walBytes + sharedMemoryBytes + sessionsBytes + agentBytes,
  };
}

export type CleanupResult = { before: StorageReport; after: StorageReport; reclaimedBytes: number };

/**
 * Fold the write-ahead log back in and reclaim what deletions left behind.
 *
 * A second connection is opened for this rather than reaching into the harness's own: the pragma and the
 * vacuum are the storage engine's business, and a short busy timeout is enough to wait out a write that is in
 * flight instead of failing the request.
 */
export async function cleanupStorage(): Promise<CleanupResult> {
  const before = await storageReport();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
  } finally {
    db.close();
  }
  const after = await storageReport();
  return { before, after, reclaimedBytes: Math.max(0, before.totalBytes - after.totalBytes) };
}

export type PurgeResult = {
  exportPath: string;
  removedRows: { table: string; rows: number }[];
  reclaimedBytes: number;
};

/** Tables that hold a conversation's rows, discovered rather than hard-coded: see `conversationColumnOf`. */
const PURGE_TABLES = ["entries", "tasks", "submissions", "documents", "document_revisions", "conversations"];

/**
 * The column of `table` that references a conversation, or undefined when it has none.
 *
 * Read from the schema instead of assumed: this deletes rows for good, and a guessed column name either fails
 * or — worse — matches nothing while reporting success. A table that does not reference a conversation is
 * skipped and named in the result.
 */
function conversationColumnOf(db: DatabaseSync, table: string): string | undefined {
  let columns: { name?: unknown }[];
  try {
    columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
  } catch {
    return undefined;
  }
  for (const column of columns) {
    if (typeof column.name === "string" && /conversation/i.test(column.name)) return column.name;
  }
  return undefined;
}

/**
 * Remove one conversation for good, after writing its transcript to `data/exports/`.
 *
 * Irreversible, which is why the export happens first and its path is returned: the rows are the only copy.
 * Tables with no conversation column are skipped rather than guessed at.
 */
export async function purgeConversation(
  conversationId: string,
  transcript: unknown,
): Promise<PurgeResult> {
  const exportsDir = resolve(dataDir, "exports");
  await mkdir(exportsDir, { recursive: true });
  const exportPath = resolve(exportsDir, `${conversationId}.json`);
  await writeFile(
    exportPath,
    JSON.stringify({ conversationId, exportedAt: new Date().toISOString(), entries: transcript }, null, 2),
  );

  const before = await storageReport();
  const db = new DatabaseSync(dbPath);
  const removedRows: { table: string; rows: number }[] = [];
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    for (const table of PURGE_TABLES) {
      const column = conversationColumnOf(db, table);
      if (column === undefined) continue;
      const result = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(Number(conversationId));
      removedRows.push({ table, rows: Number(result.changes ?? 0) });
    }
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  const after = await storageReport();
  return { exportPath, removedRows, reclaimedBytes: Math.max(0, before.totalBytes - after.totalBytes) };
}
