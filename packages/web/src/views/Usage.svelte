<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../api.ts";
  import { identityOfAgent } from "../lib/identity.ts";
  import { store } from "../state.svelte.ts";
  import type { UsageReport } from "../types.ts";

  /**
   * Usage graphs. Everything is drawn with divs and one scaled span per bar — no chart library, so the view
   * weighs nothing, prints the same numbers the transcript recorded, and stays inside the monochrome system.
   */
  let report = $state<UsageReport | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      report = await api.usage();
    } catch (err) {
      error = String(err);
    }
  });

  function share(value: number, max: number): number {
    return max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  }

  function compact(tokens: number): string {
    if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + "M";
    if (tokens >= 1_000) return (tokens / 1_000).toFixed(1) + "k";
    return String(tokens);
  }

  /** Spend per thread is small, so four decimals is the honest unit. */
  function money(cost: number): string {
    return "$" + cost.toFixed(4);
  }

  function duration(ms: number | undefined): string {
    if (!ms) return "—";
    return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
  }

  /** An agent's own colour, so the bar and the sidebar agree about who is who. */
  function colorOf(id: string): string {
    const agent = store.agents.find((entry) => entry.id === id);
    return agent ? identityOfAgent(agent).color : "var(--muted)";
  }

  const maxTurns = $derived(Math.max(1, ...(report?.agents ?? []).map((agent) => agent.turns)));
  const maxTokens = $derived(Math.max(1, ...(report?.models ?? []).map((model) => model.tokens)));
  const maxCalls = $derived(Math.max(1, ...(report?.tools ?? []).map((tool) => tool.calls)));
  const maxDay = $derived(Math.max(1, ...(report?.days ?? []).map((day) => day.turns)));
</script>

<section class="page" data-testid="usage">
  <div class="page__head">
    <h1 class="page__title">Usage</h1>
    {#if report}
      <span class="hint">
        {report.totals.sessions} threads · {report.totals.turns} answers · every number read from the durable log
      </span>
    {/if}
  </div>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if report}
    <div class="usage__stats">
      {#each [
        { label: "Answers", value: String(report.totals.turns) },
        { label: "Tokens", value: compact(report.totals.tokens) },
        { label: "Spend", value: money(report.totals.cost) },
        { label: "Tool calls", value: String(report.totals.toolCalls) },
      ] as stat (stat.label)}
        <div class="usage__stat">
          <span class="usage__stat-value">{stat.value}</span>
          <span class="usage__stat-label">{stat.label}</span>
        </div>
      {/each}
    </div>

    <h2 class="usage__head">Agents <span class="usage__head-note">answers per agent</span></h2>
    {#if report.agents.length === 0}
      <p class="empty">No agent has answered yet.</p>
    {:else}
      <div class="usage__chart" data-testid="usage-agents">
        {#each report.agents as agent (agent.id)}
          <div class="usage__row">
            <span class="usage__label" title={agent.id}>{agent.name}</span>
            <span class="usage__track">
              <span
                class="usage__bar"
                style="width: {share(agent.turns, maxTurns)}%; background: {colorOf(agent.id)}"
              ></span>
            </span>
            <span class="usage__value">{agent.turns}</span>
            <span class="usage__sub">{compact(agent.tokens)} tok · {money(agent.cost)}</span>
          </div>
        {/each}
      </div>
    {/if}

    <h2 class="usage__head">Models <span class="usage__head-note">tokens per model</span></h2>
    <div class="usage__chart" data-testid="usage-models">
      {#each report.models as model (model.provider + "/" + model.modelId)}
        <div class="usage__row">
          <span class="usage__label" title="{model.provider}/{model.modelId}">{model.modelId}</span>
          <span class="usage__track">
            <span class="usage__bar usage__bar--paper" style="width: {share(model.tokens, maxTokens)}%"></span>
          </span>
          <span class="usage__value">{compact(model.tokens)}</span>
          <span class="usage__sub">{model.turns} turns · {money(model.cost)}</span>
        </div>
      {/each}
    </div>

    <h2 class="usage__head">Activity <span class="usage__head-note">answers per day, last 14 days</span></h2>
    {#if report.days.length === 0}
      <p class="empty">Nothing recorded yet.</p>
    {:else}
      <div class="usage__days" data-testid="usage-days">
        {#each report.days as day (day.date)}
          <div class="usage__day" title="{day.date}: {day.turns} answers, {compact(day.tokens)} tokens">
            <span class="usage__day-bar" style="transform: scaleY({share(day.turns, maxDay) / 100})"></span>
            <span class="usage__day-label">{day.date.slice(5)}</span>
          </div>
        {/each}
      </div>
    {/if}

    <h2 class="usage__head">Tools <span class="usage__head-note">calls per tool</span></h2>
    {#if report.tools.length === 0}
      <p class="empty">No tool has run yet.</p>
    {:else}
      <div class="usage__chart" data-testid="usage-tools">
        {#each report.tools as tool (tool.name)}
          <div class="usage__row">
            <span class="usage__label">{tool.name}</span>
            <span class="usage__track">
              <span class="usage__bar usage__bar--paper" style="width: {share(tool.calls, maxCalls)}%"></span>
            </span>
            <span class="usage__value">{tool.calls}</span>
            <span class="usage__sub">
              {duration(tool.avgMs)} avg{#if tool.errors > 0}<span class="usage__bad"> · {tool.errors} failed</span>{/if}
            </span>
          </div>
        {/each}
      </div>
    {/if}
  {:else if !error}
    <p class="empty">Loading…</p>
  {/if}
</section>
