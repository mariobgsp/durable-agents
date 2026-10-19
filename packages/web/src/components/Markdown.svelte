<script lang="ts">
  import { markdownParts } from "../lib/markdown.ts";
  import Mermaid from "./Mermaid.svelte";

  let { text }: { text: string } = $props();

  const parts = $derived(markdownParts(text));
</script>

{#each parts as part, index (index)}
  {#if part.kind === "mermaid"}
    <Mermaid source={part.source} />
  {:else}
    {@html part.html}
  {/if}
{/each}
