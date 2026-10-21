<script lang="ts">
  import { onMount } from "svelte";
  import { api, token } from "../api.ts";
  import { identityOfAgent } from "../lib/identity.ts";
  import { store } from "../state.svelte.ts";
  import type { UsageReport } from "../types.ts";

  let report = $state<UsageReport | null>(null);
  let error = $state<string | null>(null);
  let refreshing = $state(false);
  type Range = "14d" | "30d" | "month" | "all";
  let range = $state<Range>("14d");

  type StorageReport = {
    databaseBytes: number;
    walBytes: number;
    sharedMemoryBytes: number;
    sessionsBytes: number;
    agentBytes: number;
    meshBytes: number;
    schedulesBytes: number;
    usageLedgerBytes: number;
    artifactBytes: number;
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

  async function loadUsage(fresh = false): Promise<void> {
    refreshing = true;
    try {
      report = await api.usage(fresh);
      error = null;
    } catch (err) {
      error = String(err);
    } finally {
      refreshing = false;
    }
  }

  async function storageCall<T>(path: string, method: "GET" | "POST"): Promise<T> {
    const response = await fetch(path, { method, headers: { "x-pi-token": token } });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      let message = response.status + " " + response.statusText;
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
      storage = cleanup.after;
      storageError = null;
    } catch (err) {
      storageError = err instanceof Error ? err.message : String(err);
    } finally {
      cleaning = false;
    }
  }

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

  function shareLabel(value: number, total: number): string {
    if (value <= 0 || total <= 0) return "0%";
    const percent = (value / total) * 100;
    if (percent < 0.1) return "<0.1%";
    return percent >= 10 ? Math.round(percent) + "%" : percent.toFixed(1) + "%";
  }

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
          { label: "mesh.json", size: storage.meshBytes, note: "agent-to-agent links" },
          { label: "schedules.json", size: storage.schedulesBytes, note: "cron schedules" },
          { label: "usage.jsonl", size: storage.usageLedgerBytes, note: "stateless model calls" },
          { label: "artifacts", size: storage.artifactBytes, note: "agent-generated downloads" },
          { label: "total", size: storage.totalBytes, note: "the sum of the parts" },
        ],
  );

  function share(value: number, max: number): number {
    return max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  }

  function shareBytes(value: number, total: number): number {
    if (value <= 0 || total <= 0) return 0;
    return Math.max(2, Math.round((value / total) * 100));
  }

  function compact(tokens: number): string {
    if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + "M";
    if (tokens >= 1_000) return (tokens / 1_000).toFixed(1) + "k";
    return String(tokens);
  }

  function money(cost: number): string {
    return "$" + cost.toFixed(4);
  }

  function duration(ms: number | undefined): string {
    if (!ms) return "—";
    return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
  }

  function colorOf(id: string): string {
    const agent = store.agents.find((entry) => entry.id === id);
    return agent ? identityOfAgent(agent).color : "var(--muted)";
  }

  function dateOf(timestamp: number | null): string {
    if (timestamp === null) return "no recorded calls yet";
    return new Date(timestamp).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  const periodCards = $derived(
    report === null
      ? []
      : [
          { label: "Today", data: report.periods.today },
          { label: "This month", data: report.periods.thisMonth },
          { label: "Last 30 days", data: report.periods.last30 },
          { label: "All time", data: report.periods.all },
        ],
  );

  const activeDays = $derived.by(() => {
    if (!report) return [];
    if (range === "14d") return report.days.slice(-14);
    if (range === "30d") return report.days.slice(-30);
    if (range === "month") {
      const now = new Date();
      const prefix = String(now.getFullYear()) + "-" + String(now.getMonth() + 1).padStart(2, "0");
      return report.days.filter((day) => day.date.startsWith(prefix));
    }
    return [];
  });

  const activeMonths = $derived(report ? report.months.slice(-12) : []);
  const showMonths = $derived(range === "all");

  const chartRows = $derived.by(() => {
    if (!report) return [] as { label: string; turns: number; tokens: number; cached: number; title: string }[];
    if (showMonths) {
      return activeMonths.map((month) => ({
        label: month.month.slice(2),
        turns: month.turns,
        tokens: month.tokens,
        cached: month.cacheRead,
        title: month.month + ": " + month.turns + " calls, " + compact(month.tokens) + " tokens",
      }));
    }
    return activeDays.map((day) => ({
      label: day.date.slice(5),
      turns: day.turns,
      tokens: day.tokens,
      cached: day.cacheRead,
      title: day.date + ": " + day.turns + " calls, " + compact(day.tokens) + " tokens",
    }));
  });

  const maxChart = $derived(Math.max(1, ...chartRows.map((row) => row.turns)));
  const maxTokens = $derived(Math.max(1, ...(report?.models ?? []).map((model) => model.tokens)));
  const maxCalls = $derived(Math.max(1, ...(report?.tools ?? []).map((tool) => tool.calls)));
  const maxMonth = $derived(Math.max(1, ...(report?.months ?? []).map((month) => month.tokens)));
  const maxAgent = $derived(Math.max(1, ...(report?.agents ?? []).map((agent) => agent.all.tokens)));
</script>

<section class="page" data-testid="usage">
  <div class="page__head">
    <h1 class="page__title">Usage</h1>
    <div class="row">
      {#if report}
        <span class="hint">
          {report.totals.sessions} threads · {report.totals.turns} calls · since {dateOf(report.firstAt)} · {report.timezone}
        </span>
      {/if}
      <button class="btn btn--small" disabled={refreshing} onclick={() => loadUsage(true)} data-testid="usage-refresh">
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  </div>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if report}
    <div class="usage__periods" data-testid="usage-periods">
      {#each periodCards as card (card.label)}
        <div class="usage__period">
          <span class="usage__period-label">{card.label}</span>
          <span class="usage__period-value">{compact(card.data.tokens)}</span>
          <span class="usage__period-sub">
            {compact(card.data.cacheRead)} cached · {money(card.data.cost)}
          </span>
        </div>
      {/each}
    </div>

    <div class="usage__rangebar" role="group" aria-label="Usage range">
      {#each [
        { id: "14d", label: "14 days" },
        { id: "30d", label: "30 days" },
        { id: "month", label: "This month" },
        { id: "all", label: "All months" },
      ] as option (option.id)}
        <button
          class="btn btn--small"
          class:btn--active={range === option.id}
          onclick={() => (range = option.id as Range)}
          data-testid="usage-range-{option.id}"
        >
          {option.label}
        </button>
      {/each}
    </div>

    <h2 class="usage__head">
      Activity <span class="usage__head-note">{showMonths ? "calls per month, recent 12" : "calls per day"}</span>
    </h2>
    {#if chartRows.length === 0}
      <p class="empty">Nothing recorded in this range.</p>
    {:else}
      <div class="usage__days" data-testid="usage-days">
        {#each chartRows as day (day.label)}
          <div class="usage__day" title={day.title}>
            <span class="usage__day-bar" style="transform: scaleY({share(day.turns, maxChart) / 100})"></span>
            <span class="usage__day-label">{day.label}</span>
          </div>
        {/each}
      </div>
    {/if}

    <details class="usage__allmonths" data-testid="usage-months">
      <summary>All months <span class="usage__head-note">{report.months.length} recorded · tokens, cached, spend</span></summary>
      <div class="usage__chart">
        {#each report.months.toReversed() as month (month.month)}
          <div class="usage__row">
            <span class="usage__label">{month.month}</span>
            <span class="usage__track">
              <span class="usage__bar usage__bar--paper" style="width: {share(month.tokens, maxMonth)}%"></span>
            </span>
            <span class="usage__value">{compact(month.tokens)}</span>
            <span class="usage__sub">{month.turns} calls · {compact(month.cacheRead)} cached · {money(month.cost)}</span>
          </div>
        {/each}
      </div>
    </details>

    <h2 class="usage__head">Agents <span class="usage__head-note">tokens, all time</span></h2>
    {#if report.agents.length === 0}
      <p class="empty">No agent has answered yet.</p>
    {:else}
      <div class="usage__chart" data-testid="usage-agents">
        {#each report.agents as agent (agent.id)}
          <div class="usage__row">
            <span class="usage__label" title={agent.id}>{agent.name}</span>
            <span class="usage__track">
              <span class="usage__bar" style="width: {share(agent.all.tokens, maxAgent)}%; background: {colorOf(agent.id)}"></span>
            </span>
            <span class="usage__value">{compact(agent.all.tokens)}</span>
            <span class="usage__sub">
              today {compact(agent.today.tokens)} · cached {compact(agent.all.cacheRead)} · {money(agent.all.cost)}
            </span>
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
          <span class="usage__sub">{model.turns} calls · {compact(model.cacheRead)} cached · {money(model.cost)}</span>
        </div>
      {/each}
    </div>

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

    {#if report.stateless.turns > 0}
      <p class="hint" data-testid="usage-stateless">
        Includes {report.stateless.turns} stateless calls (group claims/oversight and suggestions), {compact(
          report.stateless.tokens,
        )} tokens. Background compaction spend is not itemized.
      </p>
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
  {:else if !storageError}
    <p class="empty">Loading…</p>
  {/if}
</section>