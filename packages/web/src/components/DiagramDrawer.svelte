<script lang="ts">
  import { mermaidBlocks } from "../lib/markdown.ts";
  import { identityOfAuthor } from "../lib/identity.ts";
  import { store } from "../state.svelte.ts";
  import type { Msg } from "../types.ts";
  import AgentAvatar from "./AgentAvatar.svelte";
  import Mermaid from "./Mermaid.svelte";

  let { entries, onclose }: { entries: Msg[]; onclose: () => void } = $props();

  type Item = {
    key: string;
    source: string;
    title: string;
    author: string | null;
    at: number;
  };

  function titleOf(source: string, index: number): string {
    const named = /^\s*%%\s*title\s*:\s*(.+)$/im.exec(source);
    if (named?.[1]) return named[1].trim().slice(0, 72);
    // A diagram type declaration ("flowchart LR") is not a useful title. Without an explicit %% title, use
    // the diagram's position; the message that contains it provides the context.
    return "Diagram " + (index + 1);
  }

  const diagrams = $derived.by(() => {
    const out: Item[] = [];
    for (const entry of entries) {
      if (entry.role !== "assistant" && entry.role !== "user") continue;
      const blocks = mermaidBlocks(entry.text);
      for (const [index, source] of blocks.entries()) {
        out.push({
          key: entry.id + ":" + index,
          source,
          title: titleOf(source, index),
          author: entry.author ?? null,
          at: entry.ts,
        });
      }
    }
    return out.toReversed();
  });

  let selected = $state(0);
  const current = $derived(diagrams[Math.min(selected, Math.max(0, diagrams.length - 1))] ?? null);

  function when(timestamp: number): string {
    if (!timestamp) return "";
    return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape") onclose();
  }}
/>

<button class="drawer-backdrop" aria-label="Close diagrams" onclick={onclose}></button>
<div class="drawer" role="dialog" aria-modal="true" aria-label="Session diagrams" tabindex="-1" data-testid="diagram-drawer">
  <header class="drawer__head">
    <div>
      <h2>Diagrams</h2>
      <span class="hint">{diagrams.length} in this session · one rendered at a time</span>
    </div>
    <button class="btn btn--small btn--ghost" onclick={onclose} data-testid="diagram-close">Close</button>
  </header>

  {#if diagrams.length === 0}
    <p class="empty">No Mermaid diagrams in this session yet.</p>
  {:else}
    <div class="drawer__body">
      <nav class="diagram-list" aria-label="Diagrams">
        {#each diagrams as diagram, index (diagram.key)}
          {@const identity = identityOfAuthor(diagram.author, store.agents)}
          <button
            class="diagram-list__item"
            class:diagram-list__item--active={index === selected}
            onclick={() => (selected = index)}
            title={diagram.title}
          >
            <AgentAvatar identity={identity} size="sm" />
            <span class="diagram-list__text">
              <b>{diagram.title}</b>
              <span class="hint">{identity.label}{#if diagram.at} · {when(diagram.at)}{/if}</span>
            </span>
            <span class="diagram-list__index">{index + 1}</span>
          </button>
        {/each}
      </nav>

      <div class="diagram-viewer">
        {#if current}
          <Mermaid source={current.source} title={current.title} lazy={false} showActions />
        {/if}
      </div>
    </div>
  {/if}
</div>