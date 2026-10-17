<script lang="ts">
  import { api } from "../api.ts";
  import type { AgentRecord } from "../types.ts";
  import { go } from "../router.svelte.ts";
  import { createSession } from "../state.svelte.ts";

  let agents = $state<AgentRecord[]>([]);
  let error = $state<string | null>(null);
  let busy = $state(false);

  $effect(() => {
    void load();
  });

  async function load(): Promise<void> {
    try {
      agents = (await api.agents()).agents;
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function startSession(agent: AgentRecord): Promise<void> {
    busy = true;
    const session = await createSession("Thread · " + agent.name, agent.id);
    busy = false;
    if (session) go("#/s/" + session.id);
  }

  async function remove(agent: AgentRecord): Promise<void> {
    if (!window.confirm("Delete agent " + agent.name + "? The files in data/agents/" + agent.id + " go with it.")) return;
    await api.deleteAgent(agent.id);
    await load();
  }
</script>

<section class="page">
  <header class="page__head">
    <h2 class="page__title">Agent</h2>
    <button class="btn btn--primary" onclick={() => go("#/agents/new")} data-testid="new-agent">
      New agent<span class="btn__icon">+</span>
    </button>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <div class="cards" data-testid="agent-list">
    {#each agents as agent (agent.id)}
      <article class="card">
        <header class="card__head">
          <h3 class="card__title">{agent.name}</h3>
          <span class="chip">@{agent.id}</span>
        </header>
        {#if agent.responsibility}
          <p class="card__line">{agent.responsibility}</p>
        {:else}
          <p class="card__line card__line--missing">
            No responsibility yet — fill it in so Nyahut mode can judge.
          </p>
        {/if}
        <p class="card__meta">
          {agent.provider}/{agent.modelId} · thinking {agent.thinkingLevel} ·
          {agent.tools.length === 0 ? "no tools" : "tools: " + agent.tools.join(", ")}
        </p>
        <div class="card__actions">
          <button class="btn btn--primary" disabled={busy} onclick={() => startSession(agent)}>Start thread</button>
          <button class="btn" onclick={() => go("#/agents/" + agent.id)}>Edit</button>
          <button class="btn btn--ghost" onclick={() => remove(agent)}>Delete</button>
        </div>
      </article>
    {:else}
      <p class="empty">
        No agents yet. Click <b>+ New agent</b> and fill in <b>AGENT.md</b> (working rules) and
        <b>SOUL.md</b> (who it is and what it owns).
      </p>
    {/each}
  </div>
</section>
