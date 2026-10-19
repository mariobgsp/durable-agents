<script lang="ts">
  import ActivityIndicator from "./ActivityIndicator.svelte";
  import ToolCallRow from "./ToolCallRow.svelte";
  import { elapsedText, phaseLabel, summaryOf } from "../lib/activity.ts";
  import type { Activity } from "../types.ts";

  /**
   * The round in flight: what it is doing, how long it has been doing it, and the calls it is making.
   *
   * Every number here is observed. The phase comes from the server's own derivation, the elapsed time counts
   * up from the run task's durable start (or is absent, never invented), and the counts are counts. Nothing is
   * a percentage, because nothing in `pi.live` reports how far a call has got.
   *
   * Motion: one sweep per running row while the round is small, and one round-level sweep instead once many
   * calls are in flight, which is the rule the roadmap locks.
   */
  let { activity, now }: { activity: Activity; now: number } = $props();

  const running = $derived(activity.counts.running + activity.counts.pending);
  /** Past three calls in flight the rows stop moving and the header carries the motion instead. */
  const perRowMotion = $derived(running <= 3);
  const summary = $derived(summaryOf(activity));
  const elapsed = $derived(elapsedText(activity.since, now));
</script>

{#if activity.calls.length > 0}
  <div class="tooltrace" data-testid="tool-trace">
    <header class="tooltrace__head">
      {#if perRowMotion}
        <span class="tooltrace__phase" data-testid="activity-phase">{phaseLabel(activity.phase)}</span>
      {:else}
        <ActivityIndicator
          phase={activity.phase}
          label={phaseLabel(activity.phase) + ": " + running + " calls in flight"}
        />
      {/if}
      {#if summary}<span class="tooltrace__summary">{summary}</span>{/if}
      {#if elapsed}<span class="tooltrace__time" data-testid="activity-elapsed">{elapsed}</span>{/if}
      {#if activity.queued.length > 0}
        <span class="tooltrace__queued" data-testid="activity-queued">
          {activity.queued.length} waiting
        </span>
      {/if}
    </header>
    {#each activity.calls as call (call.callId)}
      <ToolCallRow
        name={call.name}
        status={call.status}
        output={call.output ?? ""}
        isError={call.isError ?? false}
        nested={call.nested}
        sweep={perRowMotion && call.status !== "done"}
      />
    {/each}
  </div>
{/if}
