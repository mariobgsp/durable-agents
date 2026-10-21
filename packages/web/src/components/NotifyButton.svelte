<script lang="ts">
  import { onMount } from "svelte";
  import {
    loadNotifyPrefs,
    notificationPermission,
    playChime,
    requestNotificationPermission,
    primeAudio,
    saveNotifyPrefs,
    showDesktopNotification,
    type NotifyPrefs,
    type PermissionState,
  } from "../lib/notify.ts";

  // A deep link used by the screenshot gate; otherwise the popover starts closed.
  let open = $state(new URLSearchParams(location.search).has("notify"));
  let prefs = $state<NotifyPrefs>(loadNotifyPrefs());
  let permission = $state<PermissionState>("default");
  let status = $state<string | null>(null);

  onMount(() => {
    permission = notificationPermission();
  });

  function update(next: NotifyPrefs): void {
    prefs = next;
    saveNotifyPrefs(next);
    if (next.sound) primeAudio();
  }

  async function askPermission(): Promise<void> {
    permission = await requestNotificationPermission();
    if (permission === "granted") update({ ...prefs, desktop: true });
    status =
      permission === "granted"
        ? "Desktop notifications enabled."
        : permission === "denied"
          ? "The browser denied notifications. Enable them in site settings."
          : permission === "unsupported"
            ? "This browser does not support desktop notifications."
            : "Permission was not granted.";
  }

  function test(): void {
    playChime();
    if (prefs.desktop && permission === "granted") {
      showDesktopNotification(
        { sessionId: "", title: "dura-agents", body: "Completion alerts are working." },
        false,
      );
    }
    status = "Played the test chime.";
  }
</script>

<div class="notify">
  <button
    class="icon-btn"
    title="Completion alerts"
    aria-label="Completion alerts"
    aria-expanded={open}
    data-testid="notify-button"
    onclick={() => (open = !open)}
  >
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M8 2.2a3.6 3.6 0 0 0-3.6 3.6v2.1L3.2 10h9.6l-1.2-2.1V5.8A3.6 3.6 0 0 0 8 2.2Z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linejoin="round"
      />
      <path d="M6.4 12.2a1.7 1.7 0 0 0 3.2 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </svg>
  </button>

  {#if open}
    <div class="notify__pop" role="dialog" aria-label="Completion alerts" data-testid="notify-popover">
      <header class="notify__head">
        <b>Completion alerts</b>
        <button class="icon-btn" aria-label="Close" onclick={() => (open = false)}>×</button>
      </header>

      <label class="check">
        <input
          type="checkbox"
          checked={prefs.sound}
          onchange={(event) => update({ ...prefs, sound: event.currentTarget.checked })}
          data-testid="notify-sound"
        />
        <span>Sound</span>
      </label>

      <label class="check">
        <input
          type="checkbox"
          checked={prefs.toast}
          onchange={(event) => update({ ...prefs, toast: event.currentTarget.checked })}
          data-testid="notify-toast"
        />
        <span>In-app toast</span>
      </label>

      <div class="notify__desktop">
        <label class="check">
          <input
            type="checkbox"
            checked={prefs.desktop}
            disabled={permission === "unsupported" || permission === "denied"}
            onchange={(event) => update({ ...prefs, desktop: event.currentTarget.checked })}
            data-testid="notify-desktop"
          />
          <span>Desktop notification</span>
        </label>
        {#if permission === "default"}
          <button class="btn btn--small" onclick={askPermission} data-testid="notify-permission">Enable</button>
        {:else if permission === "granted"}
          <span class="hint">allowed</span>
        {:else if permission === "denied"}
          <span class="hint">blocked in browser settings</span>
        {:else}
          <span class="hint">not supported</span>
        {/if}
      </div>

      <div class="row">
        <button class="btn btn--small" onclick={test} data-testid="notify-test">Test</button>
        <span class="hint">Fires when a run finishes; no push while the browser is closed.</span>
      </div>
      {#if status}
        <p class="hint" role="status">{status}</p>
      {/if}
    </div>
  {/if}
</div>