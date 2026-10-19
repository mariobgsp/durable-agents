import type { Activity, RunPhase } from "../types.ts";

/**
 * How the round's status is presented: pure functions, no state.
 *
 * The phase itself is computed on the server from `pi.live` and is never re-derived here. What this module
 * decides is which indicator to show, what to call the phase, and how to write an elapsed time — the one
 * decision point for "at most one indicator per frame" (checklist item 12).
 */

export type ActivityRender = "none" | "bubble" | "strip";

/**
 * Which indicator this frame gets.
 *
 * The strip wins whenever the round has calls to list, because it already states the phase; the bubble
 * appears only when there is nothing else to look at. "none" whenever nothing is running, which is what keeps
 * an idle frame completely still.
 */
export function activityRender(input: {
  replying: boolean;
  live: boolean;
  activity: Activity;
  group: boolean;
}): ActivityRender {
  if (input.activity.calls.length > 0) return "strip";
  if (input.activity.phase !== null) return "bubble";
  // A group's own conversation never generates, so a room has no phase: presence and the typing entries are
  // the whole truth there, and they still deserve the placeholder bubble.
  if (input.group && input.replying) return "bubble";
  if (input.live) return "none";
  return input.replying ? "bubble" : "none";
}

/** The phase word. English only, and never a claim the server did not make. */
export function phaseLabel(phase: RunPhase | null): string {
  switch (phase) {
    case "starting":
      return "Starting";
    case "thinking":
      return "Thinking";
    case "writing":
      return "Writing";
    case "tool":
      return "Using a tool";
    case "compacting":
      return "Summarising the context";
    case "retrying":
      return "Retrying after an error";
    default:
      return "Working";
  }
}

/** "4.2s" / "1m 05s", from the run's own start. Empty when the server could not observe a start. */
export function elapsedText(since: number | null, now: number): string {
  if (since === null) return "";
  const seconds = Math.max(0, (now - since) / 1000);
  if (seconds < 60) return seconds.toFixed(1) + "s";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return minutes + "m " + String(rest).padStart(2, "0") + "s";
}

/** "2 running · 1 done · 12 nested": only the parts that are true, so a quiet round says nothing. */
export function summaryOf(activity: Activity): string {
  const parts: string[] = [];
  if (activity.counts.running > 0) parts.push(activity.counts.running + " running");
  if (activity.counts.pending > 0) parts.push(activity.counts.pending + " queued");
  if (activity.counts.done > 0) parts.push(activity.counts.done + " done");
  if (activity.counts.nested > 0) parts.push(activity.counts.nested + " nested");
  return parts.join(" · ");
}
