<script lang="ts">
  /**
   * The answer buttons for a `chat.question` message.
   *
   * A question is answerable once: a later user message in the thread (the `answered` prop) locks the buttons,
   * and so does a successful send from here — the transcript only catches up after the server has written the
   * entry. A failed send re-enables them, exactly like the composer keeps its draft.
   */
  let {
    options,
    answered,
    onanswer,
  }: {
    options: string[];
    /** Whether the thread already has a user message after the question. */
    answered: boolean;
    /** Resolves true when the server accepted the answer. */
    onanswer: (option: string) => Promise<boolean>;
  } = $props();

  let chosen = $state<string | null>(null);
  let sent = $state(false);

  const locked = $derived(answered || sent || chosen !== null);

  async function choose(option: string): Promise<void> {
    if (locked) return;
    chosen = option;
    try {
      if (await onanswer(option)) sent = true;
      else chosen = null;
    } catch {
      chosen = null;
    }
  }
</script>

<div class="question" data-testid="question-options">
  <div class="question__options">
    {#each options as option (option)}
      <button
        class="question__option"
        class:question__option--chosen={chosen === option}
        disabled={locked}
        data-testid="question-option"
        onclick={() => choose(option)}
      >
        {option}
      </button>
    {/each}
  </div>
  {#if answered || sent}
    <p class="question__note">{sent && !answered ? "Answer sent." : "Answered."}</p>
  {/if}
</div>
