<script lang="ts">
  let {
    name,
    status = "done",
    output = "",
    isError = false,
    durationMs,
    nested,
    sweep = false,
    variant = "strip",
  }: {
    name: string;
    status?: "pending" | "running" | "done";
    /** Running output while a call is in flight, or the result's gist once it is finished. */
    output?: string;
    isError?: boolean;
    durationMs?: number;
    nested?: number;
    /** Whether this row may move. The strip turns it off once many calls are in flight at once. */
    sweep?: boolean;
    /** "strip" is a row inside the live trace; "inline" is one line in the transcript below it. */
    variant?: "strip" | "inline";
  } = $props();

  /**
   * A row is always one line. While a call runs the newest output is the interesting part; once it is
   * finished the first line of the result is, so the two readings differ on purpose.
   */
  function pick(text: string, last: boolean): string {
    const lines = text.split("\n").filter((entry) => entry.trim() !== "");
    return ((last ? lines.at(-1) : lines[0]) ?? "").trim();
  }

  const line = $derived(pick(output, status !== "done"));
  const state = $derived(
    status === "pending" ? "queued" : status === "running" ? "" : isError ? "failed" : "done",
  );
  const duration = $derived(
    durationMs === undefined
      ? ""
      : durationMs < 1000
        ? durationMs + "ms"
        : (durationMs / 1000).toFixed(1) + "s",
  );

  function nestedLabel(count: number): string {
    return count === 1 ? "1 nested call" : count + " nested calls";
  }

  /** Read aloud by assistive tech; the dot and the state word are visual shorthand. */
  function spoken(): string {
    if (status === "pending") return name + " is queued";
    if (status === "running") return name + " is running";
    const ended = isError ? " failed" : " finished";
    return name + ended + (duration ? " in " + duration : "");
  }
</script>

<div
  class="toolcall toolcall--{status}{isError ? ' toolcall--error' : ''} toolcall--{variant}"
  data-testid="tool-call"
>
  <span class="toolcall__dot" aria-hidden="true"></span>
  <span class="toolcall__name">{name}</span>
  {#if nested}
    <span class="toolcall__nested" title={nestedLabel(nested)}>{nested}&thinsp;&times;</span>
  {/if}
  {#if state}
    <span class="toolcall__state toolcall__state--{isError ? 'error' : 'ok'}">{state}</span>
  {/if}
  {#if duration}
    <span class="toolcall__time">{duration}</span>
  {/if}
  {#if sweep}
    <span class="toolcall__sweep" aria-hidden="true"></span>
  {/if}
  <span class="toolcall__output" title={output}>{line}</span>
  <span class="sr-only">{spoken()}</span>
</div>
