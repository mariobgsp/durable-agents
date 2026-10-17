<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../api.ts";
  import { store } from "../state.svelte.ts";
  import { EMOJI_CHOICES, PALETTE, identityOfGroup, identityOfMember } from "../lib/identity.ts";
  import type { RoomMode, Session } from "../types.ts";
  import AgentAvatar from "./AgentAvatar.svelte";
  import Dialog from "./Dialog.svelte";

  let { session, onclose }: { session: Session; onclose: () => void } = $props();

  /**
   * The dialog is mounted fresh per open, so the values are read once as a snapshot; edits then live in
   * local state and only reach the server on Save.
   */
  const snapshot = untrack(() => ({ title: session.title, room: session.room! }));
  const room = snapshot.room;
  let title = $state(snapshot.title);
  let color = $state(room.color ?? PALETTE[0]!);
  let avatar = $state(room.avatar ?? "");
  let mode = $state<RoomMode>(room.mode);
  let moderator = $state(room.moderator ?? "");
  let maxHops = $state(room.maxHops);
  let maxResponders = $state(room.maxResponders);
  let ifNobodyClaims = $state<"highest" | "silent">(room.ifNobodyClaims);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const preview = $derived(
    identityOfGroup({ ...session, title, room: { ...room, color, avatar: avatar || undefined } }),
  );

  const MODES: { id: RoomMode; label: string; hint: string }[] = [
    { id: "nyahut", label: "Nyahut", hint: "Everyone may claim; the rest oversee." },
    { id: "moderator", label: "Moderator", hint: "One member answers and may call others." },
    { id: "silent", label: "Silent", hint: "Answers only when called with @name." },
  ];

  async function save(): Promise<void> {
    busy = true;
    error = null;
    try {
      if (title.trim() && title !== session.title) await api.renameSession(session.id, title.trim());
      await api.updateRoom(session.id, {
        mode,
        moderator: moderator || undefined,
        maxHops,
        maxResponders,
        ifNobodyClaims,
        color,
        avatar: avatar || undefined,
      });
      onclose();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog title="Group settings" {onclose}>
  {#snippet children()}
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <div class="bezel">
      <div class="bezel__core identity-card">
        <AgentAvatar identity={preview} size="lg" />
        <div class="identity-card__text">
          <b>{title || "Unnamed group"}</b>
          <span>{room.members.length} members · {mode}</span>
        </div>
      </div>
    </div>

    <label class="field">
      <span>Name</span>
      <input bind:value={title} data-testid="group-title" />
    </label>

    <div class="field">
      <span>Colour</span>
      <div class="swatches" data-testid="group-colors">
        {#each PALETTE as swatch (swatch)}
          <button
            class="swatch"
            class:swatch--active={swatch === color}
            style="--author: {swatch}"
            title={swatch}
            onclick={() => (color = swatch)}
          ></button>
        {/each}
      </div>
    </div>

    <div class="field">
      <span>Face (emoji)</span>
      <div class="emoji-grid" data-testid="group-emojis">
        {#each EMOJI_CHOICES as choice (choice)}
          <button
            class="emoji"
            class:emoji--active={choice === avatar}
            onclick={() => (avatar = avatar === choice ? "" : choice)}
          >{choice}</button>
        {/each}
      </div>
      <p class="hint">With no emoji, the group shows its members stacked instead.</p>
    </div>

    <div class="field">
      <span>Mode</span>
      <div class="modes" data-testid="group-modes">
        {#each MODES as item (item.id)}
          <button
            class="mode"
            class:mode--active={mode === item.id}
            title={item.hint}
            onclick={() => (mode = item.id)}
          >{item.label}</button>
        {/each}
      </div>
    </div>

    {#if mode === "moderator"}
      <label class="field">
        <span>Moderator</span>
        <select bind:value={moderator} data-testid="group-moderator">
          <option value="">(first member)</option>
          {#each room.members as member (member)}
            <option value={member}>@{member}</option>
          {/each}
        </select>
      </label>
    {/if}

    <div class="grid-2">
      <label class="field">
        <span>Max hops</span>
        <input type="number" min="1" max="20" bind:value={maxHops} data-testid="group-max-hops" />
      </label>
      <label class="field">
        <span>Max responders</span>
        <input type="number" min="1" max="10" bind:value={maxResponders} data-testid="group-max-responders" />
      </label>
    </div>

    <div class="field">
      <span>If nobody claims</span>
      <div class="modes">
        <button
          class="mode"
          class:mode--active={ifNobodyClaims === "highest"}
          onclick={() => (ifNobodyClaims = "highest")}
        >Highest</button>
        <button
          class="mode"
          class:mode--active={ifNobodyClaims === "silent"}
          onclick={() => (ifNobodyClaims = "silent")}
        >Silent</button>
      </div>
    </div>

    <div class="field">
      <span>Members</span>
      <div class="members" data-testid="group-members">
        {#each room.members as member (member)}
          {@const identity = identityOfMember(member, store.agents)}
          <span class="member-chip">
            <AgentAvatar {identity} size="xs" />
            @{member}
          </span>
        {/each}
      </div>
      <p class="hint">Membership is fixed at creation; move threads instead to change an agent's set.</p>
    </div>
  {/snippet}

  {#snippet actions()}
    <button class="btn" onclick={onclose}>Cancel</button>
    <button class="btn btn--primary" disabled={busy} onclick={save} data-testid="save-group">Save</button>
  {/snippet}
</Dialog>
