<script lang="ts">
  import { compactThread, loadModelGroups, setThreadModel, store } from "../state.svelte.ts";

  /**
   * The line under the composer: how much of the model's window this thread has used, and which model it is.
   * Both halves describe the same decision — what the next request will cost — so they sit together.
   */
  const info = $derived(store.context);
  const selected = $derived(info ? info.provider + "|" + info.modelId : "");
  const percent = $derived(
    info?.maxTokens ? Math.min(100, Math.round((info.usedTokens / info.maxTokens) * 100)) : 0,
  );
  /** Only while the request is in flight: the task itself is background work, not something to wait on. */
  let asking = $state(false);

  /** What every completed run in this thread adds up to. Derived from the run summaries, never a second log. */
  const totals = $derived.by(() => {
    let turns = 0;
    let tokens = 0;
    let cacheRead = 0;
    let durationMs = 0;
    for (const entry of store.entries) {
      if (!entry.run) continue;
      turns += entry.run.turns;
      tokens += entry.run.usage.totalTokens;
      cacheRead += entry.run.usage.cacheRead;
      durationMs += entry.run.durationMs;
    }
    return { turns, tokens, cacheRead, durationMs };
  });

  function seconds(ms: number): string {
    if (ms >= 60_000) return Math.floor(ms / 60_000) + "m " + Math.round((ms % 60_000) / 1000) + "s";
    return (ms / 1000).toFixed(1) + "s";
  }

  async function askCompact(): Promise<void> {
    if (asking) return;
    asking = true;
    try {
      await compactThread();
    } finally {
      asking = false;
    }
  }

  /** 12400 → "12.4k", 1_000_000 → "1.0M": the caption is a glance, not a report. */
  function compact(tokens: number): string {
    if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + "M";
    if (tokens >= 1_000) return (tokens / 1_000).toFixed(1) + "k";
    return String(tokens);
  }

  async function change(event: Event): Promise<void> {
    const [provider, ...rest] = (event.currentTarget as HTMLSelectElement).value.split("|");
    const modelId = rest.join("|");
    if (!provider || !modelId) return;
    await setThreadModel(provider, modelId);
  }

  // The provider list is the expensive half, so it is fetched once and kept for the tab.
  $effect(() => {
    void loadModelGroups();
  });
</script>

<div class="contextbar" data-testid="context-bar">
  {#if info}
    <span class="contextbar__usage" data-testid="context-usage" title="Tokens used of the model's window">
      {compact(info.usedTokens)}{#if info.maxTokens}&thinsp;/&thinsp;{compact(info.maxTokens)}{/if}
      {#if info.maxTokens}<span class="contextbar__pct">{percent}%</span>{/if}
    </span>
    {#if info.maxTokens}
      <span class="contextbar__meter" aria-hidden="true">
        <span class="contextbar__fill" style="transform: scaleX({percent / 100})"></span>
      </span>
    {/if}
  {/if}

  <button
    class="btn btn--small btn--ghost contextbar__action"
    type="button"
    onclick={askCompact}
    disabled={asking || !info}
    title="Rewrite this thread's context into a summary now"
    data-testid="compact-now"
  >
    {asking ? "Compacting…" : "Compact"}
  </button>

  {#if totals.turns > 0}
    <span
      class="contextbar__session"
      data-testid="session-usage"
      title={"This thread: " + totals.turns + " assistant turns · input/output/cache included · " + totals.tokens.toLocaleString("en-US") + " tokens"}
    >
      {compact(totals.tokens)} tok{#if totals.durationMs > 0} · {seconds(totals.durationMs)}{/if}{#if totals.cacheRead > 0} · {compact(totals.cacheRead)} cached{/if}
    </span>
  {/if}

  <label
    class="contextbar__model"
    title={info?.source === "agent"
      ? "Changing this changes the agent's model, so every thread of that agent follows"
      : "This thread's model"}
  >
    <span class="sr-only">Model</span>
    <select value={selected} onchange={change} data-testid="model-picker">
      {#each store.modelGroups as group (group.provider)}
        <optgroup label={group.provider}>
          {#each group.models as model (model.id)}
            <option value={group.provider + "|" + model.id}>{model.name}</option>
          {/each}
        </optgroup>
      {/each}
    </select>
  </label>
</div>