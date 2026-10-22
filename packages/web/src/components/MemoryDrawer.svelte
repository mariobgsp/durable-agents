<script lang="ts">
  import MemoryGraph from "./MemoryGraph.svelte";

  let {
    agentName,
    memoryMd,
    onclose,
  }: {
    agentName: string;
    memoryMd: string;
    onclose: () => void;
  } = $props();
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape") onclose();
  }}
/>

<button class="drawer-backdrop" aria-label="Close memory" onclick={onclose}></button>
<div class="drawer memory-drawer" role="dialog" aria-modal="true" aria-label="Agent memory" tabindex="-1" data-testid="memory-drawer">
  <header class="drawer__head">
    <div>
      <h2>Memory</h2>
      <span class="hint">{agentName} · connected notes, read by every future thread</span>
    </div>
    <button class="btn btn--small btn--ghost" onclick={onclose} data-testid="memory-close">Close</button>
  </header>
  <div class="drawer__body memory-drawer__body">
    <MemoryGraph {agentName} {memoryMd} />
  </div>
</div>
