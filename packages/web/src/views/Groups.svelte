<script lang="ts">
  import { api } from "../api.ts";
  import type { AgentRecord, RoomMode, Session } from "../types.ts";
  import { go } from "../router.svelte.ts";
  import { loadSessions, store } from "../state.svelte.ts";
  import GroupSettings from "../components/GroupSettings.svelte";

  let settings = $state<Session | null>(null);
  let agents = $state<AgentRecord[]>([]);
  let title = $state("");
  let selected = $state<string[]>([]);
  let error = $state<string | null>(null);
  let busy = $state(false);

  const groups = $derived(store.sessions.filter((session) => session.kind === "group"));
  const MODE_LABEL: Record<RoomMode, string> = {
    nyahut: "Nyahut",
    moderator: "Moderator",
    silent: "Silent",
  };

  $effect(() => {
    void loadAgents();
  });

  async function loadAgents(): Promise<void> {
    try {
      agents = (await api.agents()).agents;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function toggle(member: string): void {
    selected = selected.includes(member)
      ? selected.filter((item) => item !== member)
      : [...selected, member];
  }

  async function create(): Promise<void> {
    if (selected.length === 0) {
      error = "Pick at least one agent";
      return;
    }
    busy = true;
    error = null;
    try {
      const room = await api.createRoom(title || "New group", selected);
      title = "";
      selected = [];
      await loadSessions();
      go("#/s/" + room.id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<section class="page">
  <header class="page__head">
    <h2 class="page__title">Groups</h2>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <div class="panel">
    <h3 class="panel__title">New group</h3>
    <label class="field">
      <span>Group name</span>
      <input bind:value={title} placeholder="Crew dapur" data-testid="group-name" />
    </label>
    <div class="field">
      <span>Member</span>
      {#each agents as agent (agent.id)}
        <label class="check">
          <input type="checkbox" checked={selected.includes(agent.id)} onchange={() => toggle(agent.id)} />
          <span><b>@{agent.id}</b> — {agent.responsibility || agent.name}</span>
        </label>
      {:else}
        <p class="empty">No agents yet. Create one in the <b>Agents</b> tab first.</p>
      {/each}
    </div>
    <button class="btn btn--primary" disabled={busy} onclick={create} data-testid="create-group">Create group</button>
  </div>

  <div class="cards" data-testid="group-list">
    {#each groups as group (group.id)}
      <article class="card">
        <header class="card__head">
          <h3 class="card__title">{group.title}</h3>
          <span class="chip">{group.room ? MODE_LABEL[group.room.mode] : "—"}</span>
        </header>
        <p class="card__line">{group.room?.members.map((member) => "@" + member).join(" · ")}</p>
        <div class="card__actions">
          <button class="btn btn--primary" onclick={() => go("#/s/" + group.id)}>Open</button>
          <button class="btn" data-testid="group-settings-{group.id}" onclick={() => (settings = group)}>
            Settings
          </button>
        </div>
      </article>
    {:else}
      <p class="empty">No groups yet.</p>
    {/each}
  </div>
</section>

{#if settings}
  <GroupSettings session={settings} onclose={() => (settings = null)} />
{/if}
