import { cp, mkdir, readFile, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Parsed, flag, has } from "../args.ts";
import { bytes, fail, json, paint, print } from "../output.ts";
import { duraHome, repoRoot } from "../../../core/src/paths.ts";
import { listAgents } from "../../../core/src/agents.ts";

/** Copy an older data directory into DURA_HOME. The source is never deleted. */
export async function runMigrate(parsed: Parsed): Promise<void> {
  const from = resolve(flag(parsed, "from") ?? resolve(repoRoot, "data"));
  const dry = has(parsed, "dry-run");
  const exists = await stat(from).then(() => true).catch(() => false);
  if (!exists) fail("no data directory at " + from, 4);

  const sourceDb = resolve(from, "app.sqlite");
  const hasDb = await stat(sourceDb).then(() => true).catch(() => false);
  const destDb = resolve(duraHome, "app.sqlite");
  const destHas = await stat(destDb).then(() => true).catch(() => false);
  if (destHas && !has(parsed, "force")) {
    fail("destination already has data (" + destDb + "); pass --force to back it up and replace the copy", 4);
  }

  const files = ["app.sqlite", "agents", "artifacts", "vault", "tmp", "browser", "sessions.json", "schedules.json", "mesh.json", "usage.jsonl", "credentials.json", "display.json"];
  const present: string[] = [];
  for (const name of files) {
    if (await stat(resolve(from, name)).then(() => true).catch(() => false)) present.push(name);
  }

  if (dry) {
    if (has(parsed, "json")) json({ from, home: duraHome, present });
    else {
      print("would copy from " + from + " to " + duraHome + ":");
      for (const name of present) print("  " + name);
    }
    return;
  }

  await mkdir(duraHome, { recursive: true, mode: 0o700 });
  if (destHas) {
    const backup = duraHome + ".bak." + new Date().toISOString().replace(/[:.]/g, "-");
    await rename(duraHome, backup).catch(async () => undefined);
    await mkdir(duraHome, { recursive: true, mode: 0o700 });
    print("backed up the previous home to " + backup);
  }

  if (hasDb) {
    // Fold the WAL into the main file before copying, then verify the copy. A WAL copied without
    // its header is a database that looks fine and is missing the newest work.
    const db = new DatabaseSync(sourceDb);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  }

  for (const name of present) {
    await cp(resolve(from, name), resolve(duraHome, name), { recursive: true, force: true, errorOnExist: false });
  }

  if (hasDb) {
    const db = new DatabaseSync(destDb, { readOnly: true });
    try {
      const result = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
      if (result?.integrity_check !== "ok") fail("the copied database failed integrity_check: " + String(result?.integrity_check), 1);
    } finally {
      db.close();
    }
  }

  const agents = await listAgents();
  const size = await stat(destDb).then((entry) => entry.size).catch(() => 0);
  if (has(parsed, "json")) json({ from, home: duraHome, copied: present, agents: agents.length, dbBytes: size });
  else {
    print(paint("green", "migrated") + " " + present.length + " entries into " + duraHome);
    print("agents " + agents.length + " · database " + bytes(size));
    print(paint("dim", "the source is untouched; reassign agents to bots with: dura agent set <id> bot=<label>"));
  }
}
