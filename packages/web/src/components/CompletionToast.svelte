<script lang="ts">
  import { onDestroy } from "svelte";
  import { go } from "../router.svelte.ts";
  import { dismissCompletionToast, store } from "../state.svelte.ts";

  let timer: number | undefined;

  $effect(() => {
    const current = store.completionToast;
    if (timer) window.clearTimeout(timer);
    timer = undefined;
    if (!current) return;
    timer = window.setTimeout(() => dismissCompletionToast(), 6500);
  });

  onDestroy(() => {
    if (timer) window.clearTimeout(timer);
  });

  function open(): void {
    const toast = store.completionToast;
    if (!toast) return;
    if (toast.sessionId) go("#/s/" + toast.sessionId);
    dismissCompletionToast();
  }
</script>

{#if store.completionToast}
  {@const toast = store.completionToast}
  <div class="toast" role="status" aria-live="polite" data-testid="completion-toast">
    <button class="toast__body" onclick={open}>
      <b>{toast.count > 1 ? toast.count + " runs finished" : toast.title}</b>
      <span>Open the thread</span>
    </button>
    <button class="icon-btn" aria-label="Dismiss" onclick={dismissCompletionToast}>×</button>
  </div>
{/if}
