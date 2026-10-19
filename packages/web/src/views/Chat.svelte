<script lang="ts">
  import { go } from "../router.svelte.ts";
  import {
    abort,
    loadSessions,
    renameThread,
    isReplying,
    restartThread,
    send,
    setAgentEnabled,
    setThreadGrant,
    store,
  } from "../state.svelte.ts";
  import {
    identityOfAgent,
    identityOfAuthor,
    identityOfGroup,
    identityOfMember,
    type Identity,
  } from "../lib/identity.ts";
  import { activityRender } from "../lib/activity.ts";
  import { elapsedText } from "../lib/activity.ts";
  import { shownDrafts, shownFiles } from "../lib/attachments.ts";
  import { isInternalLink } from "../lib/markdown.ts";
  import type { DraftFile, Msg, RoomMode } from "../types.ts";
  import AgentAvatar from "../components/AgentAvatar.svelte";
  import GroupSettings from "../components/GroupSettings.svelte";
  import ContextBar from "../components/ContextBar.svelte";
  import ToolCallRow from "../components/ToolCallRow.svelte";
  import ActivityIndicator from "../components/ActivityIndicator.svelte";
  import ActivityStrip from "../components/ActivityStrip.svelte";
  import Attachments from "../components/Attachments.svelte";
  import Composer from "../components/Composer.svelte";
  import Markdown from "../components/Markdown.svelte";
  import QuestionOptions from "../components/QuestionOptions.svelte";

  // A group bubble shows the speaker's own colour and face, so a room reads like several people talking.


  let settings = $state(false);
  let scroller = $state<HTMLDivElement | undefined>(undefined);
  let editingTitle = $state(false);
  let titleDraft = $state("");

  const session = $derived(store.sessions.find((s) => s.id === store.currentId) ?? null);
  const room = $derived(session?.room ?? null);
  const agent = $derived(
    session?.agent ? (store.agents.find((entry) => entry.id === session.agent) ?? null) : null,
  );
  const agentDisabled = $derived(agent !== null && agent.enabled === false);
  /** Whether this thread has been granted Full Access. Per-thread, so it dies with the thread. */
  const granted = $derived(session?.grant === "full");
  /** What to call the agent in a direct thread: its own name, never the generic word "agent". */
  const agentName = $derived(agent?.name || agent?.id || "agent");
  /**
   * Waiting for the first token, or already streaming: either way this thread is replying. Presence is
   * included so returning to a thread mid-answer still shows it, before any delta has arrived.
   */
  const replying = $derived(store.busy || isReplying(store.currentId));
  /**
   * What the composer says. Short by design: the keyboard hint and the `@name` rule are discoverable, and
   * the long form was clipped mid-sentence at 390 px.
   */
  const placeholder = $derived(
    replying ? "Steer the reply…" : room ? "Write to the group…" : "Write a message…",
  );
  const groupIdentity = $derived(session ? identityOfGroup(session) : null);
  const members = $derived(
    (room?.members ?? []).map((member) => identityOfMember(member, store.agents)),
  );
  /**
   * Which indicator this frame gets. One decision point, so the chat can never show two at once.
   */
  const indicator = $derived(
    activityRender({ replying, live: store.live, activity: store.activity, group: room !== null }),
  );
  /**
   * Whether files may be attached here. A group refuses them — every member would need its own copy — so the
   * affordance is hidden with the reason rather than offering a button that always fails.
   */
  const attach = $derived(
    room
      ? { allowed: false, reason: "A group cannot take attachments. Send it in a direct thread." }
      : { allowed: true },
  );

  /**
   * The newest user message. A question before it has been answered: the thread moved on after it, so its
   * options can never apply again.
   */
  const lastUserAt = $derived(
    store.entries.reduce((last, entry, index) => (entry.role === "user" ? index : last), -1),
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
  const currentMode = $derived(MODES.find((mode) => mode.id === room?.mode) ?? null);

  /** The choices a `chat.question` message offers, or null for every other message. */
  function questionOptions(message: Msg): string[] | null {
    if (message.kind !== "chat.question") return null;
    const data = message.data as { options?: unknown } | null | undefined;
    if (!data || !Array.isArray(data.options)) return null;
    const options = data.options.filter(
      (option): option is string => typeof option === "string" && option.trim().length > 0,
    );
    return options.length > 0 ? options : null;
  }

  /**
   * In-app navigation for links inside rendered markdown.
   *
   * The bubbles are injected HTML, so the anchors are not Svelte nodes and cannot carry their own handler.
   * One delegated listener on the timeline is enough; external anchors already carry `target="_blank"` from
   * the sanitizer, so only a hash link is intercepted and handed to the router.
   */
  function inAppLinks(node: HTMLElement) {
    function onClick(event: MouseEvent): void {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const href = target.closest("a[href]")?.getAttribute("href") ?? "";
      if (!isInternalLink(href)) return;
      event.preventDefault();
      go(href);
    }
    node.addEventListener("click", onClick);
    return { destroy: () => node.removeEventListener("click", onClick) };
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

  /**
   * The composer's one job: hand the draft to the store and say whether the server took it.
   *
   * On a refusal the store has already shown the server's own sentence, and the draft is left exactly where
   * the user put it — the server wrote nothing, so nothing is lost by trying again.
   */
  async function onSend(draft: { text: string; files: DraftFile[] }): Promise<boolean> {
    try {
      await send(draft, replying ? "steer" : undefined);
      return true;
    } catch {
      return false;
    }
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

  /**
   * Grant or revoke Full Access for this thread.
   *
   * Confirmed on grant only: the consequence is worth one click of friction, and revoking is always safe.
   */
  async function toggleGrant(): Promise<void> {
    const target = session;
    if (!target) return;
    if (granted) {
      await setThreadGrant(target.id, null);
      return;
    }
    const ok = window.confirm(
      "Give this thread Full Access?\n\n" +
        "It will run as you: it can read your SSH keys, your browser profile, and every file you can. " +
        "The grant applies to this thread only, and you can revoke it right here.",
    );
    if (ok) await setThreadGrant(target.id, "full");
  }

  async function enableAgent(): Promise<void> {
    if (!agent) return;
    await setAgentEnabled(agent.id, true);
    await loadSessions();
  }

  /**
   * Re-pin the scroll when an image finishes loading.
   *
   * An attachment's height is only known once its bytes arrive, so a picture that loads after the entries
   * render pushes the newest message below the fold. A `load` event does not bubble, which is why this is
   * bound in the capture phase.
   */
  function onTimelineLoad(): void {
    const el = scroller;
    if (!el) return;
    queueMicrotask(() => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 320) el.scrollTop = el.scrollHeight;
    });
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
      <button
        class="chat__avatar"
        title={"Edit " + agentName}
        aria-label={"Edit " + agentName}
        data-testid="agent-chip"
        onclick={() => go("#/agents/" + agent.id)}
      >
        <AgentAvatar identity={identityOfAgent(agent)} size="lg" />
      </button>
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
        <button
          class="chip chip--link"
          title={currentMode?.hint ?? "Group settings"}
          data-testid="group-settings-chip"
          onclick={() => (settings = true)}
        >
          {currentMode?.label ?? "Mode"}
        </button>
      {/if}
      {#if session?.agent}
        <button
          class="chip chip--link"
          class:chip--danger={granted}
          title={granted
            ? "This thread may run anything you can. Click to revoke."
            : "Let this thread run anything you can. It runs as you, and you can revoke it here."}
          data-testid="grant-chip"
          onclick={toggleGrant}
        >
          {granted ? "Full Access (this thread)" : "Full Access: off"}
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

  <div
    class="timeline"
    bind:this={scroller}
    use:inAppLinks
    onloadcapture={onTimelineLoad}
    data-testid="timeline"
  >
    {#each store.entries as message, index (message.id)}
      {@const options = questionOptions(message)}
      {#if message.role === "tool" && message.tool}
        <!-- The durable half of the trace: a call that already finished, replayed from the transcript. -->
        <div class="toolhistory" data-testid="tool-line">
          <ToolCallRow
            name={message.tool.name}
            variant="inline"
            output={message.text}
            isError={message.tool.isError}
            durationMs={message.tool.durationMs}
            nested={message.tool.nested}
          />
        </div>
      {:else if message.role === "system"}
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
            {#if firstOfRun(index)}
              <div class="msg__who" style="--author: {identity.color}">{label(message)}</div>
            {/if}
            <div class="msg__body"><Markdown text={message.text} /></div>
            {#if options}
              <QuestionOptions
                {options}
                answered={lastUserAt > index}
                onanswer={(option) => onSend({ text: option, files: [] })}
              />
            {/if}
          </div>
        </article>
      {:else}
        <article class="msg msg--{message.role}" data-testid="msg-{message.role}">
          {#if message.files && session}
            <Attachments files={shownFiles(session.id, message.id, message.files)} />
          {/if}
          {#if message.text}
            <div class="msg__body"><Markdown text={message.text} /></div>
          {/if}
        </article>
      {/if}
    {/each}

    {#if indicator === "strip"}
      <ActivityStrip activity={store.activity} now={store.now} />
    {/if}

    {#if indicator === "bubble" && !store.live}
      <article class="msg msg--assistant msg--identity" data-testid="msg-typing">
        <span class="msg__spacer"></span>
        <div class="msg__stack">
          <div class="msg__who">{room ? "the group" : agentName}</div>
          <div class="msg__typing">
            <ActivityIndicator
              phase={room ? null : store.activity.phase}
              label={(room ? "The group" : agentName) + " is replying"}
              elapsed={room ? "" : elapsedText(store.activity.since, store.now)}
            />
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
            <ActivityIndicator
              size="sm"
              phase={store.activity.phase}
              showLabel={false}
              label={(room ? "The group" : agentName) + " is replying"}
              elapsed={room ? "" : elapsedText(store.activity.since, store.now)}
            />
          </div>
          <div class="msg__body"><Markdown text={store.streamingText} /></div>
        </div>
      </article>
    {/if}

    {#each store.pending as item (item.requestId)}
      <article class="msg msg--user msg--pending" data-testid="msg-pending">
        {#if item.files.length > 0}
          <Attachments files={shownDrafts(item.files)} />
        {/if}
        {#if item.text}
          <div class="msg__body">{item.text}</div>
        {/if}
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

  {#if store.error}
    <p class="error" role="alert" data-testid="error">{store.error}</p>
  {/if}

  <Composer {placeholder} {replying} {attach} onsend={onSend} />

  <!-- Under the box, not in it: context used and the model it is measured against. -->
  <ContextBar />
</section>
