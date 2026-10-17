<!-- Provider credentials screen: status per provider, model list, API key entry. -->
<script lang="ts">
  import { api } from "../api.ts";
  import type { ProviderRow } from "../types.ts";

  let rows = $state<ProviderRow[]>([]);
  let fallback = $state<{ provider: string; modelId: string } | null>(null);
  let keys = $state<Record<string, string>>({});
  let status = $state<string | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  $effect(() => {
    void load();
  });

  async function load(): Promise<void> {
    try {
      const data = await api.providers();
      rows = data.providers;
      fallback = data.default;
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function save(id: string): Promise<void> {
    const key = (keys[id] ?? "").trim();
    if (!key) return;
    busy = true;
    error = null;
    status = null;
    try {
      await api.setProviderKey(id, key);
      keys = { ...keys, [id]: "" };
      status = "API key for " + id + " saved to data/credentials.json";
      await load();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function remove(id: string): Promise<void> {
    if (!window.confirm("Delete the app's API key for " + id + "?")) return;
    await api.clearProviderKey(id);
    await load();
  }
</script>

<section class="page">
  <header class="page__head">
    <h2 class="page__title">Provider</h2>
    {#if fallback}
      <span class="chip">default: {fallback.provider}/{fallback.modelId}</span>
    {/if}
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  {#if status}
    <p class="ok">{status}</p>
  {/if}

  <div class="cards" data-testid="provider-list">
    {#each rows as row (row.id)}
      <article class="card">
        <header class="card__head">
          <h3 class="card__title">{row.id}</h3>
          <span class="chip" class:chip--ok={row.configured}>
            {row.configured ? row.source ?? "connected" : "no credentials yet"}
          </span>
        </header>
        <p class="card__meta">
          {row.models.length > 0 ? row.models.slice(0, 4).join(", ") : "no models readable"}
        </p>
        <div class="row">
          <input
            type="password"
            placeholder="API key"
            bind:value={keys[row.id]}
            onkeydown={(event) => {
              if (event.key === "Enter") void save(row.id);
            }}
          />
          <button class="btn btn--primary" disabled={busy} onclick={() => save(row.id)}>Save</button>
          {#if row.configured}
            <button class="btn btn--ghost" onclick={() => remove(row.id)}>Delete</button>
          {/if}
        </div>
      </article>
    {/each}
  </div>

  <p class="empty">
    Credentials resolve in order: <b>data/credentials.json</b> (the one you can fill in here) →
    pi's <b>~/.pi/agent/auth.json</b> → the provider's environment variable. OAuth login through the
    GUI does not exist yet; use <code>npx @earendil-works/pi-ai login</code> for providers that need it.
  </p>
</section>
