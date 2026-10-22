<script lang="ts">
  import { MAX_FILE_BYTES, draftOf, releaseDrafts } from "../lib/files.ts";
  import type { DraftFile } from "../types.ts";

  /**
   * The composer: one textarea, its files, and the button.
   *
   * It owns drafts and nothing else. Limits, formats and the model's capabilities belong to the server, which
   * is why the file input carries **no `accept` filter** — a picker filter would be a second, weaker copy of a
   * rule that is decided by the file's actual content. The only check here is size, so a huge file is refused
   * before it is read into base64 for nothing.
   *
   * The draft is cleared only when the server accepted the message. A refusal (a blind model, a group, a
   * budget) keeps everything exactly where the user left it.
   */
  let {
    placeholder,
    replying,
    attach,
    onsend,
  }: {
    placeholder: string;
    replying: boolean;
    /** Whether files may be attached here at all, and why not when they may not. */
    attach: { allowed: boolean; reason?: string };
    /** Resolves true when the server accepted the message, false when it refused. */
    onsend: (draft: { text: string; files: DraftFile[] }) => Promise<boolean>;
  } = $props();

  let text = $state("");
  let files = $state<DraftFile[]>([]);
  let area = $state<HTMLTextAreaElement | undefined>(undefined);
  let picker = $state<HTMLInputElement | undefined>(undefined);
  let dragging = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function add(list: FileList | null): Promise<void> {
    if (!list) return;
    error = null;
    const added: DraftFile[] = [];
    for (const file of [...list]) {
      if (file.size > MAX_FILE_BYTES) {
        error = file.name + " is larger than one file may be.";
        continue;
      }
      added.push(await draftOf(file));
    }
    if (added.length > 0) files = [...files, ...added];
  }

  function remove(key: string): void {
    const dropped = files.filter((file) => file.key === key);
    releaseDrafts(dropped);
    files = files.filter((file) => file.key !== key);
  }

  function onPick(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    void add(input.files);
    // Allow picking the same file twice in a row.
    input.value = "";
  }

  function onPaste(event: ClipboardEvent): void {
    const pasted = event.clipboardData?.files;
    if (pasted && pasted.length > 0) {
      event.preventDefault();
      void add(pasted);
    }
  }

  function onDragOver(event: DragEvent): void {
    if (!attach.allowed) return;
    event.preventDefault();
    dragging = true;
  }

  function onDrop(event: DragEvent): void {
    dragging = false;
    if (!attach.allowed) return;
    event.preventDefault();
    void add(event.dataTransfer?.files ?? null);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (text.trim().length === 0 && files.length === 0) return;
    busy = true;
    const accepted = await onsend({ text, files });
    busy = false;
    if (!accepted) return;
    text = "";
    releaseDrafts(files);
    files = [];
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      area?.closest("form")?.requestSubmit();
    }
  }
</script>

<form
  class="composer"
  class:composer--dragging={dragging}
  onsubmit={submit}
  onpaste={onPaste}
  ondrop={onDrop}
  ondragover={onDragOver}
  ondragleave={() => (dragging = false)}
>
  {#if files.length > 0}
    <div class="composer__files" data-testid="composer-files">
      {#each files as file (file.key)}
        <span class="chip chip--file" data-testid="composer-file">
          {#if file.previewUrl}
            <img class="chip__thumb" src={file.previewUrl} alt="" />
          {/if}
          <span class="chip__name">{file.name}</span>
          <button
            type="button"
            class="chip__remove"
            aria-label={"Remove " + file.name}
            title={"Remove " + file.name}
            onclick={() => remove(file.key)}
          >
            ×
          </button>
        </span>
      {/each}
    </div>
  {/if}

  <div class="composer__row">
    <textarea
      bind:this={area}
      bind:value={text}
      rows="1"
      {placeholder}
      data-testid="composer"
      onkeydown={onKeydown}
    ></textarea>
    {#if attach.allowed}
      <button
        type="button"
        class="icon-btn"
        title="Attach files"
        data-testid="attach"
        onclick={() => picker?.click()}
      >
        ＋
      </button>
      <input bind:this={picker} type="file" multiple hidden data-testid="attach-input" onchange={onPick} />
    {:else}
      <button type="button" class="icon-btn" disabled title={attach.reason} data-testid="attach-disabled">
        ＋
      </button>
    {/if}
    <button class="btn btn--primary" type="submit" disabled={busy} data-testid="send">
      {replying ? "Steer" : "Send"}
    </button>
  </div>

  {#if error}
    <p class="composer__error" role="alert" data-testid="composer-error">{error}</p>
  {/if}
</form>