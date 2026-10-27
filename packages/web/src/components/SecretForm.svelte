<script lang="ts">
  import { api } from "../api.ts";

  /**
   * The masked credential form behind a chat.secret-request entry.
   *
   * The owner types here, not in the composer, and the value goes straight to /api/vault. Two consequences are
   * deliberate: nothing the model or the transcript sees ever contains the password, and the fields are cleared
   * the moment the request succeeds. The browser can still autofill from a password manager, so this stays
   * usable; autocomplete="off" only stops this page from being remembered as a login form by the app itself.
   */
  let {
    label,
    purpose,
    answered = false,
    onsave,
  }: {
    label: string;
    purpose?: string;
    answered?: boolean;
    onsave: (label: string) => Promise<boolean>;
  } = $props();

  let username = $state("");
  let secret = $state("");
  let notes = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let saved = $state(false);

  const locked = $derived(answered || saved);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (locked || busy) return;
    if (!secret) {
      error = "A password or token is required.";
      return;
    }
    busy = true;
    error = null;
    try {
      await api.saveSecret({
        label,
        secret,
        ...(username ? { username } : {}),
        ...(notes ? { notes } : {}),
      });
      // Clear before anything else can render: the fields are the only place the value existed in this tab.
      username = "";
      secret = "";
      notes = "";
      saved = true;
      await onsave(label);
    } catch (failed) {
      error = failed instanceof Error ? failed.message : "Could not save the credential.";
    } finally {
      busy = false;
    }
  }
</script>

<form class="secret" data-testid="secret-request" data-label={label} onsubmit={submit}>
  <header class="secret__head">
    <span class="secret__lock" aria-hidden="true">●</span>
    <b>Vault: {label}</b>
    <span class="secret__mask">always masked</span>
  </header>
  {#if purpose}<p class="secret__purpose">{purpose}</p>{/if}
  <p class="secret__note">
    Goes straight into the encrypted vault (0600, outside git). It never enters this chat, the transcript, or a
    model request.
  </p>

  <label class="secret__field">
    <span>Email or username</span>
    <input
      type="text"
      name="vault-username"
      autocomplete="off"
      spellcheck="false"
      bind:value={username}
      disabled={locked || busy}
      data-testid="secret-username"
    />
  </label>

  <label class="secret__field">
    <span>Password or token</span>
    <input
      type="password"
      name="vault-secret"
      autocomplete="new-password"
      bind:value={secret}
      disabled={locked || busy}
      required
      data-testid="secret-value"
    />
  </label>

  <label class="secret__field">
    <span>Note <span class="secret__optional">optional</span></span>
    <input type="text" name="vault-note" autocomplete="off" bind:value={notes} disabled={locked || busy} />
  </label>

  {#if error}<p class="secret__error" role="alert">{error}</p>{/if}

  <div class="secret__actions">
    <button class="btn btn--primary btn--small" type="submit" disabled={locked || busy} data-testid="secret-save">
      {busy ? "Saving…" : saved ? "Saved" : "Save to vault"}
    </button>
    {#if saved || answered}
      <span class="secret__done">{saved ? "Stored. The agent sees only the label." : "Answered."}</span>
    {/if}
  </div>
</form>
