<script lang="ts">
  import type { ShownFile } from "../lib/attachments.ts";

  /**
   * The files of one message.
   *
   * Pure presentation: it is handed files that already know their URL and their size text, so the durable
   * bubble and the optimistic one cannot drift apart. A file the model could not read keeps its place and
   * says why, because a silently missing attachment is worse than a visible refusal.
   */
  let { files }: { files: readonly ShownFile[] } = $props();

  const image = (file: ShownFile): boolean => file.kind === "image" && file.url !== undefined;
</script>

{#if files.length > 0}
  <div class="attachments" data-testid="attachments">
    {#each files as file (file.key)}
      {#if image(file)}
        <a
          class="attachment attachment--image"
          href={file.url}
          target="_blank"
          rel="noreferrer"
          title={file.name}
        >
          <img src={file.url} alt={file.name} loading="lazy" />
        </a>
      {:else}
        <div
          class="attachment attachment--document attachment--{file.state}"
          data-testid="attachment-document"
          data-state={file.state}
        >
          <span class="attachment__glyph" aria-hidden="true">▤</span>
          <span class="attachment__text">
            <span class="attachment__name">{file.name}</span>
            <span class="attachment__meta">
              {file.meta}{#if file.state === "pending"} · sending{/if}
            </span>
            {#if file.reason}<span class="attachment__reason">{file.reason}</span>{/if}
          </span>
        </div>
      {/if}
    {/each}
  </div>
{/if}
