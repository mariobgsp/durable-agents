<script lang="ts">
  import { initialsOf, inkOn, type Identity } from "../lib/identity.ts";

  let {
    identity,
    size = "md",
    stacked = false,
  }: {
    identity: Identity;
    size?: "xs" | "sm" | "md" | "lg";
    /** Stacked avatars overlap inside a group row and carry a ring in the surface colour. */
    stacked?: boolean;
  } = $props();

  const initials = $derived(identity.emoji ? "" : initialsOf(identity.label));
</script>

<span
  class="avatar avatar--{size}"
  class:avatar--stacked={stacked}
  style="--author: {identity.color}; --ink: {inkOn(identity.color)}"
  title={identity.label}
  data-testid="avatar-{identity.id}"
  data-kind={identity.kind}
>
  <span class="avatar__core">
    {#if identity.emoji}
      <span class="avatar__face">{identity.emoji}</span>
    {:else}
      <span class="avatar__initials">{initials}</span>
    {/if}
  </span>
</span>
