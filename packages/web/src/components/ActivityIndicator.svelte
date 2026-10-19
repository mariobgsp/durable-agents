<script lang="ts">
  import TypingDots from "./TypingDots.svelte";
  import { phaseLabel } from "../lib/activity.ts";
  import type { RunPhase } from "../types.ts";

  /**
   * "This thread is working", in one component.
   *
   * With a phase from the server it states the phase and moves one indeterminate sweep; without one it is the
   * breathing dots, which claim only what presence already proves. One component means the sidebar and the
   * chat cannot disagree about a thread (checklist item 12).
   *
   * The motion is indeterminate on purpose: nothing in `pi.live` reports how far a call has got, so any shape
   * whose position could be read as progress would be a lie. Under `prefers-reduced-motion` the global rule in
   * `app.css` removes it, and the label still says the same thing in words.
   */
  let {
    phase = null,
    label,
    size = "md",
    showLabel = true,
    elapsed = "",
  }: {
    /** The phase the server reported, or null when it reported none. */
    phase?: RunPhase | null;
    /** Read aloud by assistive tech, and used as the tooltip. */
    label: string;
    size?: "xs" | "sm" | "md";
    /** False where the phase is already stated next to this, so the wording is not printed twice. */
    showLabel?: boolean;
    /** "4.2s", or empty when the server could not observe a start. Shown beside the phase word. */
    elapsed?: string;
  } = $props();
</script>

{#if phase === null}
  <TypingDots {label} {size} />
{:else}
  <span class="activity activity--{size}" role="status" aria-live="polite" title={label}>
    <span class="activity__sweep" aria-hidden="true"></span>
    {#if showLabel}<span class="activity__label">{phaseLabel(phase)}</span>{/if}
    {#if elapsed}<span class="activity__time" data-testid="activity-elapsed">{elapsed}</span>{/if}
    <span class="sr-only">{label}</span>
  </span>
{/if}
