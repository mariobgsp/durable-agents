<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../api.ts";
  import type { FleetAgent, FleetLink, UsageReport } from "../types.ts";
  import { go } from "../router.svelte.ts";
  import { createSession, loadAgents, loadFleet, store } from "../state.svelte.ts";
  import { identityOfAgent, identityOfAuthor } from "../lib/identity.ts";
  import AgentAvatar from "../components/AgentAvatar.svelte";

  /**
   * The fleet: every agent as one compact row, plus the last few agent-to-agent batches. The live status
   * comes from the presence socket; token totals come from the cached usage report and never trigger a
   * transcript scan of their own.
   */
  let usage = $state<UsageReport | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let refreshing = $state(false);

  /**
   * Reload the two lists the page is built from. Agents can be created or edited in another view, so this
   * must not be conditional on the store being empty: a stale list is exactly the bug that hiding behind a
   * first-load check produces.
   */
  async function refresh(): Promise<void> {
    refreshing = true;
    error = null;
    try {
      const [agentsOk, fleetOk] = await Promise.all([loadAgents(), loadFleet()]);
      if (!agentsOk && !fleetOk) error = "Could not refresh agents. The server may be starting.";
      try {
        usage = await api.usage();
      } catch {
        /* A usage failure leaves the existing numbers in place; it is not an agent-list failure. */
      }
    } finally {
      refreshing = false;
    }
  }

  onMount(() => {
    void refresh();
  });

  const fleet = $derived(store.fleet);

  function rowOf(id: string): FleetAgent | null {
    return fleet?.agents.find((agent) => agent.id === id) ?? null;
  }

  function usageOf(id: string) {
    return usage?.agents.find((agent) => agent.id === id) ?? null;
  }

  function compact(tokens: number): string {
    if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + "M";
    if (tokens >= 1_000) return (tokens / 1_000).toFixed(1) + "k";
    return String(tokens);
  }

  function relative(timestamp: number | undefined): string {
    if (!timestamp) return "never";
    const delta = timestamp - Date.now();
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

  async function startSession(agentId: string, name: string): Promise<void> {
    busy = true;
    const session = await createSession("Thread · " + name, agentId);
    busy = false;
    if (session) go("#/s/" + session.id);
  }

  type Batch = {
    id: string;
    from: string;
    kind: "message" | "delegate";
    links: FleetLink[];
    active: boolean;
    status: string;
    at: number;
  };

  const batches = $derived.by(() => {
    const map = new Map<string, Batch>();
    for (const link of fleet?.links ?? []) {
      const current = map.get(link.batchId) ?? {
        id: link.batchId,
        from: link.from,
        kind: link.kind,
        links: [],
        active: false,
        status: "sent",
        at: link.createdAt,
      };
      current.links.push(link);
      current.active = current.active || link.active;
      current.at = Math.max(current.at, link.updatedAt);
      map.set(link.batchId, current);
    }
    const out = [...map.values()];
    for (const batch of out) {
      if (batch.active) batch.status = "working";
      else if (batch.links.every((link) => link.status === "answered")) batch.status = "answered";
      else if (batch.links.some((link) => link.status === "failed")) batch.status = "failed";
      else batch.status = "sent";
      batch.links.sort((a, b) => a.to.localeCompare(b.to));
    }
    return out.sort((a, b) => b.at - a.at).slice(0, 8);
  });

  function targetIdentity(id: string) {
    return identityOfAuthor(id, store.agents);
  }
</script>

<section class="page" data-testid="fleet">
  <header class="page__head fleet-head">
    <h2 class="page__title">Fleet</h2>
    <div class="row">
      <button class="btn btn--small" disabled={refreshing} onclick={() => refresh()} data-testid="fleet-refresh">
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
      {#if fleet}
        <span class="hint" data-testid="fleet-summary">
          {fleet.totals.agents} agents · {fleet.totals.working} working · {fleet.totals.idle} idle{#if fleet.totals.disabled > 0}
            · {fleet.totals.disabled} disabled{/if}
        </span>
      {/if}
      <button class="btn btn--primary" onclick={() => go("#/agents/new")} data-testid="new-agent">
        New agent<span class="btn__icon">+</span>
      </button>
    </div>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <div class="fleet" data-testid="agent-list">
    {#each store.agents as agent (agent.id)}
      {@const identity = identityOfAgent(agent)}
      {@const live = rowOf(agent.id)}
      {@const spend = usageOf(agent.id)}
      <article class="fleet-card" data-testid="fleet-card-{agent.id}">
        <div class="fleet-card__identity">
          <AgentAvatar {identity} size="md" />
          <div class="fleet-card__name">
            <b>{identity.label}</b>
            <span>@{agent.id}</span>
          </div>
          <span
            class="fleet-status fleet-status--{live?.status ?? (agent.enabled === false ? 'disabled' : 'idle')}"
            data-status={live?.status ?? "idle"}
            data-testid="fleet-status-{agent.id}"
          >
            <span class="fleet-status__dot"></span>
            {live?.status ?? "idle"}
          </span>
        </div>

        <p class="fleet-card__line">
          {agent.responsibility || "No responsibility set."}
        </p>

        <p class="fleet-card__meta">
          {agent.provider}/{agent.modelId} · {live?.mesh ?? agent.mesh ?? "full"} mesh ·
          {live?.policy.tier ?? agent.permissions ?? "standard"}
        </p>

        <p class="fleet-card__live">
          {#if live?.currentThread}
            <a href="#/s/{live.currentThread.id}">Working: {live.currentThread.title}</a>
            {#if live.activeThreads.length > 1}<span class="hint">+{live.activeThreads.length - 1} more</span>{/if}
          {:else if live?.lastActiveAt}
            Last active {relative(live.lastActiveAt)}
          {:else}
            No activity yet
          {/if}
        </p>

        <div class="fleet-card__stats">
          <span><b>{spend ? compact(spend.today.tokens) : "—"}</b> today</span>
          <span><b>{spend ? compact(spend.all.tokens) : "—"}</b> all time</span>
          <span><b>{live ? live.links.inbound + live.links.outbound : 0}</b> links</span>
        </div>

        <p class="fleet-card__cron">
          {#if live?.schedules.nextRunAt}
            Next cron {relative(live.schedules.nextRunAt)} · {live.schedules.nextName}
          {:else if live && live.schedules.total > 0}
            {live.schedules.total} schedules · none enabled
          {:else}
            No cron schedule
          {/if}
        </p>

        <div class="fleet-card__actions">
          <button
            class="btn btn--small"
            disabled={busy || agent.enabled === false}
            title={agent.enabled === false ? "This agent is disabled" : "Start a new thread"}
            onclick={() => startSession(agent.id, agent.name)}
          >
            {live?.currentThread ? "New thread" : "Start thread"}
          </button>
          {#if live?.currentThread}
            <button class="btn btn--small" onclick={() => go("#/s/" + live.currentThread?.id)}>Open</button>
          {/if}
          <button class="btn btn--small btn--ghost" onclick={() => go("#/agents/" + agent.id)}>Edit</button>
        </div>
      </article>
    {:else}
      <p class="empty">
        No agents yet. Click <b>+ New agent</b> and fill in <b>AGENT.md</b> (working rules) and
        <b>SOUL.md</b> (who it is and what it owns).
      </p>
    {/each}
  </div>

  <h2 class="usage__head">Agent links <span class="usage__head-note">most recent batches</span></h2>
  {#if batches.length === 0}
    <p class="empty">No agent has messaged another yet. They can use agents_message or agents_delegate.</p>
  {:else}
    <div class="linkfeed" data-testid="fleet-links">
      {#each batches as batch (batch.id)}
        {@const from = identityOfAuthor(batch.from, store.agents)}
        <div class="linkfeed__row" class:linkfeed__row--active={batch.active} data-testid="fleet-link-{batch.id}">
          <span class="linkfeed__from" style="--author: {from.color}">
            <AgentAvatar identity={from} size="sm" />
            {from.label}
          </span>
          <span class="linkfeed__arrow">→</span>
          <span class="linkfeed__targets">
            {#each batch.links as link (link.id)}
              {@const target = targetIdentity(link.to)}
              <a class="chip chip--link" href="#/s/{link.threadId}" title={link.error ?? link.preview ?? ""}>
                <span class="fleet-status__dot" style="background: {target.color}"></span>
                {target.label}
                {#if link.status === "failed"}<span class="usage__bad">failed</span>{/if}
              </a>
            {/each}
          </span>
          <span class="linkfeed__kind">{batch.kind}</span>
          <span class="linkfeed__status" class:linkfeed__status--active={batch.active}>{batch.status}</span>
          <span class="linkfeed__time">{relative(batch.at)}</span>
        </div>
      {/each}
    </div>
  {/if}
</section>