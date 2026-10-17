<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { route, go } from "./router.svelte.ts";
  import {
    store,
    createSession,
    loadAgents,
    loadSessions,
    openSession,
    unwatchActivity,
    watchActivity,
  } from "./state.svelte.ts";
  import Sidebar from "./components/Sidebar.svelte";
  import AgentEditor from "./views/AgentEditor.svelte";
  import Agents from "./views/Agents.svelte";
  import Groups from "./views/Groups.svelte";
  import Providers from "./views/Providers.svelte";
  import Chat from "./views/Chat.svelte";

  let drawerOpen = $state(false);

  onMount(() => {
    watchActivity();
    void loadAgents();
    void loadSessions();
  });

  onDestroy(() => {
    unwatchActivity();
  });

  $effect(() => {
    if (route.name === "session" && route.id !== store.currentId) void openSession(route.id);
  });

  async function newThread() {
    const session = await createSession();
    if (session) go("#/s/" + session.id);
  }

  const status = $derived(
    store.connection === "open" ? "connected" : store.connection === "closed" ? "reconnecting…" : "idle",
  );
  const onAgents = $derived(route.name === "agents" || route.name === "agent");
  const onProviders = $derived(route.name === "providers");

  // Any navigation closes the mobile drawer, so a tap never lands on a hidden view.
  $effect(() => {
    // Serialised, because Route is a union and not every variant carries an id.
    JSON.stringify(route);
    drawerOpen = false;
  });
</script>

<div class="app" class:app--drawer={drawerOpen}>
  <button class="drawer-btn" title="Threads" data-testid="drawer-open" onclick={() => (drawerOpen = true)}>☰</button>
  {#if drawerOpen}
    <button class="scrim" data-testid="drawer-close" title="Close" onclick={() => (drawerOpen = false)}></button>
  {/if}
  <aside class="sidebar">
    <header class="sidebar__head">
      <span class="brand">Durable Agents</span>
    </header>

    <Sidebar />

    <footer class="sidebar__foot">
      <button class="tab" class:tab--active={onAgents} onclick={() => go("#/agents")}>Agents</button>
      <button class="tab" class:tab--active={onProviders} onclick={() => go("#/providers")}>Models</button>
      <span class="foot-status"><span class="dot" class:dot--on={store.connection === "open"}></span>{status}</span>
    </footer>
  </aside>

  <main class="main">
    {#if route.name === "session"}
      <Chat />
    {:else if route.name === "groups"}
      <Groups />
    {:else if route.name === "providers"}
      <Providers />
    {:else if route.name === "agents"}
      <Agents />
    {:else if route.name === "agent"}
      <AgentEditor id={route.id} />
    {:else}
      <div class="placeholder" data-testid="placeholder">
        <div class="bezel">
          <div class="bezel__core empty-state">
            <span class="eyebrow">Durable agents</span>
            <h1>Start here</h1>
            <p>
          Every agent gets a section in the sidebar with its threads underneath. Pick an agent, create a
          thread, and send a message. Everything is stored on disk — close the browser or restart the
          server and it is still there.
        </p>
            <button class="btn btn--primary" onclick={newThread}>
              New thread<span class="btn__icon">+</span>
            </button>
          </div>
        </div>
      </div>
    {/if}
  </main>
</div>
