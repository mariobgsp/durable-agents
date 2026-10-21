<script lang="ts">
  import type { RunSummary } from "../types.ts";

  let { run }: { run: RunSummary } = $props();

  function compact(tokens: number): string {
    if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + "M";
    if (tokens >= 1_000) return (tokens / 1_000).toFixed(1) + "k";
    return String(tokens);
  }

  function seconds(ms: number): string {
    if (ms < 1000) return Math.max(0, Math.round(ms)) + "ms";
    if (ms >= 60_000) {
      const minutes = Math.floor(ms / 60_000);
      const rest = Math.round((ms % 60_000) / 1000);
      return minutes + "m " + rest + "s";
    }
    return (ms / 1000).toFixed(1) + "s";
  }

  const title = $derived(
    "input " +
      run.usage.input.toLocaleString("en-US") +
      " · output " +
      run.usage.output.toLocaleString("en-US") +
      " · cache read " +
      run.usage.cacheRead.toLocaleString("en-US") +
      " · cache write " +
      run.usage.cacheWrite.toLocaleString("en-US") +
      (run.usage.cost > 0 ? " · cost $" + run.usage.cost.toFixed(4) : ""),
  );
</script>

<div class="runsummary" data-testid="run-summary" {title}>
  <span class="runsummary__time">
    {run.durationMs > 0 ? "Worked " + seconds(run.durationMs) : "Duration unavailable"}
  </span>
  <span class="runsummary__sep">·</span>
  <span>{run.usage.totalTokens.toLocaleString("en-US")} tokens</span>
  {#if run.usage.cacheRead > 0}
    <span class="runsummary__sep">·</span>
    <span>{compact(run.usage.cacheRead)} cached</span>
  {/if}
  {#if run.usage.cost > 0}
    <span class="runsummary__sep">·</span>
    <span>${run.usage.cost.toFixed(4)}</span>
  {/if}
</div>