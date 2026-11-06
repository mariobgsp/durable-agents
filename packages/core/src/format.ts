/**
 * Small shared formatters.
 *
 * A chat surface, the fleet TUI and the CLI all print "how long ago" next to the same timestamps, so the
 * rounding rules live here: one place to change when a week-old thread should read "6d" rather than "144h".
 */

/** Coarse age in one token: `12s`, `4m`, `3h`, `6d`. */
export function shortAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.round(seconds / 60) + "m";
  if (seconds < 86_400) return Math.round(seconds / 3600) + "h";
  return Math.round(seconds / 86_400) + "d";
}
