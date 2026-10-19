<script lang="ts">
  import { go } from "../router.svelte.ts";
  import {
    createSession,
    createThreadForAgent,
    deleteThread,
    moveThread,
    renameThread,
    restoreThread,
    isReplying,
    setAgentEnabled,
    store,
  } from "../state.svelte.ts";
  import { identityOfAgent, identityOfGroup, identityOfMember } from "../lib/identity.ts";
  import type { Session } from "../types.ts";
  import AgentAvatar from "./AgentAvatar.svelte";
  import Dialog from "./Dialog.svelte";
  import ActivityIndicator from "./ActivityIndicator.svelte";

  // Thread rows deliberately carry no avatar: the section header owns the agent's identity, and the
  // spine below it ties each row back to that one avatar.


  const COLLAPSE_KEY = "durable-agents.collapsed";
  const MODE_LABEL: Record<string, string> = { nyahut: "Nyahut", moderator: "Moderator", silent: "Silent" };

  let query = $state("");
  let searchOpen = $state(false);
  let searchInput = $state<HTMLInputElement | undefined>(undefined);

  $effect(() => {
    if (searchOpen) searchInput?.focus();
  });
  let collapsed = $state<Record<string, boolean>>(readCollapsed());
  let menu = $state<string | null>(null);
  let renaming = $state<Session | null>(null);
  let renameValue = $state("");
  let deleting = $state<Session | null>(null);
  let moving = $state<Session | null>(null);
  let moveTarget = $state("");

  function readCollapsed(): Record<string, boolean> {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  }

  function toggle(key: string): void {
    collapsed = { ...collapsed, [key]: !collapsed[key] };
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
  }

  const needle = $derived(query.trim().toLowerCase());

  function visible(session: Session, agentId?: string): boolean {
    if (needle === "") return true;
    return (
      session.title.toLowerCase().includes(needle) ||
      (session.agent ?? agentId ?? "").toLowerCase().includes(needle)
    );
  }

  const agentSections = $derived(
    store.agents.map((agent) => ({
      agent,
      threads: store.sessions.filter(
        (session) => session.kind !== "group" && session.agent === agent.id && visible(session, agent.id),
      ),
    })),
  );

  const plainThreads = $derived(
    store.sessions.filter(
      (session) => session.kind !== "group" && session.agent === undefined && visible(session),
    ),
  );

  const groups = $derived(store.sessions.filter((session) => session.kind === "group" && visible(session)));

  async function startRename(session: Session): Promise<void> {
    menu = null;
    renaming = session;
    renameValue = session.title;
  }

  async function commitRename(): Promise<void> {
    const session = renaming;
    if (!session) return;
    renaming = null;
    const next = renameValue.trim();
    if (next.length === 0 || next === session.title) return;
    await renameThread(session.id, next);
  }

  async function confirmDelete(): Promise<void> {
    const session = deleting;
    deleting = null;
    if (session) await deleteThread(session.id);
  }

  async function confirmMove(): Promise<void> {
    const session = moving;
    moving = null;
    if (session && moveTarget.length > 0) await moveThread(session.id, moveTarget);
  }

  /** A thread that belongs to no agent: it lands in the "No agent" section. */
  async function newPlainThread(): Promise<void> {
    const session = await createSession();
    if (session) go("#/s/" + session.id);
  }

  async function newThreadFor(agentId: string): Promise<void> {
    menu = null;
    const session = await createThreadForAgent(agentId);
    if (session) go("#/s/" + session.id);
  }
</script>

<div class="sidebar__block">
  <div class="sidebar__tools">
    <button class="btn btn--primary btn--block" onclick={newPlainThread} data-testid="new-thread">
      New thread<span class="btn__icon">+</span>
    </button>
    <button
      class="icon-btn sidebar__search-toggle"
      title={searchOpen ? "Hide search" : "Search threads"}
      aria-label={searchOpen ? "Hide search" : "Search threads"}
      aria-expanded={searchOpen}
      onclick={() => {
        searchOpen = !searchOpen;
        if (!searchOpen) query = "";
      }}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </button>
  </div>
  {#if searchOpen}
    <input
      class="search"
      type="search"
      placeholder="Search threads…"
      bind:this={searchInput}
      bind:value={query}
      data-testid="thread-search"
    />
  {/if}
</div>

<nav class="sections" data-testid="sidebar-sections">
  {#each agentSections as section (section.agent.id)}
    {@const identity = identityOfAgent(section.agent)}
    <section class="section" data-testid="agent-section-{section.agent.id}">
      <header class="section__head">
        <button class="section__toggle" onclick={() => toggle(section.agent.id)}>
          <span class="caret" class:caret--closed={collapsed[section.agent.id]}>▾</span>
          <AgentAvatar {identity} size="md" />
          <span class="section__name">{identity.label}</span>
          {#if section.agent.enabled === false}
            <span class="section__meta">off</span>
          {:else if section.threads.length > 0}
            <span class="section__meta">{section.threads.length}</span>
          {/if}
        </button>
        <button
          class="icon-btn"
          title="Agent actions"
          data-testid="agent-menu-{section.agent.id}"
          onclick={() => (menu = menu === "agent:" + section.agent.id ? null : "agent:" + section.agent.id)}
        >⋯</button>
      </header>

      {#if menu === "agent:" + section.agent.id}
        <div class="menu">
          <button class="menu__item" onclick={() => go("#/agents/" + section.agent.id)}>Edit agent</button>
          <button class="menu__item" onclick={() => newThreadFor(section.agent.id)}>New thread</button>
          <button
            class="menu__item"
            onclick={() => {
              menu = null;
              void setAgentEnabled(section.agent.id, section.agent.enabled === false);
            }}
          >
            {section.agent.enabled === false ? "Enable agent" : "Disable agent"}
          </button>
        </div>
      {/if}

      {#if !collapsed[section.agent.id]}
        <div class="threads">
          {#each section.threads as thread (thread.id)}
            {@render threadItem(thread, identity.color)}
          {:else}
            <p class="empty empty--tight">No threads yet.</p>
          {/each}
        </div>
      {/if}
    </section>
  {/each}

  <section class="section" data-testid="agent-section-none">
    <header class="section__head">
      <button class="section__toggle" onclick={() => toggle("none")}>
        <span class="caret" class:caret--closed={collapsed["none"]}>▾</span>
        <span class="group-chip" style="--author: var(--muted)">·</span>
        <span class="section__name">No agent</span>
        <span class="section__meta">{plainThreads.length}</span>
      </button>
    </header>
    {#if !collapsed["none"]}
      <div class="threads">
        {#each plainThreads as thread (thread.id)}
          {@render threadItem(thread, "var(--muted)")}
        {:else}
          <p class="empty empty--tight">No threads yet.</p>
        {/each}
      </div>
    {/if}
  </section>

  <section class="section section__group" data-testid="group-section">
    <header class="section__head">
      <button class="section__toggle" onclick={() => toggle("groups")}>
        <span class="caret" class:caret--closed={collapsed["groups"]}>▾</span>
        <span class="group-chip" style="--author: var(--accent)">#</span>
        <span class="section__name">Groups</span>
        <span class="section__meta">{groups.length}</span>
      </button>
    </header>
    {#if !collapsed["groups"]}
      <div class="threads">
        {#each groups as group (group.id)}
          {@const identity = identityOfGroup(group)}
          <button
            class="thread thread--group"
            class:thread--active={group.id === store.currentId}
            data-testid="group-{group.id}"
            onclick={() => go("#/s/" + group.id)}
          >
            {#if identity.emoji}
              <AgentAvatar {identity} size="md" />
            {:else}
              <span class="avatar-stack">
                {#each (group.room?.members ?? []).slice(0, 3) as member (member)}
                  <AgentAvatar identity={identityOfMember(member, store.agents)} size="sm" stacked />
                {/each}
              </span>
            {/if}
            <span class="thread__title">{identity.label}</span>
            <span
              class="thread__meta"
              title={group.room
                ? group.room.members.length + " members · " + (MODE_LABEL[group.room.mode] ?? "")
                : ""}
            >
              {#if isReplying(group.id)}
                <ActivityIndicator size="xs" label={identity.label + " is replying"} />
              {:else}
                {group.room ? group.room.members.length + " · " + (MODE_LABEL[group.room.mode] ?? "") : ""}
              {/if}
            </span>
          </button>
        {:else}
          <p class="empty empty--tight">No groups yet.</p>
        {/each}
      </div>
    {/if}
  </section>
</nav>

{#snippet threadItem(thread: Session, color: string)}
  {#if renaming?.id === thread.id}
    <form
      class="thread thread--editing"
      onsubmit={(event) => {
        event.preventDefault();
        void commitRename();
      }}
    >
      <input
        class="thread__input"
        bind:value={renameValue}
        data-testid="rename-input"
        onblur={() => void commitRename()}
        onkeydown={(event) => {
          if (event.key === "Escape") renaming = null;
        }}
      />
    </form>
  {:else}
    <div class="thread-row">
      <button
        class="thread"
        class:thread--active={thread.id === store.currentId}
        data-testid="thread-{thread.id}"
        style="--author: {color}"
        onclick={() => go("#/s/" + thread.id)}
      >
        <span class="thread__slot">
          {#if isReplying(thread.id)}
            <ActivityIndicator size="xs" label={thread.title + " is replying"} />
          {/if}
        </span>
        <span class="thread__title">{thread.title}</span>
      </button>
      <button
        class="icon-btn"
        title="Thread actions"
        data-testid="thread-menu-{thread.id}"
        onclick={() => (menu = menu === "thread:" + thread.id ? null : "thread:" + thread.id)}
      >⋯</button>
    </div>
    {#if menu === "thread:" + thread.id}
      <div class="menu">
        <button class="menu__item" onclick={() => startRename(thread)}>Rename</button>
        <button
          class="menu__item"
          onclick={() => {
            menu = null;
            moving = thread;
            moveTarget = thread.agent ?? store.agents[0]?.id ?? "";
          }}
        >Move to agent…</button>
        <button class="menu__item menu__item--danger" onclick={() => { menu = null; deleting = thread; }}>
          Delete
        </button>
      </div>
    {/if}
  {/if}
{/snippet}

{#if deleting}
  {@const target = deleting}
  <Dialog title="Delete thread?" onclose={() => (deleting = null)}>
    {#snippet children()}
      <p>
        <b>{target.title}</b> disappears from the list. Its transcript stays in SQLite until a purge, so
        it can be restored from the API.
      </p>
    {/snippet}
    {#snippet actions()}
      <button class="btn" onclick={() => (deleting = null)}>Cancel</button>
      <button class="btn btn--danger" onclick={confirmDelete} data-testid="confirm-delete">Delete</button>
    {/snippet}
  </Dialog>
{/if}

{#if moving}
  {@const target = moving}
  <Dialog title="Move thread to another agent" onclose={() => (moving = null)}>
    {#snippet children()}
      <label class="field">
        <span>Agent</span>
        <select bind:value={moveTarget} data-testid="move-select">
          {#each store.agents as agent (agent.id)}
            <option value={agent.id}>{identityOfAgent(agent).label}</option>
          {/each}
        </select>
      </label>
      <p class="empty">
        <b>{target.title}</b> keeps its transcript and picks up the new agent's model and instructions.
      </p>
    {/snippet}
    {#snippet actions()}
      <button class="btn" onclick={() => (moving = null)}>Cancel</button>
      <button class="btn btn--primary" onclick={confirmMove} data-testid="confirm-move">Move</button>
    {/snippet}
  </Dialog>
{/if}

{#if store.sessions.some((session) => session.deletedAt !== undefined)}
  <div class="sidebar__foot-note">
    Deleted threads are hidden.
    <button
      class="link"
      onclick={() => void restoreThread(store.sessions.find((session) => session.deletedAt)!.id)}
    >Restore last</button>
  </div>
{/if}
