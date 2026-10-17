<script lang="ts">
  let {
    label,
    size = "md",
  }: {
    /** Read aloud by assistive tech, and used as the tooltip. */
    label: string;
    size?: "xs" | "sm" | "md";
  } = $props();
</script>

<span
  class="typing-dots typing-dots--{size}"
  role="status"
  aria-live="polite"
  title={label}
  data-testid="typing-dots"
>
  <span class="typing-dots__dot"></span>
  <span class="typing-dots__dot"></span>
  <span class="typing-dots__dot"></span>
  <span class="sr-only">{label}</span>
</span>
