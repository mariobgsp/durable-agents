import { readConfig } from "./config.ts";
import { errorFields, log } from "./logger.ts";
import { purgeDeletedSessions, pruneSessions } from "./sessions.ts";
import { cleanupStorage } from "./storage.ts";

/**
 * Storage retention for an 8 GB host: hide threads after three days, free the rows and artifacts of
 * hidden threads after another three, then vacuum. Both phases read the index once and write it
 * once; purge processes one transcript at a time. Runs at boot and every intervalHours.
 */
let timer: NodeJS.Timeout | undefined;

export type RetentionResult = {
  pruned: number;
  purged: number;
  reclaimedBytes: number;
  failed: number;
};

export async function runRetention(): Promise<RetentionResult> {
  const config = await readConfig({ fresh: true });
  const empty: RetentionResult = { pruned: 0, purged: 0, reclaimedBytes: 0, failed: 0 };
  if (!config.storage.auto) return empty;
  const pruned = await pruneSessions({ olderThanDays: config.storage.pruneAfterDays });
  const purged = await purgeDeletedSessions(config.storage.purgeAfterDays);
  let reclaimedBytes = 0;
  if (purged.purged > 0) reclaimedBytes = await cleanupStorage().then((result) => result.reclaimedBytes).catch(() => 0);
  const result: RetentionResult = {
    pruned: pruned.deleted,
    purged: purged.purged,
    reclaimedBytes,
    failed: pruned.failed.length + purged.failed.length,
  };
  if (result.pruned > 0 || result.purged > 0) {
    log.info("retention.run", result);
  }
  return result;
}

export function startRetention(): void {
  if (timer) return;
  void runRetention().catch((error) => log.warn("retention.failed", errorFields(error)));
  const hours = Number(process.env.DURA_RETENTION_HOURS ?? 6);
  timer = setInterval(() => {
    void runRetention().catch((error) => log.warn("retention.failed", errorFields(error)));
  }, Math.max(1, hours) * 3_600_000);
  timer.unref?.();
}

export function stopRetention(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
