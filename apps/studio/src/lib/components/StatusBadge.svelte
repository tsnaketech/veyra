<script lang="ts">
  import { revisionLabels, toneClass } from '#lib/ui.ts';

  let { status }: { status: string | null } = $props();
  const info = $derived(
    status ? revisionLabels[status] : { label: 'Aucune vidéo', tone: 'neutral' as const }
  );
</script>

<span class="badge {toneClass[info.tone]}" data-status={status ?? 'none'}>{info.label}</span>
