<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../api.ts";
  import { loadDisplay, loadSystem, startSystemRestart, startSystemUpdate, store, watchSystem } from "../state.svelte.ts";
  import type { SystemOperation, SystemStep, ToolVersions } from "../types.ts";
  import ActivityIndicator from "../components/ActivityIndicator.svelte";

  /**
   * The app's own screen: what is running, what it can do, and the last thing it did.
   *
   * The server owns every operation, so this view only reads a snapshot and polls while one is running.
   * Navigating away loses nothing; coming back reads the same record. Under a restart the process this
   * page came from is intentionally gone, which is why the tracker — not the snapshot — speaks first.
   */

  onMount(() => {
    void (async () => {
      await loadSystem();
      if (store.system?.current !== null) watchSystem();
    })();
  });

  const facts = $derived(store.system?.process ?? null);
  const operation = $derived(store.system?.current ?? store.system?.last ?? null);
  const phase = $derived(operation?.state.name ?? "idle");
  const busy = $derived(store.system?.current !== null);
  const outcome = $derived(operation?.state.name === "done" ? operation.state.outcome : null);
  const restarting = $derived(
    store.restart?.state === "waiting" || store.restart?.state === "stopping" || phase === "restarting",
  );
  const display = $derived(store.display);
  let displayBusy = $state(false);
  let displayError = $state<string | null>(null);

  async function resetDisplay(): Promise<void> {
    displayBusy = true;
    displayError = null;
    try {
      await api.resetDisplay();
      await loadDisplay();
    } catch (error) {
      displayError = error instanceof Error ? error.message : String(error);
    } finally {
      displayBusy = false;
    }
  }

  /** "Installed" is what the last package update left on disk; "running" is what this process loaded. */
  const installed = $derived(outcome?.kind === "update" && outcome.mode === "packages" ? outcome.after : null);
  const stale = $derived(
    installed !== null && facts !== null && installed.piDurable !== facts.versions.piDurable,
  );

  const STEP_WORD: Record<SystemStep, string> = {
    checking: "Checking…",
    installing: "Installing packages…",
    building: "Building the UI…",
    reloading: "Reloading tools…",
    stopping: "Stopping…",
  };

  function clock(milliseconds: number | null): string {
    if (milliseconds === null) return "";
    const seconds = milliseconds / 1000;
    return seconds < 1 ? "<1 s" : seconds.toFixed(1) + " s";
  }

  const PACKAGE_LABELS: Record<"piDurable" | "piCodemode" | "piAi" | "chord", string> = {
    piDurable: "pi-durable",
    piCodemode: "pi-codemode",
    piAi: "pi-ai",
    chord: "chord",
  };

  /** Name every package that actually moved, not just the one the header has room for. */
  function versionLine(before: ToolVersions, after: ToolVersions): string {
    const names = ["piDurable", "piCodemode", "piAi", "chord"] as const;
    const changed = names.filter((name) => before[name] !== after[name]);
    if (changed.length === 0) return "already up to date";
    return changed
      .map((name) => PACKAGE_LABELS[name] + " " + before[name] + " → " + after[name])
      .join(" · ");
  }

  function describeRestart(): string {
    if (store.restart?.state === "waiting") return "Restarting — waiting for the process to answer.";
    if (store.restart?.state === "stopping") return "Stopped. Nothing supervises this process.";
    if (store.restart?.state === "returned") {
      const downtime = clock(store.restart.downtimeMs);
      return downtime ? "Restarted · back after " + downtime + "." : "Restarted.";
    }
    if (store.restart?.state === "missed") {
      return "Stopped. Nothing started it again — start the server to come back.";
    }
    return "";
  }

  function lines(operation: SystemOperation): SystemOperation["log"] {
    return operation.log;
  }
</script>

<section class="page" data-testid="system-page">
  <header class="page__head">
    <h2 class="page__title">System</h2>
    {#if facts}
      <span class="chip" data-testid="system-versions">
        pi-durable {facts.versions.piDurable} · node {facts.versions.node}
      </span>
    {/if}
  </header>

  {#if store.systemOperationError}
    <p class="error" role="alert" data-testid="system-error">{store.systemOperationError}</p>
  {/if}

  {#if facts}
    <div class="facts" data-testid="system-facts">
      <div class="facts__row">
        <span class="facts__key">Tools</span>
        <span class="facts__value">
          pi-durable {facts.versions.piDurable} · pi-codemode {facts.versions.piCodemode} · pi-ai {facts.versions.piAi}
        </span>
      </div>
      <div class="facts__row">
        <span class="facts__key">Boundary</span>
        <span class="facts__value">
          {facts.sandboxed ? "sandboxed · repository read-only" : "not sandboxed · repository writable"}
        </span>
      </div>
      <div class="facts__row">
        <span class="facts__key">Restart</span>
        <span class="facts__value">
          {facts.supervisor === "none"
            ? "nothing supervises this process"
            : facts.supervisor + " brings the server back"}
        </span>
      </div>
      {#if stale && installed}
        <div class="facts__row facts__row--notice">
          <span class="facts__key">Installed</span>
          <span class="facts__value">{installed.piDurable} · restart to load it</span>
        </div>
      {/if}
    </div>

    <div class="job" data-state={phase} data-testid="system-state">
      <p class="job__headline" aria-live="polite">
        {#if store.restart}
          {describeRestart()}
        {:else if phase === "idle"}
          Nothing has run since this server started.
        {:else if operation && operation.state.name === "running"}
          <ActivityIndicator size="sm" label="Working" />
          {STEP_WORD[operation.state.step]}
        {:else if operation && operation.state.name === "done" && operation.state.outcome.kind === "update"}
          {operation.state.outcome.changed ? "Updated." : "Already up to date."}
          {versionLine(operation.state.outcome.before, operation.state.outcome.after)}
        {:else if operation && operation.state.name === "done" && operation.state.outcome.kind === "restart"}
          Restarted{operation.state.outcome.downtimeMs === null
            ? "."
            : " · back after " + clock(operation.state.outcome.downtimeMs) + "."}
        {:else if operation && operation.state.name === "failed"}
          {operation.state.reason}
          {#if operation.state.exitCode !== null}· exit {operation.state.exitCode}{/if}
        {:else if operation && operation.state.name === "interrupted"}
          Interrupted — {operation.state.reason}.
        {:else if operation && operation.state.name === "restarting"}
          Restarting — {operation.state.supervisor} starts it again.
        {:else if operation && operation.state.name === "stopped"}
          Stopped. Nothing supervises this process.
        {/if}
      </p>

      {#if operation}
        <details class="job__details" open={phase === "failed"}>
          <summary>
            Output · {lines(operation).length} lines{operation.truncated ? " (tail)" : ""}
          </summary>
          <ol class="job__log" data-testid="system-log">
            {#each lines(operation) as line (line.seq)}
              <li class="job__line job__line--{line.kind}">{line.text}</li>
            {/each}
          </ol>
        </details>
      {/if}
    </div>

    <div class="system__actions">
      <button
        class="btn btn--primary"
        disabled={busy || restarting}
        onclick={() => void startSystemUpdate()}
        data-testid="system-update"
      >
        {facts.capability.update === "reload" ? "Reload tools" : "Update"}
      </button>
      <p class="hint">
        {#if facts.capability.update === "reload"}
          The repository is read-only, so nothing can be installed. Reload re-registers the tools already
          loaded in this process.
        {:else}
          Installs newer <code>@earendil-works</code> packages and rebuilds the UI. Restart afterwards to load
          the new code.
        {/if}
      </p>

      <button
        class="btn"
        disabled={busy || restarting}
        onclick={() => void startSystemRestart()}
        data-testid="system-restart"
      >
        Restart
      </button>
      <p class="hint">
        {#if facts.capability.restart === "supervised"}
          The server goes down for a few seconds and comes back.
        {:else}
          Nothing supervises this process: the server stops and stays down until you start it again.
        {/if}
      </p>
    </div>

    <div class="display-panel" data-testid="display-panel">
      <h3>Display</h3>
      {#if display}
        <div class="display-panel__row">
          <span class="display-panel__swatch" style="background: {display.accent}"></span>
          <b>{display.logo ? display.logo + " " : ""}{display.displayName}</b>
          <span class="hint">{display.font} · {display.density} · radius {display.radius}px</span>
        </div>
        <p class="hint">
          {display.tagline || "No tagline"} · {display.customCss.length} bytes of custom CSS
          {#if display.updatedBy}· last changed by @{display.updatedBy}{/if}
        </p>
      {:else}
        <p class="hint">The default display is active.</p>
      {/if}
      {#if displayError}
        <p class="error" role="alert">{displayError}</p>
      {/if}
      <div class="row">
        <button class="btn btn--small" disabled={displayBusy} onclick={() => void resetDisplay()} data-testid="display-reset">
          {displayBusy ? "Resetting…" : "Reset display"}
        </button>
        <span class="hint">
          Agents can change this with customize_ui. The change is saved and applied live; a refresh is enough for
          a tab that missed the frame. Use ?display=default for a temporary recovery view.
        </span>
      </div>
    </div>
  {/if}
</section>