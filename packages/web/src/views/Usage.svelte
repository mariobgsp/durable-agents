<script lang="ts">
  import { onMount } from "svelte";
  import { api, token } from "../api.ts";
  import { identityOfAgent } from "../lib/identity.ts";
  import { store } from "../state.svelte.ts";
  import type { UsageReport } from "../types.ts";

  /**
   * Usage graphs. Everything is drawn with divs and one scaled span per bar — no chart library, so the view
   * weighs nothing, prints the same numbers the transcript recorded, and stays inside the monochrome system.
   */
  let report = $state<UsageReport | null>(null);
  let error = $state<string | null>(null);

  /**
   * Storage, as the server reports it. Mirrors `packages/server/src/storage.ts`.
   *
   * A cleanup returns the sizes before and after rather than a promise, which is the whole point: the button
   * below reports what came back, it does not assume anything did.
   */
  type StorageReport = {
    databaseBytes: number;
    walBytes: number;
    sharedMemoryBytes: number;
    sessionsBytes: number;
    agentBytes: number;
    totalBytes: number;
  };
  type CleanupResult = { before: StorageReport; after: StorageReport; reclaimedBytes: number };

  let storage = $state<StorageReport | null>(null);
  let cleanup = $state<CleanupResult | null>(null);
  let storageError = $state<string | null>(null);
  let cleaning = $state(false);

  onMount(() => {
    void loadUsage();
    void loadStorage();
  });

  async function loadUsage(): Promise<void> {
    try {
      report = await api.usage();
    } catch (err) {
      error = String(err);
    }
  }

  /**
   * The storage routes are called here rather than through `api`, which has no methods for them yet.
   * The URL stays relative, so it resolves the same way through Vite's proxy and through the production
   * server that serves this bundle.
   */
  async function storageCall<T>(path: string, method: "GET" | "POST"): Promise<T> {
    const response = await fetch(path, { method, headers: { "x-pi-token": token } });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const body = JSON.parse(text) as { error?: unknown };
        if (typeof body.error === "string" && body.error.length > 0) message = body.error;
      } catch {
        if (text.length > 0) message = text.slice(0, 300);
      }
      throw new Error(message);
    }
    return JSON.parse(text) as T;
  }

  async function loadStorage(): Promise<void> {
    try {
      // The route wraps the report: `GET /api/storage` answers `{ storage: { ...sizes } }`.
      const body = await storageCall<{ storage: StorageReport }>("/api/storage", "GET");
      storage = body.storage;
      storageError = null;
    } catch (err) {
      storageError = err instanceof Error ? err.message : String(err);
    }
  }

  async function runCleanup(): Promise<void> {
    cleaning = true;
    try {
      cleanup = await storageCall<CleanupResult>("/api/storage/cleanup", "POST");
      // The server's own after-size, not the before-size minus a guess.
      storage = cleanup.after;
      storageError = null;
    } catch (err) {
      storageError = err instanceof Error ? err.message : String(err);
    } finally {
      cleaning = false;
    }
  }

  /**
   * Bytes with the unit a reader would use.
   *
   * Under 100 the value keeps one decimal and from 100 it is rounded, so the widest string stays short
   * enough for the note column under the row at the phone tier.
   */
  function bytes(size: number): string {
    for (const [step, unit] of [
      [1024 ** 3, "GB"],
      [1024 ** 2, "MB"],
      [1024, "kB"],
    ] as const) {
      if (size >= step) {
        const value = size / step;
        return (value >= 100 ? Math.round(value) : value.toFixed(1)) + " " + unit;
      }
    }
    return size + " B";
  }

  /**
   * The number that belongs to the storage bar: that part's share of the data directory.
   *
   * A part whose share rounds to nothing says "<0.1%" instead of "0%", because the bar still draws its 2%
   * visibility floor and a printed zero next to a visible stub would be the one number that disagrees.
   */
  function shareLabel(value: number, total: number): string {
    if (value <= 0 || total <= 0) return "0%";
    const percent = (value / total) * 100;
    if (percent < 0.1) return "<0.1%";
    return percent >= 10 ? Math.round(percent) + "%" : percent.toFixed(1) + "%";
  }

  /** What the cleanup actually gave back. A zero is said out loud rather than dressed up as a win. */
  function reclaimed(result: CleanupResult): string {
    if (result.reclaimedBytes === 0) {
      return "0 B reclaimed — the log was already folded in and there was nothing free to give back.";
    }
    return (
      bytes(result.reclaimedBytes) +
      " reclaimed (" +
      bytes(result.before.totalBytes) +
      " → " +
      bytes(result.after.totalBytes) +
      ") of the data directory"
    );
  }

  const storageParts = $derived(
    storage === null
      ? []
      : [
          { label: "database", size: storage.databaseBytes, note: "the rows themselves" },
          { label: "wal", size: storage.walBytes, note: "write-ahead log" },
          { label: "shared memory", size: storage.sharedMemoryBytes, note: "SQLite -shm index" },
          { label: "sessions.json", size: storage.sessionsBytes, note: "the session index" },
          { label: "agent files", size: storage.agentBytes, note: "AGENT.md · SOUL.md" },
          { label: "total", size: storage.totalBytes, note: "the sum of the parts" },
        ],
  );

  function share(value: number, max: number): number {
    return max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  }

  /**
   * Storage bars share the whole data directory rather than an arbitrary maximum. A part that holds nothing
   * draws nothing: `share`'s 2% floor exists so a tiny value stays visible, and 0 B is not a tiny value.
   */
  function shareBytes(value: number, total: number): number {
    if (value <= 0 || total <= 0) return 0;
    return Math.max(2, Math.round((value / total) * 100));
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

  <h2 class="usage__head">
    Storage <span class="usage__head-note">bytes on disk, split by what a reader would recognise</span>
  </h2>
  {#if storageError}
    <p class="error" role="alert">{storageError}</p>
  {/if}
  {#if storage}
    <div class="usage__chart" data-testid="usage-storage">
      {#each storageParts as part (part.label)}
        <div class="usage__row">
          <span class="usage__label">{part.label}</span>
          <span class="usage__track">
            <span
              class="usage__bar usage__bar--paper"
              style="width: {shareBytes(part.size, storage.totalBytes)}%"
            ></span>
          </span>
          <span class="usage__value">{shareLabel(part.size, storage.totalBytes)}</span>
          <span class="usage__sub">{bytes(part.size)} · {part.note}</span>
        </div>
      {/each}
    </div>
    <div class="row">
      <button class="btn" disabled={cleaning} onclick={() => runCleanup()} data-testid="storage-cleanup">
        {cleaning ? "Cleaning…" : "Cleanup"}
      </button>
      {#if cleanup}
        <span class="hint" data-testid="storage-cleanup-result">{reclaimed(cleanup)}</span>
      {/if}
    </div>
    <p class="hint">
      Cleanup folds the write-ahead log back into the database and vacuums what deletions left behind; the sizes
      above are read from disk after it ran, not estimated before it. A purge is per thread and irreversible, and
      it is not a delete: it exports that thread's transcript to <code>data/exports/</code> first, then removes its
      rows for good. There is no purge control in this view yet.
    </p>
  {:else if !storageError}
    <p class="empty">Loading…</p>
  {/if}
</section>
