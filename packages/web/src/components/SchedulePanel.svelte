<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../api.ts";
  import type { Schedule } from "../types.ts";

  let { agentId }: { agentId: string } = $props();

  let schedules = $state<Schedule[]>([]);
  let timezone = $state("");
  let error = $state<string | null>(null);
  let status = $state<string | null>(null);
  let busy = $state(false);
  let name = $state("");
  let cron = $state("0 9 * * 1-5");
  let prompt = $state("");
  let preview = $state<number[]>([]);

  onMount(() => {
    void load();
  });

  async function load(): Promise<void> {
    try {
      const body = await api.schedules(agentId);
      schedules = body.schedules;
      timezone = body.timezone;
      error = null;
    } catch (err) {
      error = String(err);
    }
  }

  function when(timestamp: number | undefined): string {
    if (!timestamp) return "—";
    return new Date(timestamp).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function nextLabel(schedule: Schedule): string {
    if (!schedule.enabled) return "paused";
    if (schedule.lastStatus === "running") return "working now";
    return "next " + when(schedule.nextRunAt);
  }

  async function add(): Promise<void> {
    busy = true;
    error = null;
    status = null;
    try {
      await api.createSchedule({ agentId, name, prompt, cron });
      name = "";
      prompt = "";
      preview = [];
      status = "Schedule added";
      await load();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function toggle(schedule: Schedule): Promise<void> {
    try {
      await api.updateSchedule(schedule.id, { enabled: !schedule.enabled });
      await load();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function runNow(schedule: Schedule): Promise<void> {
    try {
      const result = await api.runSchedule(schedule.id);
      status = result.accepted ? "Run started" : "Run skipped: " + (result.reason ?? "unknown");
      await load();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function remove(schedule: Schedule): Promise<void> {
    if (!window.confirm("Delete schedule " + schedule.name + "? The thread and its transcript stay.")) return;
    try {
      await api.deleteSchedule(schedule.id);
      await load();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function showPreview(): Promise<void> {
    error = null;
    try {
      const body = await api.previewSchedule(cron, 5);
      preview = body.times;
      timezone = body.timezone;
      if (preview.length === 0) status = "This expression has no upcoming run.";
    } catch (err) {
      preview = [];
      error = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<div class="schedules" data-testid="agent-schedules">
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  {#if status}
    <p class="ok">{status}</p>
  {/if}

  {#if schedules.length === 0}
    <p class="empty empty--tight">No schedules yet. A run creates one thread named after the schedule.</p>
  {:else}
    <div class="schedules__list">
      {#each schedules as schedule (schedule.id)}
        <div class="schedules__row" class:schedules__row--off={!schedule.enabled} data-testid="schedule-{schedule.id}">
          <div class="schedules__main">
            <b>{schedule.name}</b>
            <span class="schedules__cron">{schedule.cron}</span>
            <span class="hint">
              {nextLabel(schedule)}{#if schedule.lastRunAt} · last {when(schedule.lastRunAt)}{/if}
            </span>
            {#if schedule.lastStatus === "failed" || schedule.lastStatus === "skipped"}
              <span class="usage__bad">{schedule.lastStatus}{#if schedule.lastError}: {schedule.lastError}{/if}</span>
            {:else if schedule.lastStatus === "done"}
              <span class="hint">
                {schedule.lastDurationMs ? (schedule.lastDurationMs / 1000).toFixed(1) + "s" : ""}
                {#if schedule.lastTokens}· {schedule.lastTokens.toLocaleString("en-US")} tokens{/if}
                {#if schedule.lastCacheRead}· {schedule.lastCacheRead.toLocaleString("en-US")} cached{/if}
              </span>
            {/if}
          </div>
          <div class="schedules__actions">
            <button class="btn btn--small" onclick={() => toggle(schedule)}>{schedule.enabled ? "Pause" : "Enable"}</button>
            <button class="btn btn--small" onclick={() => runNow(schedule)}>Run now</button>
            <button class="btn btn--small btn--ghost" onclick={() => remove(schedule)}>Delete</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="schedules__new">
    <label class="field">
      <span>Name</span>
      <input bind:value={name} placeholder="Morning brief" data-testid="schedule-name" />
    </label>
    <label class="field">
      <span>Cron (5 fields)</span>
      <input bind:value={cron} placeholder="0 9 * * 1-5" data-testid="schedule-cron" />
    </label>
    <label class="field">
      <span>Prompt</span>
      <textarea bind:value={prompt} rows="3" placeholder="What should the agent do on each run?" data-testid="schedule-prompt"></textarea>
    </label>
    <div class="row">
      <button class="btn btn--small" onclick={showPreview} data-testid="schedule-preview">Preview next 5</button>
      <button class="btn btn--primary btn--small" disabled={busy || !name.trim() || !prompt.trim()} onclick={add} data-testid="schedule-add">
        Add schedule
      </button>
      <span class="hint">server time zone: {timezone || "loading…"}</span>
    </div>
    {#if preview.length > 0}
      <ul class="schedules__preview">
        {#each preview as time (time)}
          <li>{new Date(time).toLocaleString()}</li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
