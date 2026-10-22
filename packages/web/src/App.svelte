<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { route, go } from "./router.svelte.ts";
  import {
    store,
    createSession,
    loadAgents,
    loadDisplay,
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
  import Usage from "./views/Usage.svelte";
  import System from "./views/System.svelte";
  import Chat from "./views/Chat.svelte";
  import NotifyButton from "./components/NotifyButton.svelte";
  import CompletionToast from "./components/CompletionToast.svelte";
  import { bindBootControls, bootFailed, finishBoot, startBootWatch } from "./lib/boot.ts";
  import { brandOf } from "./lib/display.ts";

  const brand = $derived(brandOf(store.display));

  // The screenshot gate can open the phone drawer so the notification popover is photographed in its real
  // context; desktop ignores it because the sidebar is already visible.
  let drawerOpen = $state(
    new URLSearchParams(location.search).has("drawer") && window.matchMedia("(max-width: 720px)").matches,
  );

  onMount(() => {
    void bootApp();
  });

  /**
   * Wait for the two lists the shell needs, not for usage, fleet details or diagrams. The boot screen must
   * disappear as soon as the app can be used; a slower report stays a local loading state inside its view.
   */
  async function bootApp(): Promise<void> {
    startBootWatch();
    bindBootControls();
    watchActivity();
    const started = performance.now();
    const [sessions, agents] = await Promise.all([loadSessions(), loadAgents(), loadDisplay()]);
    // A very fast local server would otherwise flash a loading screen for one frame. The minimum is short
    // enough not to delay a real boot and long enough for the screen to read as a transition.
    const elapsed = performance.now() - started;
    if (elapsed < 120) await new Promise((done) => setTimeout(done, 120 - elapsed));
    if (sessions || agents) finishBoot();
    else bootFailed();
  }

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
  const onUsage = $derived(route.name === "usage");
  const onSystem = $derived(route.name === "system");

  // Any navigation closes the mobile drawer, so a tap never lands on a hidden view. The first run is the
  // initial route: it must not close a drawer opened by a deep link or the screenshot gate.
  let routeSeen = false;
  $effect(() => {
    // Serialised, because Route is a union and not every variant carries an id.
    JSON.stringify(route);
    if (!routeSeen) {
      routeSeen = true;
      return;
    }
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
      <span class="brand" title={brand.tagline}>
        {#if brand.logo}<span class="brand__logo">{brand.logo}</span>{/if}{brand.name}
      </span>
      <span class="sidebar__head-actions">
        <NotifyButton />
        <span class="foot-status" title={status} aria-label={"Server " + status}>
          <span class="dot" class:dot--on={store.connection === "open"}></span>
        </span>
      </span>
    </header>

    <Sidebar />

    <footer class="sidebar__foot">
      <button class="tab" class:tab--active={onAgents} onclick={() => go("#/agents")}>Agents</button>
      <button class="tab" class:tab--active={onProviders} onclick={() => go("#/providers")}>Models</button>
      <button class="tab" class:tab--active={onUsage} onclick={() => go("#/usage")}>Usage</button>
      <button class="tab" class:tab--active={onSystem} onclick={() => go("#/system")}>System</button>
    </footer>
  </aside>

  <main class="main">
    {#if route.name === "session"}
      <Chat />
    {:else if route.name === "groups"}
      <Groups />
    {:else if route.name === "providers"}
      <Providers />
    {:else if route.name === "usage"}
      <Usage />
    {:else if route.name === "system"}
      <System />
    {:else if route.name === "agents"}
      <Agents />
    {:else if route.name === "agent"}
      <AgentEditor id={route.id} />
    {:else}
      <div class="placeholder" data-testid="placeholder">
        <div class="bezel">
          <div class="bezel__core empty-state">
            <h1>Start here</h1>
            <p>Pick a thread, or start one.</p>
            <button class="btn btn--primary" onclick={newThread}>
              New thread<span class="btn__icon">+</span>
            </button>
          </div>
        </div>
      </div>
    {/if}
  </main>
  <CompletionToast />
</div>