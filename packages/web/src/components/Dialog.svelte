<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    onclose,
    children,
    actions,
  }: {
    title: string;
    onclose: () => void;
    children?: Snippet;
    actions?: Snippet;
  } = $props();

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") onclose();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div
  class="overlay"
  role="presentation"
  onclick={(event) => {
    // Only a click on the backdrop itself closes; clicks inside the dialog are left alone.
    if (event.target === event.currentTarget) onclose();
  }}
  onkeydown={(event) => {
    if (event.key === "Escape") onclose();
  }}
>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    data-testid="dialog"
  >
    <h2 class="dialog__title">{title}</h2>
    <div class="dialog__body">
      {@render children?.()}
    </div>
    <div class="dialog__actions">
      {@render actions?.()}
    </div>
  </div>
</div>
