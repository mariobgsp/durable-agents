import { type Parsed, flag, has, numberFlag } from "../args.ts";
import { fail, json, paint, print, table, duration } from "../output.ts";
import { withDaemon } from "../client.ts";
import { readConfig } from "../../../core/src/config.ts";
import { confirm, interactive } from "../prompts.ts";

type Session = {
  id: string;
  title: string;
  agent?: string;
  updatedAt: number;
  deletedAt?: number;
  purpose?: string;
  room?: unknown;
};
type Prune = {
  olderThanDays: number;
  candidates: { id: string; title: string; agent?: string; updatedAt: number; group: boolean; purpose?: string }[];
  deleted: number;
  purged: number;
  failed: { id: string; error: string }[];
};

function age(ms: number): string {
  return duration(Math.max(0, Date.now() - ms));
}

export async function runThread(parsed: Parsed): Promise<void> {
  const [action = "list", target] = parsed.positional;

  if (action === "list") {
    const includeDeleted = has(parsed, "deleted");
    const sessions = await withDaemon((client) => client.request<Session[]>("sessions.list", { includeDeleted }));
    const days = numberFlag(parsed, "days");
    const stale = sessions.filter((session) => !session.deletedAt && days !== undefined && session.updatedAt < Date.now() - days * 86_400_000);
    const rows = has(parsed, "stale") || days !== undefined ? stale : sessions;
    if (has(parsed, "json")) {
      json(rows);
      return;
    }
    if (rows.length === 0) {
      print("no threads" + (days !== undefined ? " older than " + days + " days" : ""));
      return;
    }
    table(
      ["id", "title", "agent", "updated", "state"],
      rows.map((session) => [
        session.id,
        session.title.slice(0, 40),
        session.agent ?? "-",
        age(session.updatedAt),
        session.deletedAt ? paint("yellow", "deleted") : session.purpose ? session.purpose : session.room ? "group" : "active",
      ]),
    );
    return;
  }

  if (action === "prune") {
    const configured = await readConfig({ fresh: true });
    const days = numberFlag(parsed, "days") ?? configured.storage.pruneAfterDays;
    const purge = has(parsed, "purge");
    const dryRun = has(parsed, "dry-run");
    if (days < 1) fail("--days must be at least 1", 2);
    const preview = await withDaemon((client) =>
      client.request<Prune>("sessions.prune", { olderThanDays: days, dryRun: true, includePurpose: has(parsed, "include-purpose") }),
    );
    if (has(parsed, "json") && dryRun) {
      json(preview);
      return;
    }
    if (preview.candidates.length === 0) {
      if (has(parsed, "json")) json({ ...preview, deleted: 0, purged: 0 });
      else print("nothing older than " + days + " days");
      return;
    }
    if (!has(parsed, "json")) {
      print((purge ? paint("yellow", "purge") : "delete") + " " + preview.candidates.length + " thread(s) older than " + days + " days:");
      for (const candidate of preview.candidates.slice(0, 20)) {
        print("  " + candidate.id + "  " + candidate.title.slice(0, 50) + "  (" + age(candidate.updatedAt) + ")");
      }
      if (preview.candidates.length > 20) print(paint("dim", "  … " + (preview.candidates.length - 20) + " more"));
    }
    if (!dryRun) {
      if (!has(parsed, "yes")) {
        if (!interactive() || !(await confirm(purge ? "PURGE is irreversible. Continue?" : "Delete these threads?", false))) {
          fail("pass --yes to confirm", 4);
        }
      }
      const result = await withDaemon((client) =>
        client.request<Prune>("sessions.prune", {
          olderThanDays: days,
          purge,
          includePurpose: has(parsed, "include-purpose"),
        }),
      );
      if (has(parsed, "json")) {
        json(result);
      } else {
        print(paint("green", purge ? "purged " + result.purged : "deleted " + result.deleted) + (result.failed.length ? paint("red", " · " + result.failed.length + " failed") : ""));
        if (purge) print(paint("dim", "transcripts were exported to ~/.dura-file/exports first"));
      }
      if (purge && has(parsed, "vacuum")) {
        const cleanup = await withDaemon((client) => client.request<{ reclaimedBytes?: number }>("storage.cleanup"));
        if (!has(parsed, "json")) print(paint("green", "vacuumed") + " " + duration(0) + " · reclaimed " + String(cleanup.reclaimedBytes ?? 0) + " bytes");
      }
    }
    return;
  }

  if (action === "delete" || action === "restore") {
    if (!target) fail("usage: dura thread " + action + " <id>", 2);
    const result = await withDaemon((client) =>
      client.request<unknown>(action === "delete" ? "sessions.delete" : "sessions.restore", { id: target }),
    );
    print(result ? target + " " + (action === "delete" ? "deleted" : "restored") : "no thread " + target);
    return;
  }

  if (action === "purge-deleted") {
    const days = numberFlag(parsed, "days") ?? 0;
    if (!has(parsed, "yes")) fail("purge-deleted is irreversible; pass --yes", 4);
    const result = await withDaemon((client) => client.request<{ purged: number; failed: { id: string; error: string }[] }>("sessions.purgeDeleted", { olderThanDays: days }));
    const cleanup = await withDaemon((client) => client.request<{ reclaimedBytes?: number }>("storage.cleanup"));
    if (has(parsed, "json")) json({ ...result, reclaimedBytes: cleanup.reclaimedBytes ?? 0 });
    else print(paint("yellow", "purged") + " " + result.purged + " tombstone(s) · reclaimed " + String(cleanup.reclaimedBytes ?? 0) + " bytes");
    return;
  }

  if (action === "purge") {
    if (!target) fail("usage: dura thread purge <id> --yes", 2);
    if (!has(parsed, "yes")) fail("purge is irreversible; pass --yes", 4);
    const result = await withDaemon((client) => client.request<unknown>("sessions.purge", { id: target }));
    if (has(parsed, "json")) json(result);
    else print(paint("yellow", "purged") + " " + target + " (export written first)");
    return;
  }

  fail("usage: dura thread <list|prune|delete|restore|purge|purge-deleted>", 2);
}
