<script lang="ts">
  import { onDestroy } from "svelte";
  import type { FleetAgent } from "../types.ts";
  import { go } from "../router.svelte.ts";
  import { setAgentEnabled, store } from "../state.svelte.ts";
  import { identityOfAgent } from "../lib/identity.ts";
  import { relativeTime } from "../lib/time.ts";
  import { elapsedText } from "../lib/activity.ts";
  import AgentAvatar from "../components/AgentAvatar.svelte";

  /**
   * The fleet as a bubble field: one bubble per agent, and the bubble itself carries the whole state.
   *
   * Working, Idle and Disabled are not lanes a card can be dropped into — they are reported by the server's
   * activity registry and by the agent's own enabled flag. That is why the shape encodes state instead of
   * the position: a bubble that is bright and breathing is generating right now, a dimmed one accepted no new
   * work, and nothing here can disagree with the roster. Availability stays a plain button, so it works on a
   * phone, with a keyboard, and for a screen reader.
   */
  type Phase = "working" | "idle" | "disabled";

  let {
    refreshing = false,
    startBusy = false,
    onStart,
    tokens,
  }: {
    refreshing?: boolean;
    startBusy?: boolean;
    onStart: (agentId: string, name: string) => Promise<void> | void;
    /** Today's tokens for one agent, or null while the usage report is still loading. */
    tokens?: (id: string) => number | null;
  } = $props();

  let query = $state("");
  let notice = $state<string | null>(null);
  let busyId = $state<string | null>(null);
  let now = $state(Date.now());
  let noticeTimer: number | undefined;

  const fleet = $derived(store.fleet);
  const rows = $derived(fleet?.agents ?? []);
  const needle = $derived(query.trim().toLowerCase());

  function matches(row: FleetAgent): boolean {
    if (needle.length === 0) return true;
    return [row.name, row.id, row.responsibility ?? "", row.model.provider + "/" + row.model.modelId].some(
      (value) => value.toLowerCase().includes(needle),
    );
  }

  function phaseOf(row: FleetAgent): Phase {
    // Disabled wins over an in-flight run: the owner asked for no new work, and the bubble has to say so even
    // while the current answer finishes.
    if (!row.enabled) return "disabled";
    return row.status === "working" || row.activeThreads.length > 0 ? "working" : "idle";
  }

  const visible = $derived.by(() => {
    const order = { working: 0, idle: 1, disabled: 2 } as const;
    return rows
      .filter(matches)
      .toSorted((a, b) => {
        const byPhase = order[phaseOf(a)] - order[phaseOf(b)];
        if (byPhase !== 0) return byPhase;
        // Longest-running first, then most recently active, then by name: the bubble to look at comes first.
        if (phaseOf(a) === "working") return (a.since ?? 0) - (b.since ?? 0) || a.name.localeCompare(b.name);
        if (phaseOf(a) === "idle") return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || a.name.localeCompare(b.name);
        return a.name.localeCompare(b.name);
      });
  });

  const counts = $derived.by(() => {
    const out: Record<Phase, number> = { working: 0, idle: 0, disabled: 0 };
    for (const row of rows) out[phaseOf(row)] += 1;
    return out;
  });

  const oldest = $derived(
    rows
      .filter((row) => phaseOf(row) === "working" && typeof row.since === "number")
      .toSorted((a, b) => (a.since ?? 0) - (b.since ?? 0))[0] ?? null,
  );

  const hasActiveWork = $derived(rows.some((row) => row.activeThreads.length > 0));

  // One clock for every elapsed label, and only while something is running. An idle fleet is completely
  // still: no timer, no repaint. A hidden tab skips the write but keeps its place for the next visible tick.
  $effect(() => {
    if (!hasActiveWork) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) now = Date.now();
    }, 1000);
    return () => window.clearInterval(timer);
  });

  onDestroy(() => {
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
  });

  function say(text: string): void {
    notice = text;
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      notice = null;
      noticeTimer = undefined;
    }, 5000);
  }

  async function apply(row: FleetAgent): Promise<void> {
    if (busyId !== null) return;
    busyId = row.id;
    const next = !row.enabled;
    const ok = await setAgentEnabled(row.id, next);
    busyId = null;
    if (!ok) {
      say("Could not change @" + row.id + ". The bubble stayed as it was.");
      return;
    }
    say(
      next
        ? "@" + row.id + " is enabled again."
        : "New threads are disabled for @" + row.id + ". A run already in flight continues.",
    );
  }

  function threadOf(row: FleetAgent) {
    return row.currentThread ?? row.activeThreads[0] ?? null;
  }

  function compact(value: number | null): string {
    if (value === null) return "—";
    if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M";
    if (value >= 1_000) return (value / 1_000).toFixed(1) + "k";
    return String(value);
  }

  function stateWord(phase: Phase): string {
    if (phase === "working") return "working";
    if (phase === "disabled") return "disabled";
    return "idle";
  }
</script>

<div class="bubble-tools">
  <label class="bubble-filter">
    <span class="sr-only">Filter agents</span>
    <input
      class="search"
      type="search"
      placeholder="Filter agents…"
      autocomplete="off"
      aria-label="Filter agents"
      bind:value={query}
      data-testid="bubble-filter"
    />
  </label>

  <p class="bubble-legend" data-testid="bubble-legend">
    {#if counts.working > 0}
      <span class="bubble-legend__item bubble-legend__item--working" data-testid="bubble-count-working">
        <span class="fleet-status__dot"></span>
        {counts.working} working{#if oldest?.since}
          <span class="bubble-legend__longest">· longest {elapsedText(oldest.since, now)}</span>{/if}
      </span>
    {/if}
    <span class="bubble-legend__item" data-testid="bubble-count-idle">
      <span class="fleet-status__dot"></span>
      {counts.idle} idle
    </span>
    {#if counts.disabled > 0}
      <span class="bubble-legend__item bubble-legend__item--disabled" data-testid="bubble-count-disabled">
        <span class="fleet-status__dot"></span>
        {counts.disabled} disabled
      </span>
    {/if}
    {#if fleet}
      <span class="bubble-legend__item bubble-legend__item--muted">
        {fleet.totals.activeLinks} active {fleet.totals.activeLinks === 1 ? "link" : "links"}
      </span>
    {/if}
    {#if needle.length > 0}
      <span class="bubble-legend__item bubble-legend__item--muted" data-testid="bubble-count">{visible.length} of
        {rows.length}</span>
    {/if}
  </p>
</div>

{#if notice}
  <p class="bubble-notice" role="status" data-testid="bubble-notice">{notice}</p>
{/if}

{#if !fleet}
  <p class="empty" data-testid="bubble-unavailable">
    {refreshing ? "Reading the fleet…" : "The live fleet is unavailable. Press Refresh, or switch to List."}
  </p>
{:else if rows.length === 0}
  <p class="empty" data-testid="bubble-empty">
    No agents yet. Click <b>+ New agent</b> and fill in <b>AGENT.md</b> (working rules) and
    <b>SOUL.md</b> (who it is and what it owns).
  </p>
{:else if visible.length === 0}
  <p class="empty" data-testid="bubble-no-match">No agents match “{query.trim()}”.</p>
{:else}
  <div class="bubbles" data-testid="fleet-bubbles" role="list">
    {#each visible as row (row.id)}
      {@const identity = identityOfAgent(row)}
      {@const phase = phaseOf(row)}
      {@const current = threadOf(row)}
      {@const worked = elapsedText(row.since, now)}
      <article
        class="bubble bubble--{phase}"
        class:bubble--finishing={!row.enabled && row.activeThreads.length > 0}
        class:bubble--busy={busyId === row.id}
        data-phase={phase}
        data-status={row.status}
        data-testid="bubble-{row.id}"
        role="listitem"
        style="--bubble-color: {identity.color}"
      >
        <header class="bubble__head">
          <span class="bubble__avatar">
            <AgentAvatar {identity} size="md" />
          </span>
          <span class="bubble__id">
            <b>{identity.label}</b>
            <span>@{row.id}</span>
          </span>
          <span
            class="fleet-status fleet-status--{row.status}"
            data-status={row.status}
            data-testid="bubble-status-{row.id}"
          >
            <span class="fleet-status__dot"></span>
            {stateWord(phase)}
          </span>
        </header>

        <p class="bubble__line">{row.responsibility || "No responsibility set."}</p>

        <p class="bubble__live" data-testid="bubble-live-{row.id}">
          {#if current && row.activeThreads.length > 0}
            <a href="#/s/{current.id}" title={current.title}>
              {row.enabled ? "Working on" : "Finishing"}: {current.title}
            </a>
            {#if worked}<span class="bubble__elapsed">{worked}</span>{/if}
            {#if row.activeThreads.length > 1}
              <span class="bubble__more">+{row.activeThreads.length - 1}</span>
            {/if}
          {:else if phase === "disabled"}
            <span>No new threads. A run in flight still finishes.</span>
          {:else if row.lastActiveAt}
            <span>Last active {relativeTime(row.lastActiveAt)}</span>
          {:else}
            <span>No activity yet.</span>
          {/if}
        </p>

        <dl class="bubble__facts">
          <div>
            <dt>threads</dt>
            <dd>{row.threadCount}</dd>
          </div>
          <div>
            <dt>links</dt>
            <dd>{row.links.active}<span class="bubble__of">/{row.links.inbound + row.links.outbound}</span></dd>
          </div>
          <div>
            <dt>cron</dt>
            <dd>{row.schedules.enabled}<span class="bubble__of">/{row.schedules.total}</span></dd>
          </div>
          <div>
            <dt>today</dt>
            <dd>{compact(tokens ? tokens(row.id) : null)}</dd>
          </div>
        </dl>

        <p class="bubble__meta">
          <span>{row.model.provider}/{row.model.modelId}</span>
          <span>{row.policy.tier}</span>
          <span>{row.mesh} mesh</span>
        </p>

        <p class="bubble__cron">
          {#if row.schedules.nextRunAt}
            Next cron {relativeTime(row.schedules.nextRunAt)} · {row.schedules.nextName ?? "schedule"}
          {:else if row.schedules.total > 0}
            {row.schedules.total} schedules · none enabled
          {:else}
            No cron schedule
          {/if}
        </p>

        <div class="bubble__actions">
          {#if current && row.activeThreads.length > 0}
            <button
              class="btn btn--small"
              aria-label={"Open " + current.title}
              onclick={() => go("#/s/" + current.id)}
              data-testid="bubble-open-{row.id}"
            >
              Open
            </button>
          {:else if row.enabled}
            <button
              class="btn btn--small"
              disabled={startBusy || busyId !== null}
              aria-label={"Start a new thread for " + row.name}
              onclick={() => void onStart(row.id, row.name)}
              data-testid="bubble-start-{row.id}"
            >
              Start thread
            </button>
          {/if}
          <button
            class="btn btn--small"
            disabled={busyId !== null}
            aria-label={(row.enabled ? "Disable " : "Enable ") + row.name}
            aria-pressed={!row.enabled}
            title={row.enabled ? "No new threads. A run already in flight continues." : "Allow new threads again."}
            onclick={() => void apply(row)}
            data-testid="bubble-toggle-{row.id}"
          >
            {row.enabled ? "Disable" : "Enable"}
          </button>
          <button
            class="btn btn--small btn--ghost"
            aria-label={"Edit " + row.name}
            onclick={() => go("#/agents/" + row.id)}
            data-testid="bubble-edit-{row.id}"
          >
            Edit
          </button>
        </div>
      </article>
    {/each}
  </div>
{/if}
