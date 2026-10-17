<script lang="ts">
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import { go } from "../router.svelte.ts";
  import {
    abort,
    loadSessions,
    renameThread,
    isReplying,
    restartThread,
    send,
    setAgentEnabled,
    store,
    updateRoomMode,
  } from "../state.svelte.ts";
  import {
    identityOfAgent,
    identityOfAuthor,
    identityOfGroup,
    identityOfMember,
    type Identity,
  } from "../lib/identity.ts";
  import type { Msg, RoomMode } from "../types.ts";
  import AgentAvatar from "../components/AgentAvatar.svelte";
  import GroupSettings from "../components/GroupSettings.svelte";
  import TypingDots from "../components/TypingDots.svelte";

  // A group bubble shows the speaker's own colour and face, so a room reads like several people talking.


  let settings = $state(false);
  let text = $state("");
  let scroller = $state<HTMLDivElement | undefined>(undefined);
  let area = $state<HTMLTextAreaElement | undefined>(undefined);
  let editingTitle = $state(false);
  let titleDraft = $state("");

  const session = $derived(store.sessions.find((s) => s.id === store.currentId) ?? null);
  const room = $derived(session?.room ?? null);
  const agent = $derived(
    session?.agent ? (store.agents.find((entry) => entry.id === session.agent) ?? null) : null,
  );
  const agentDisabled = $derived(agent !== null && agent.enabled === false);
  /** What to call the agent in a direct thread: its own name, never the generic word "agent". */
  const agentName = $derived(agent?.name || agent?.id || "agent");
  /**
   * Waiting for the first token, or already streaming: either way this thread is replying. Presence is
   * included so returning to a thread mid-answer still shows it, before any delta has arrived.
   */
  const replying = $derived(store.busy || isReplying(store.currentId));
  const groupIdentity = $derived(session ? identityOfGroup(session) : null);
  const members = $derived(
    (room?.members ?? []).map((member) => identityOfMember(member, store.agents)),
  );

  const MODES: { id: RoomMode; label: string; hint: string }[] = [
    {
      id: "nyahut",
      label: "Nyahut",
      hint: "whoever feels responsible answers; the rest oversee and may add (cost: 2×members short calls plus full answers)",
    },
    { id: "moderator", label: "Moderator", hint: "one designated member answers and may call others" },
    { id: "silent", label: "Silent", hint: "only answers when called with @name" },
  ];

  function render(src: string): string {
    return DOMPurify.sanitize(marked.parse(src, { async: false }) as string);
  }

  function identityFor(message: Msg): Identity {
    // A direct thread's transcript carries no author, so the identity is the agent's own: this is what
    // gives the bubble its colour and face instead of the neutral "you" fallback.
    if (!message.author && agent) return identityOfAgent(agent);
    return identityOfAuthor(message.author, store.agents);
  }

  function label(message: Msg): string {
    if (message.role === "user") return "you";
    if (message.role === "assistant") return message.author ?? agentName;
    return message.role;
  }

  /** The avatar shows on the first message of a run by the same author, keeping long chats scannable. */
  function firstOfRun(index: number): boolean {
    const message = store.entries[index];
    if (!message) return false;
    if (message.role !== "assistant") return false;
    const previous = store.entries[index - 1];
    return previous === undefined || previous.author !== message.author;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    text = "";
    await send(value);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      area?.closest("form")?.requestSubmit();
    }
  }

  async function setMode(mode: RoomMode) {
    if (!session || session.room?.mode === mode) return;
    await updateRoomMode(session.id, mode);
    await loadSessions();
  }

  function startTitleEdit(): void {
    titleDraft = session?.title ?? "";
    editingTitle = true;
  }

  async function commitTitle(): Promise<void> {
    const target = session;
    editingTitle = false;
    const next = titleDraft.trim();
    if (!target || next.length === 0 || next === target.title) return;
    await renameThread(target.id, next);
  }

  async function enableAgent(): Promise<void> {
    if (!agent) return;
    await setAgentEnabled(agent.id, true);
    await loadSessions();
  }

  $effect(() => {
    const el = scroller;
    const pinned = store.entries.length;
    const live = store.streamingText.length;
    if (!el || (pinned === 0 && live === 0)) return;
    queueMicrotask(() => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 260) el.scrollTop = el.scrollHeight;
    });
  });
</script>

<section class="chat">
  <header class="chat__head">
    {#if room && groupIdentity}
      {#if groupIdentity.emoji}
        <AgentAvatar identity={groupIdentity} size="lg" />
      {:else}
        <span class="avatar-stack">
          {#each members.slice(0, 4) as member (member.id)}
            <AgentAvatar identity={member} size="sm" stacked />
          {/each}
        </span>
      {/if}
    {:else if agent}
      <AgentAvatar identity={identityOfAgent(agent)} size="lg" />
    {/if}

    {#if editingTitle}
      <form
        class="chat__title-form"
        onsubmit={(event) => {
          event.preventDefault();
          void commitTitle();
        }}
      >
        <input
          class="chat__title-input"
          bind:value={titleDraft}
          data-testid="title-input"
          onblur={() => void commitTitle()}
          onkeydown={(event) => {
            if (event.key === "Escape") editingTitle = false;
          }}
        />
      </form>
    {:else}
      <button class="chat__title" data-testid="chat-title" title="Rename this thread" onclick={startTitleEdit}>
        {session?.title || "Thread"}
      </button>
    {/if}

    <div class="chat__meta">
      {#if room}
        <span class="chip" data-testid="group-chip">{members.length} members</span>
        <div class="modes" data-testid="mode-switch">
          {#each MODES as mode (mode.id)}
            <button
              class="mode"
              class:mode--active={room.mode === mode.id}
              title={mode.hint}
              onclick={() => setMode(mode.id)}
            >
              {mode.label}
            </button>
          {/each}
        </div>
      {:else if session?.agent}
        <button class="chip chip--link" onclick={() => go("#/agents/" + session?.agent)} data-testid="agent-chip">
          @{session.agent}
        </button>
      {/if}
      {#if session?.model}
        <span class="chip" data-testid="model-chip">{session.model.provider}/{session.model.modelId}</span>
      {/if}
      {#if room}
        <button class="icon-btn" title="Group settings" data-testid="open-group-settings" onclick={() => (settings = true)}>
          ⚙
        </button>
      {/if}
      {#if store.busy}
        <button class="btn btn--ghost" onclick={abort} data-testid="stop">Stop</button>
      {/if}
    </div>
  </header>

  {#if settings && session}
    <GroupSettings {session} onclose={() => (settings = false)} />
  {/if}

  {#if agentDisabled}
    <div class="notice" data-testid="agent-disabled">
      <span>@{agent?.id} is disabled, so this thread will not answer.</span>
      <button class="btn btn--small" onclick={enableAgent} data-testid="enable-agent">Enable agent</button>
      <button
        class="btn btn--small"
        onclick={() => session && restartThread(session.id)}
        data-testid="restart-thread"
      >
        Restart thread
      </button>
    </div>
  {/if}

  <div class="timeline" bind:this={scroller} data-testid="timeline">
    {#each store.entries as message, index (message.id)}
      {#if message.role === "system"}
        <p class="sys" data-testid="msg-system">{message.text}</p>
      {:else if message.role === "assistant"}
        {@const identity = identityFor(message)}
        <article class="msg msg--assistant msg--identity" data-testid="msg-assistant">
          {#if firstOfRun(index)}
            <AgentAvatar {identity} size="md" />
          {:else}
            <span class="msg__spacer"></span>
          {/if}
          <div class="msg__stack">
            <div class="msg__who" style="--author: {identity.color}">{label(message)}</div>
            <div class="msg__body">{@html render(message.text)}</div>
          </div>
        </article>
      {:else}
        <article class="msg msg--{message.role}" data-testid="msg-{message.role}">
          <div class="msg__who">{label(message)}</div>
          <div class="msg__body">{@html render(message.text)}</div>
        </article>
      {/if}
    {/each}

    {#if replying && !store.live}
      <article class="msg msg--assistant msg--identity" data-testid="msg-typing">
        <span class="msg__spacer"></span>
        <div class="msg__stack">
          <div class="msg__who">{room ? "the group" : agentName}</div>
          <div class="msg__typing">
            <TypingDots label={(room ? "The group" : agentName) + " is replying"} />
          </div>
        </div>
      </article>
    {/if}

    {#if store.live}
      <article class="msg msg--assistant msg--live msg--identity" data-testid="msg-live">
        <span class="msg__spacer"></span>
        <div class="msg__stack">
          <div class="msg__who">
            {room ? "the group" : agentName}
            <TypingDots size="sm" label={(room ? "The group" : agentName) + " is replying"} />
          </div>
          <div class="msg__body">{@html render(store.streamingText)}</div>
        </div>
      </article>
    {/if}

    {#each store.pending as item, index (item.at + "-" + index)}
      <article class="msg msg--user msg--pending" data-testid="msg-pending">
        <div class="msg__who">you</div>
        <div class="msg__body">{item.text}</div>
      </article>
    {/each}

    {#if store.entries.length === 0 && store.pending.length === 0 && !store.live}
      <p class="empty">
        {room
          ? "Empty. Call a member with @name, or just send a message."
          : "Empty. Send the first message to start."}
      </p>
    {/if}
  </div>

  {#if store.typing.length > 0}
    <p class="typing" data-testid="typing">
      <TypingDots size="sm" label={store.typing.join(", ") + " replying"} />
      <span>{store.typing.map((name) => "@" + name).join(" · ")} replying…</span>
    </p>
  {/if}

  {#if store.error}
    <p class="error" role="alert" data-testid="error">{store.error}</p>
  {/if}

  <form class="composer" onsubmit={submit}>
    <textarea
      bind:this={area}
      bind:value={text}
      rows="1"
      placeholder={room
        ? "Write to the group… use @name to call a member"
        : "Write a message… (Enter sends, Shift+Enter adds a line)"}
      data-testid="composer"
      onkeydown={onKeydown}
    ></textarea>
    <button class="btn btn--primary" type="submit" disabled={store.busy}>Send</button>
  </form>
</section>
