<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
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

  /**
   * The drawer closes in two steps: the panel slides while the scrim fades, and the scrim node unmounts
   * only when both are done. Re-opening during that window cancels the exit instead of blinking.
   */
  let drawerClosing = $state(false);
  let closeTimer: number | undefined;

  function openDrawer(): void {
    if (closeTimer) {
      window.clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    drawerClosing = false;
    drag = null;
    drawerOpen = true;
  }

  function closeDrawer(): void {
    if (!drawerOpen || drawerClosing) return;
    drag = null;
    drawerOpen = false;
    drawerClosing = true;
    closeTimer = window.setTimeout(() => {
      drawerClosing = false;
      closeTimer = undefined;
    }, 340);
  }

  /**
   * The drawer's edge-swipe gestures. While a finger drags, the panel's transform follows the pointer
   * directly (`transition: none`, the same exemption the diagram drag uses) and the release settles with
   * the normal ease: past a third of the panel's width, or with a quick flick, the drag commits.
   */
  type Drag = {
    dir: "open" | "close";
    from: number;
    width: number;
    offset: number;
    samples: { x: number; t: number }[];
    moved: boolean;
  };
  let drag = $state<Drag | null>(null);
  let sidebarEl = $state<HTMLElement | undefined>(undefined);
  /** A drag that moved swallows the click that would otherwise land under the released finger. */
  let suppressClick = false;

  function isPhone(): boolean {
    return window.matchMedia("(max-width: 720px)").matches;
  }

  /** Velocity over the drag's recent samples, in px/ms along the raw pointer x axis. */
  function dragVelocity(state: Drag): number {
    const first = state.samples[0];
    const last = state.samples[state.samples.length - 1];
    if (!first || !last || last.t === first.t) return 0;
    return (last.x - first.x) / (last.t - first.t);
  }

  function onDrawerPointerDown(event: PointerEvent): void {
    if (drag !== null || !isPhone() || !event.isPrimary || event.pointerType === "mouse") return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const x = event.clientX;
    if (!drawerOpen) {
      // The left 28px are the hot zone; the drawer button inside it keeps its own tap-to-toggle.
      if (x > 28 || target.closest(".drawer-btn") !== null) return;
    } else if (target.closest(".sidebar") === null && target.closest(".scrim") === null) {
      return;
    }
    if (!sidebarEl) return;
    drag = {
      dir: drawerOpen ? "close" : "open",
      from: x,
      width: sidebarEl.offsetWidth,
      offset: 0,
      samples: [{ x, t: performance.now() }],
      moved: false,
    };
    suppressClick = false;
  }

  function onDrawerPointerMove(event: PointerEvent): void {
    const state = drag;
    if (!state) return;
    const now = performance.now();
    state.samples.push({ x: event.clientX, t: now });
    const oldest = state.samples[0];
    if (state.samples.length > 2 && oldest && now - oldest.t > 120) state.samples.shift();
    const dx = state.dir === "open" ? event.clientX - state.from : state.from - event.clientX;
    state.offset = Math.max(0, Math.min(state.width, dx));
    if (!state.moved && Math.abs(event.clientX - state.from) > 8) state.moved = true;
  }

  function onDrawerPointerEnd(): void {
    const state = drag;
    if (!state) return;
    drag = null;
    suppressClick = state.moved;
    const progress = state.offset / Math.max(1, state.width);
    // A flick (fast) or a drag past a third of the panel commits; anything else settles back.
    const toward = state.dir === "open" ? dragVelocity(state) : -dragVelocity(state);
    const commit = progress > 0.35 || toward > 0.4;
    if (state.dir === "open") {
      if (commit) openDrawer();
    } else if (commit) {
      closeDrawer();
    }
  }

  function onDrawerPointerCancel(): void {
    drag = null;
    suppressClick = false;
  }

  /** A moved drag ends with a click the finger never intended; swallow that one click. */
  function onAppClickCapture(event: MouseEvent): void {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  /** The dragged panel position; undefined whenever the drawer is resting on its class-driven transform. */
  const drawerTransform = $derived.by(() => {
    const state = drag;
    if (!state || state.width <= 0) return undefined;
    const progress = Math.max(0, Math.min(1, state.offset / state.width));
    const visible = state.dir === "open" ? progress : 1 - progress;
    return `translateX(${-(1 - visible) * 100}%)`;
  });

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
    if (closeTimer) window.clearTimeout(closeTimer);
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

  /**
   * Any navigation closes the mobile drawer, so a tap never lands on a hidden view. The first run is the
   * initial route: it must not close a drawer opened by a deep link or the screenshot gate. The drawer call
   * reads its own state, so it is untracked: this effect follows the route, and nothing else.
   */
  let routeSeen = false;
  $effect(() => {
    // Serialised, because Route is a union and not every variant carries an id.
    JSON.stringify(route);
    if (!routeSeen) {
      routeSeen = true;
      return;
    }
    untrack(closeDrawer);
  });

  /**
   * One pane per route: the keyed wrapper remounts the view on navigation, and each mount plays the pane's
   * entrance once. The first mount happens under the opaque boot screen, so it is never seen twice.
   */
  const viewKey = $derived(JSON.stringify(route));
</script>

<div
  class="app"
  role="presentation"
  class:app--drawer={drawerOpen}
  onpointerdown={onDrawerPointerDown}
  onpointermove={onDrawerPointerMove}
  onpointerup={onDrawerPointerEnd}
  onpointercancel={onDrawerPointerCancel}
  onclickcapture={onAppClickCapture}
>
  <button
    class="drawer-btn"
    title="Threads"
    aria-label="Threads"
    aria-expanded={drawerOpen}
    data-testid="drawer-open"
    onclick={() => (drawerOpen ? closeDrawer() : openDrawer())}
  >
    <span class="drawer-btn__bars" aria-hidden="true">
      <span class="drawer-btn__bar"></span>
      <span class="drawer-btn__bar"></span>
      <span class="drawer-btn__bar"></span>
    </span>
  </button>
  {#if drawerOpen || drawerClosing}
    <button
      class="scrim"
      class:scrim--closing={drawerClosing}
      data-testid="drawer-close"
      title="Close"
      onclick={() => closeDrawer()}
    ></button>
  {/if}
  <aside
    class="sidebar"
    class:sidebar--dragging={drag !== null}
    bind:this={sidebarEl}
    style:transform={drawerTransform}
  >
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
    {#key viewKey}
      <div class="view">
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
      </div>
    {/key}
  </main>
  <CompletionToast />
</div>
