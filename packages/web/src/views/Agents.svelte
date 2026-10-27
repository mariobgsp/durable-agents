<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../api.ts";
  import type { FleetAgent, FleetLink, UsageReport } from "../types.ts";
  import { go } from "../router.svelte.ts";
  import { createSession, loadAgents, loadFleet, store } from "../state.svelte.ts";
  import { identityOfAgent, identityOfAuthor } from "../lib/identity.ts";
  import { relativeTime } from "../lib/time.ts";
  import AgentAvatar from "../components/AgentAvatar.svelte";
  import FleetBubbles from "./FleetBubbles.svelte";

  /**
   * The fleet has two views of one snapshot: a live bubble field and the compact roster with the recent
   * agent-to-agent batches. Bubbles are the default; List remains one click away and is deliberately
   * unchanged, including token totals and the link feed. There is no kanban: state is reported by the server,
   * so a lane would only invite a drag that cannot be true.
   */
  type View = "bubbles" | "list";
  const VIEW_KEY = "durable-agents.agents-view";

  function savedView(): View {
    try {
      const value = localStorage.getItem(VIEW_KEY);
      if (value === "bubbles" || value === "list") return value;
    } catch {
      /* A private window may refuse storage; the default is still usable. */
    }
    return "bubbles";
  }

  function initialView(): View {
    const forced = new URLSearchParams(location.search).get("view");
    // "board" is the old deep link the screenshot gate and saved tabs still carry; it now means bubbles.
    if (forced === "board" || forced === "bubbles") return "bubbles";
    if (forced === "list") return "list";
    return savedView();
  }

  let view = $state<View>(initialView());

  /**
   * Remember the choice and keep the URL honest. The query is what the screenshot gate and a shared link
   * use; the saved value is what a normal navigation returns to.
   */
  function setView(next: View): void {
    view = next;
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* Storage is a preference, not a requirement. */
    }
    const url = new URL(location.href);
    if (next === "list") url.searchParams.set("view", "list");
    else url.searchParams.delete("view");
    history.replaceState(null, "", url);
  }

  let usage = $state<UsageReport | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);
  // The board's first paint should say it is reading, not that the fleet is unavailable for one frame.
  let refreshing = $state(true);

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
      else if (!agentsOk) error = "Could not read the agent list. The server may be starting.";
      else if (!fleetOk) error = "Could not read the live fleet. Refresh to try again.";
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

  /** Today's tokens for the bubble's fact row; null while the report is still loading. */
  function todayOf(id: string): number | null {
    return usageOf(id)?.today.tokens ?? null;
  }

  function compact(tokens: number): string {
    if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + "M";
    if (tokens >= 1_000) return (tokens / 1_000).toFixed(1) + "k";
    return String(tokens);
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

<section class="page" data-testid="fleet" data-view={view}>
  <header class="page__head fleet-head">
    <h2 class="page__title">Fleet</h2>
    <div class="row">
      <div class="view-switch" role="group" aria-label="Fleet view">
        <button
          class="btn btn--small"
          class:btn--active={view === "bubbles"}
          aria-pressed={view === "bubbles"}
          onclick={() => setView("bubbles")}
          data-testid="agents-view-bubbles"
        >
          Bubbles
        </button>
        <button
          class="btn btn--small"
          class:btn--active={view === "list"}
          aria-pressed={view === "list"}
          onclick={() => setView("list")}
          data-testid="agents-view-list"
        >
          List
        </button>
      </div>
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

  {#if view === "bubbles"}
    <FleetBubbles {refreshing} startBusy={busy} onStart={startSession} tokens={todayOf} />
  {:else}
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
              Last active {relativeTime(live.lastActiveAt)}
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
              Next cron {relativeTime(live.schedules.nextRunAt)} · {live.schedules.nextName}
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
            <span class="linkfeed__time">{relativeTime(batch.at)}</span>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</section>
