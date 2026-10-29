<script lang="ts">
  // Decorative glyphs only: the control around them carries the accessible name.
  let {
    name,
    class: className = 'size-4'
  }: {
    name: 'play' | 'pause' | 'previous-frame' | 'next-frame' | 'file';
    class?: string;
  } = $props();
</script>

<svg viewBox="0 0 24 24" class={className} aria-hidden="true" focusable="false" fill="currentColor">
  {#if name === 'play'}
    <path d="M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5Z" />
  {:else if name === 'pause'}
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  {:else if name === 'previous-frame'}
    <rect x="5" y="5" width="2.5" height="14" rx="1" />
    <path
      d="M19 6.2v11.6a1 1 0 0 1-1.55.83L9.6 13.66a2 2 0 0 1 0-3.32l7.85-4.97A1 1 0 0 1 19 6.2Z"
    />
  {:else if name === 'next-frame'}
    <rect x="16.5" y="5" width="2.5" height="14" rx="1" />
    <path d="M5 6.2v11.6a1 1 0 0 0 1.55.83l7.85-4.97a2 2 0 0 0 0-3.32L6.55 5.37A1 1 0 0 0 5 6.2Z" />
  {:else}
    <path
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linejoin="round"
      d="M7 3.5h7l4.5 4.5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15.5a1 1 0 0 1 1-1Zm7 0V8h4.5"
    />
  {/if}
</svg>
