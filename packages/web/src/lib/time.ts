/**
 * Relative time for UI labels, in one place.
 *
 * The list and the board both say "Last active 3m ago" and "Next cron in 2h"; two copies would eventually
 * disagree about the boundary between minutes, hours and days. A missing timestamp says "never", which is the
 * same word the fleet has always used.
 */
export function relativeTime(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return "never";
  const delta = timestamp - now;
  const future = delta > 0;
  const size = Math.abs(delta);
  const value =
    size < 60_000
      ? Math.max(1, Math.round(size / 1000)) + "s"
      : size < 3_600_000
        ? Math.round(size / 60_000) + "m"
        : size < 86_400_000
          ? Math.round(size / 3_600_000) + "h"
          : Math.round(size / 86_400_000) + "d";
  return future ? "in " + value : value + " ago";
}
