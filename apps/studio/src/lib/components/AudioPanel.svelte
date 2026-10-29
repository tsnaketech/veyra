<script lang="ts">
  import { enhance } from '$app/forms';
  import { audioCategorySchema, type AudioTrack, type TimelineEvent } from '@veyra/schemas';
  import type { PageData } from '../../routes/projects/[id]/$types';
  import { timecode } from '#lib/ui.ts';
  import Icon from './Icon.svelte';
  let {
    assets,
    revision,
    events,
    resolved,
    maxFileBytes,
    busy
  }: {
    assets: PageData['assets'];
    revision: PageData['revisions'][number] | null;
    events: TimelineEvent[];
    resolved: {
      tracks: { trackId: string; startMs: number; endMs: number }[];
      issues: { trackId: string; code: string; message: string }[];
    } | null;
    maxFileBytes: number;
    busy: boolean;
  } = $props();
  const categories = audioCategorySchema.options;
  const labels = {
    music: 'Musique',
    voiceover: 'Voix off',
    sfx: 'Effet sonore',
    ambience: 'Ambiance'
  };
  const validAssets = $derived(assets.filter((a) => a.audio?.status === 'valid'));
  const duration = $derived(
    revision ? Math.max(...revision.storyboard.scenes.map((s) => s.start + s.duration)) : 1
  );
  const editable = $derived(revision?.status === 'awaiting_approval');
  let tracks = $state<AudioTrack[]>([]);
  let loadedId = $state<string | null>(null);
  let assetId = $state('');
  let category = $state<AudioTrack['category']>('music');
  let anchorMode = $state('absolute');
  let atMs = $state(0);
  let eventKey = $state('');
  let localError = $state('');
  $effect(() => {
    if (loadedId !== (revision?.id ?? null)) {
      tracks = structuredClone(revision?.audio?.tracks ?? []);
      loadedId = revision?.id ?? null;
      localError = '';
    }
  });
  const availableEvents = $derived(events.filter((e) => e.sceneId));
  const eventLabel = (event: TimelineEvent) =>
    `scène ${(revision?.storyboard.scenes.findIndex((s) => s.id === event.sceneId) ?? -1) + 1} · ${event.name} #${event.index + 1}`;
  const anchorLabel = (track: AudioTrack) => {
    const a = track.anchor;
    return a.type === 'absolute'
      ? `absolu ${(a.atMs / 1000).toLocaleString('fr-FR')} s`
      : `scène ${(revision?.storyboard.scenes.findIndex((s) => s.id === a.sceneId) ?? -1) + 1} · ${a.event} #${a.index + 1} ${a.offsetMs >= 0 ? '+' : ''} ${a.offsetMs} ms`;
  };
  const trackLabel = (id: string) => revision?.audio?.tracks.find((t) => t.id === id)?.label ?? id;
  function addTrack() {
    const asset = validAssets.find((a) => a.id === assetId);
    const event = availableEvents.find((e) => e.id === eventKey);
    if (!asset || (anchorMode === 'event' && !event) || !Number.isFinite(atMs) || atMs < 0) {
      localError = 'Choisissez un fichier valide et un ancrage valide.';
      return;
    }
    tracks.push({
      id: `atr_${crypto.randomUUID()}`,
      assetId,
      label: asset.name,
      category,
      anchor:
        anchorMode === 'absolute'
          ? { type: 'absolute', atMs }
          : {
              type: 'event',
              sceneId: event!.sceneId!,
              event: event!.name,
              index: event!.index,
              edge: 'start',
              offsetMs: 0
            },
      sourceInMs: 0,
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      loop: false,
      duck: []
    });
    localError = '';
  }
</script>

<section aria-label="Bande son" data-testid="audio-panel" class="space-y-3">
  <h2 class="font-medium"><Icon name="file" class="inline size-4" /> Bande son</h2>
  <form
    method="POST"
    action="?/importAudio"
    enctype="multipart/form-data"
    use:enhance
    class="space-y-2"
  >
    <label class="block" for="audio-file"
      >Fichier audio (maximum {Math.floor(maxFileBytes / 1048576)} Mio)</label
    >
    <input id="audio-file" name="file" type="file" accept="audio/*" required class="field" />
    <label class="block" for="audio-category">Catégorie du fichier</label>
    <select id="audio-category" name="category" class="field"
      >{#each categories as c (c)}<option value={c}>{labels[c]}</option>{/each}</select
    >
    <button class="btn">Importer l’audio</button>
  </form>
  <ul class="space-y-1 text-xs" aria-live="polite">
    {#each assets.filter((a) => a.audio) as asset (asset.id)}
      <li>
        {asset.name} · {asset.audio?.status === 'valid' ? 'Valide' : 'Refusé'}
        {#if asset.audio?.error}<p class="text-bad">{asset.audio.error}</p>{/if}
        {#if asset.audio?.metadata}{@const m = asset.audio.metadata}
          <p class="text-muted">
            {(Number(m.durationMs) / 1000).toLocaleString('fr-FR')} s · {m.codec} · {m.sampleRate} Hz
            · {m.channels} canal(aux)
          </p>{/if}
      </li>
    {/each}
  </ul>
  {#if revision}
    <h3 class="font-medium">Pistes de cette révision</h3>
    <ul class="space-y-2 text-xs">
      {#each revision.audio?.tracks ?? [] as track (track.id)}
        <li>
          <strong>{track.label}</strong> · {labels[track.category]} · {track.gainDb} dB · fondus {track.fadeInMs}/{track.fadeOutMs}
          ms · boucle {track.loop ? 'oui' : 'non'}
          <p>{anchorLabel(track)}</p>
        </li>
      {/each}
    </ul>
    {#if resolved}
      <div
        role="group"
        aria-label="Chronologie audio"
        class="space-y-2 text-xs"
        data-testid="audio-timeline"
      >
        <div class="flex justify-between text-muted">
          <span>0 s</span><span>{(duration / 2000).toFixed(1)} s</span><span
            >{(duration / 1000).toFixed(1)} s</span
          >
        </div>
        {#each resolved.tracks as track (track.trackId)}
          <p>{trackLabel(track.trackId)} · {timecode(track.startMs)} → {timecode(track.endMs)}</p>
          <!-- Visual only: the line above carries the same information as text. -->
          <div class="relative h-3 rounded bg-raised" aria-hidden="true">
            <div
              class="absolute h-3 rounded bg-cyan"
              style:left={`${Math.min(100, (track.startMs / duration) * 100)}%`}
              style:width={`${(Math.max(0, Math.min(duration, track.endMs) - track.startMs) / duration) * 100}%`}
            ></div>
          </div>
        {/each}
      </div>
      {#if resolved.issues.length}<ul role="alert" class="text-xs text-warn">
          {#each resolved.issues as issue, i (i)}<li>
              {trackLabel(issue.trackId)} : {issue.message}
            </li>{/each}
        </ul>{/if}
    {/if}
    {#if editable}
      <form method="POST" action="?/reviseAudio" use:enhance class="space-y-2">
        <input type="hidden" name="revisionId" value={revision.id} />
        <input
          type="hidden"
          name="composition"
          value={JSON.stringify({
            schemaVersion: 1,
            tracks,
            ...(revision.audio?.master ? { master: revision.audio.master } : {})
          })}
        />
        {#each tracks as track, i (track.id)}
          <fieldset class="space-y-1 rounded border border-line p-2">
            <legend class="text-xs">{track.label}</legend>
            <label class="block"
              >Gain (dB)<input
                class="field"
                type="number"
                min="-60"
                max="12"
                step="0.1"
                bind:value={tracks[i].gainDb}
                required
              /></label
            >
            <label class="block"
              >Fondu entrant (ms)<input
                class="field"
                type="number"
                min="0"
                bind:value={tracks[i].fadeInMs}
                required
              /></label
            >
            <label class="block"
              >Fondu sortant (ms)<input
                class="field"
                type="number"
                min="0"
                bind:value={tracks[i].fadeOutMs}
                required
              /></label
            >
            {#if track.category === 'music'}<label
                ><input type="checkbox" bind:checked={tracks[i].loop} /> Boucler la musique</label
              >{/if}
          </fieldset>
        {/each}
        <fieldset class="space-y-1 rounded border border-line p-2">
          <legend>Ajouter une piste</legend>
          <label class="block" for="track-asset">Fichier de la piste</label><select
            id="track-asset"
            class="field"
            bind:value={assetId}
            ><option value="">Choisir un fichier</option
            >{#each validAssets as asset (asset.id)}<option value={asset.id}>{asset.name}</option
              >{/each}</select
          >
          <label class="block" for="track-category">Catégorie de la piste</label><select
            id="track-category"
            class="field"
            bind:value={category}
            >{#each categories as c (c)}<option value={c}>{labels[c]}</option>{/each}</select
          >
          <label class="block" for="track-anchor">Ancrage</label><select
            id="track-anchor"
            class="field"
            bind:value={anchorMode}
            ><option value="absolute">Temps absolu</option><option value="event"
              >Événement de scène</option
            ></select
          >
          {#if anchorMode === 'absolute'}<label class="block"
              >Début absolu (ms)<input
                type="number"
                min="0"
                max={duration - 1}
                class="field"
                bind:value={atMs}
              /></label
            >
          {:else}<label class="block" for="track-event">Événement</label><select
              id="track-event"
              class="field"
              bind:value={eventKey}
              ><option value="">Choisir un événement</option
              >{#each availableEvents as event (event.id)}<option value={event.id}
                  >{eventLabel(event)}</option
                >{/each}</select
            >{/if}
          <button type="button" class="btn" onclick={addTrack}>Ajouter à la composition</button>
        </fieldset>
        <p aria-live="polite" class="text-xs">
          {tracks.length} piste(s) dans la composition à enregistrer.
        </p>
        {#if localError}<p role="alert" class="text-bad">{localError}</p>{/if}
        <button class="btn" disabled={busy}>Enregistrer la bande son</button>
        <p class="text-xs text-muted">Crée une nouvelle révision en réutilisant l’image.</p>
      </form>
    {/if}
  {/if}
</section>
