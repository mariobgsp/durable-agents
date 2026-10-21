<script lang="ts">
  import { artifactUrl } from "../api.ts";
  import type { Artifact } from "../types.ts";

  let {
    sessionId,
    entryId,
    artifacts,
  }: { sessionId: string; entryId: string; artifacts: Artifact[] } = $props();

  function bytes(value: number): string {
    if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " MB";
    if (value >= 1024) return (value / 1024).toFixed(1) + " kB";
    return value + " B";
  }

  function extension(name: string): string {
    const part = name.split(".").pop();
    return part && part !== name ? part.toUpperCase().slice(0, 4) : "FILE";
  }

  function kind(name: string, mimeType: string): string {
    if (mimeType.includes("pdf")) return "PDF";
    if (mimeType.includes("json")) return "JSON";
    if (mimeType.includes("markdown")) return "MD";
    if (mimeType.includes("text/plain")) return "TXT";
    if (mimeType.includes("csv")) return "CSV";
    if (mimeType.startsWith("image/")) return "IMG";
    return extension(name);
  }
</script>

<div class="filecards" data-testid="generated-files">
  {#each artifacts as file (file.id)}
    <a
      class="filecard"
      href={artifactUrl(sessionId, entryId, file.id)}
      download={file.name}
      title={"Download " + file.name}
      data-testid="generated-file-{file.id}"
    >
      <span class="filecard__kind">{kind(file.name, file.mimeType)}</span>
      <span class="filecard__body">
        <b>{file.name}</b>
        <span>{bytes(file.bytes)} · {file.mimeType.split(";")[0]}</span>
      </span>
      <span class="filecard__download" aria-hidden="true">↓</span>
    </a>
  {/each}
</div>
