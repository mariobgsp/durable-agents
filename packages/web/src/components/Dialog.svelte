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
  onclick={onclose}
  onkeydown={(event) => {
    if (event.key === "Escape") onclose();
  }}
>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    data-testid="dialog"
    onclick={(event) => event.stopPropagation()}
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
