<script lang="ts">
  import type { ToolCall } from "../ws.ts";
  import ToolCallRow from "./ToolCallRow.svelte";

  /**
   * The calls of the round that is running right now, read by the server from `pi.live`. The finished ones
   * are not here: they arrive as `role: "tool"` entries in the transcript instead, so they survive a
   * refresh. Both halves render through `ToolCallRow`, so they cannot drift apart.
   */
  let { tools }: { tools: ToolCall[] } = $props();
</script>

{#if tools.length > 0}
  <div class="tooltrace" data-testid="tool-trace">
    {#each tools as tool (tool.callId)}
      <ToolCallRow
        name={tool.name}
        status={tool.status}
        output={tool.output ?? ""}
        isError={tool.isError ?? false}
        nested={tool.nested}
      />
    {/each}
  </div>
{/if}
