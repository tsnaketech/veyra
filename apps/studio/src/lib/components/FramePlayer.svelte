<script lang="ts">
  import {
    frameAt,
    frameFromPts,
    frameCount,
    frameSeekSeconds,
    frameTimestampMs,
    sceneAt,
    stepFrame,
    type MediaInfo,
    type Storyboard
  } from '@veyra/schemas';
  import { preciseTimecode } from '#lib/ui.ts';

  type Marker = { id: string; timestampMs: number; frameIndex: number | null; label: string };
  let {
    src,
    media,
    storyboard,
    markers = [],
    frame = $bindable(0),
    onMarker
  }: {
    src: string;
    media: MediaInfo | null;
    storyboard: Storyboard;
    markers?: Marker[];
    frame?: number;
    onMarker?: (id: string) => void;
  } = $props();

  const durationMs = $derived(
    media?.durationMs ?? Math.max(0, ...storyboard.scenes.map((s) => s.start + s.duration))
  );
  // Measured rate when the render was probed; nominal storyboard rate otherwise.
  const rate = $derived(
    media ? { num: media.fpsNum, den: media.fpsDen } : { num: Math.round(storyboard.fps), den: 1 }
  );
  const count = $derived(media?.frameCount ?? frameCount(durationMs, rate));
  const fps = $derived(rate.num / rate.den);
  const frameMs = $derived(frameTimestampMs(frame, rate));
  const scene = $derived(sceneAt(storyboard, frameMs));

  let video = $state<HTMLVideoElement>();
  let paused = $state(true);

  // Track the frame actually presented: requestVideoFrameCallback reports its media time.
  $effect(() => {
    const element = video;
    if (!element) return;
    const sync = (ms: number) => (frame = frameAt(ms, rate, count));
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      let handle = 0;
      const onFrame = (_: number, meta: VideoFrameCallbackMetadata) => {
        frame = frameFromPts(meta.mediaTime * 1000, rate, count);
        handle = element.requestVideoFrameCallback(onFrame);
      };
      handle = element.requestVideoFrameCallback(onFrame);
      return () => element.cancelVideoFrameCallback(handle);
    }
    // Fallback: currentTime may lie anywhere inside a frame.
    const onTime = () => sync(element.currentTime * 1000);
    element.addEventListener('seeked', onTime);
    element.addEventListener('timeupdate', onTime);
    return () => {
      element.removeEventListener('seeked', onTime);
      element.removeEventListener('timeupdate', onTime);
    };
  });

  export function seekFrame(index: number) {
    const target = stepFrame(index, 0, count);
    video?.pause();
    frame = target;
    // Seek to the middle of the frame so the decoder lands on it.
    if (video) video.currentTime = frameSeekSeconds(target, rate);
  }
  function step(delta: number) {
    seekFrame(stepFrame(frame, delta, count));
  }
  function toggle() {
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }
  function onKey(event: KeyboardEvent) {
    if ((event.target as HTMLElement).closest('input[type=text], textarea, select')) return;
    const second = Math.max(1, Math.round(fps));
    const actions: Record<string, () => void> = {
      ArrowLeft: () => step(event.shiftKey ? -second : -1),
      ArrowRight: () => step(event.shiftKey ? second : 1),
      ',': () => step(-1),
      '.': () => step(1),
      Home: () => seekFrame(0),
      End: () => seekFrame(count - 1),
      ' ': toggle,
      k: toggle
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  }
</script>

<!-- Composite widget: arrow keys step frames while the player has focus. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="space-y-3 outline-none focus-visible:ring-2 focus-visible:ring-cyan"
  role="group"
  aria-label="Lecteur vidéo : ← → image par image, Maj + ← → une seconde, Espace lecture/pause"
  tabindex="0"
  onkeydown={onKey}
>
  <div class="panel flex aspect-video items-center justify-center overflow-hidden bg-black">
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={video}
      bind:paused
      {src}
      preload="auto"
      class="h-full w-full"
      data-testid="player"
      onclick={toggle}
    ></video>
  </div>

  <div class="panel space-y-3 p-3">
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <button class="btn px-2" onclick={() => step(-1)} aria-label="Image précédente">⏮</button>
      <button class="btn w-24" onclick={toggle} data-testid="play"
        >{paused ? '▶ Lecture' : '⏸ Pause'}</button
      >
      <button class="btn px-2" onclick={() => step(1)} aria-label="Image suivante">⏭</button>
      <span class="font-mono tabular-nums" data-testid="frame-info">
        Frame <span data-testid="frame-index">{frame}</span> / {Math.max(0, count - 1)} ·
        {preciseTimecode(frameMs)} / {preciseTimecode(durationMs)}
      </span>
      <span class="text-xs text-muted">
        {Number.isInteger(fps) ? fps : fps.toFixed(3)} i/s{media ? '' : ' (nominal, non mesuré)'}
      </span>
      {#if media && !media.constantFrameRate}
        <span class="badge border-warn/50 text-warn"
          >Fréquence variable : sélection approximative, la capture serveur fait foi</span
        >
      {/if}
    </div>

    <label class="block">
      <span class="sr-only">Position (frame)</span>
      <input
        type="range"
        min="0"
        max={Math.max(0, count - 1)}
        step="1"
        value={frame}
        oninput={(e) => seekFrame(Number(e.currentTarget.value))}
        class="w-full accent-cyan"
        data-testid="scrubber"
      />
    </label>

    <div
      class="relative flex h-10 overflow-hidden rounded-md border border-line"
      aria-label="Scènes"
    >
      {#each storyboard.scenes as item, index (item.id)}
        <button
          class="truncate border-r border-line px-2 text-left text-xs hover:bg-raised {scene?.id ===
          item.id
            ? 'bg-violet/25'
            : ''}"
          style="width: {(item.duration / durationMs) * 100}%"
          title={item.text}
          onclick={() => seekFrame(frameAt(item.start, rate, count))}
          >{index + 1}. {item.text}</button
        >
      {/each}
      <span
        class="pointer-events-none absolute top-0 h-full w-px bg-white"
        style="left: {(frameMs / durationMs) * 100}%"
      ></span>
    </div>
    {#if markers.length}
      <div class="relative h-4" aria-label="Annotations sur la timeline">
        {#each markers as marker (marker.id)}
          <button
            class="absolute top-0 h-4 w-2 -translate-x-1 rounded-sm bg-cyan hover:bg-white"
            style="left: {(marker.timestampMs / durationMs) * 100}%"
            title={marker.label}
            aria-label="Aller à l'annotation : {marker.label}"
            data-testid="marker"
            onclick={() => {
              seekFrame(marker.frameIndex ?? frameAt(marker.timestampMs, rate, count));
              onMarker?.(marker.id);
            }}
          ></button>
        {/each}
      </div>
    {/if}
  </div>
</div>
