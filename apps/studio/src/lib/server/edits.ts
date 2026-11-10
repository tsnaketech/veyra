import { isDeepStrictEqual } from 'node:util';
import { applyProposal } from '@veyra/ai';
import {
  audioCompositionSchema,
  captionTrackSchema,
  storyboardSchema,
  type EditOperation,
  type InvalidationPlan,
  type ScenePatch,
  type VideoRevision
} from '@veyra/schemas';
import { captionDeliverySchema, reusableVariant } from './jobs/runner';
import { buildFallbackCaptions, refreshCaptions } from './studio';
import { ToolFailure } from './tools/registry';

/** What an edit changes in a revision; `delivery` is null without captions. */
export type EditState = Pick<VideoRevision, 'storyboard' | 'audio' | 'captions'> & {
  delivery: 'burned' | 'clean' | 'both' | null;
};
export const editState = (
  revision: Pick<VideoRevision, 'storyboard' | 'audio' | 'captions'> & {
    resolvedConfig: Record<string, unknown>;
  }
): EditState => ({
  storyboard: revision.storyboard,
  audio: revision.audio,
  captions: revision.captions,
  delivery: revision.captions
    ? captionDeliverySchema.parse(revision.resolvedConfig.captionDelivery)
    : null
});

const conflict = (message: string) => new ToolFailure('conflict', message);
type Cue = NonNullable<EditState['captions']>['cues'][number];
// What a viewer sees of a cue: regrouping renumbers ids and word indexes.
const shown = (c: Cue) => JSON.stringify([c.startMs, c.endMs, c.lines]);
const targetOf = (op: EditOperation) =>
  'sceneId' in op
    ? op.sceneId
    : 'trackId' in op
      ? op.trackId
      : 'cueId' in op
        ? op.cueId
        : 'assetId' in op
          ? op.assetId
          : '';

/**
 * Applies every operation to a copy of the parent state, all or nothing: the first
 * conflict (missing target, same target edited twice, cue rebuilt by another edit) or
 * invalid result throws a ToolFailure and nothing is returned.
 */
export function applyEdits(
  parent: EditState,
  operations: EditOperation[],
  options: { maxDurationMs: number; usableAsset(assetId: string): boolean }
): EditState & { warnings: string[] } {
  const seen = new Set<string>();
  const sceneIds = new Set(parent.storyboard.scenes.map((s) => s.id));
  const tracks = parent.audio?.tracks ?? [];
  for (const op of operations) {
    const key = `${op.op}:${targetOf(op)}`;
    if (seen.has(key))
      throw conflict(`Deux opérations ${op.op} sur la même cible (${targetOf(op)})`);
    seen.add(key);
    if ('sceneId' in op && !sceneIds.has(op.sceneId))
      throw conflict(`Scène introuvable : ${op.sceneId}`);
    if (op.op === 'audio.track' && !tracks.some((t) => t.id === op.trackId))
      throw conflict(`Piste introuvable : ${op.trackId}`);
    if (op.op === 'media.replace') {
      if (!tracks.some((t) => t.assetId === op.assetId))
        throw conflict(`Aucune piste n'utilise le média ${op.assetId}`);
      if (!options.usableAsset(op.withAssetId))
        throw conflict(`Média de remplacement introuvable ou invalide : ${op.withAssetId}`);
    }
    if (op.op === 'captions.cue' && !parent.captions?.cues.some((c) => c.id === op.cueId))
      throw conflict(`Cue introuvable : ${op.cueId}`);
  }
  const invalid = (error: unknown) =>
    new ToolFailure(
      'invalid-input',
      `Opération refusée : ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
    );

  let storyboard = parent.storyboard;
  const changes = operations.flatMap<{ sceneId: string; patch: ScenePatch }>((op) =>
    op.op === 'scene.update'
      ? [{ sceneId: op.sceneId, patch: op.patch }]
      : op.op === 'scene.animation'
        ? [{ sceneId: op.sceneId, patch: { animationMs: op.animationMs } }]
        : op.op === 'scene.transition'
          ? [{ sceneId: op.sceneId, patch: { enter: op.enter } }]
          : op.op === 'scene.duration'
            ? [{ sceneId: op.sceneId, patch: { durationMs: op.durationMs } }]
            : []
  );
  const warnings: string[] = [];
  try {
    if (changes.length) storyboard = applyProposal(storyboard, changes, options.maxDurationMs);
    const narrated = operations.filter((op) => op.op === 'voice.narration');
    if (narrated.length)
      storyboard = storyboardSchema.parse({
        ...storyboard,
        scenes: storyboard.scenes.map((scene) => {
          const op = narrated.find((o) => o.sceneId === scene.id);
          if (!op) return scene;
          const { narration, ...rest } = scene;
          return op.text ? { ...rest, narration: { ...narration, text: op.text } } : rest;
        })
      });
    for (const op of narrated)
      if (
        tracks.some(
          (t) =>
            t.category === 'voiceover' &&
            t.anchor.type === 'event' &&
            t.anchor.sceneId === op.sceneId
        )
      )
        warnings.push(`La voix de la scène ${op.sceneId} correspond encore à l'ancien texte.`);

    // Same caption rule as Studio.newRevision: moved, resized or re-narrated scenes get
    // fresh fallback words; a first narration creates the track (as Studio.setNarration).
    let captions = parent.captions;
    if (captions) {
      const refreshed = refreshCaptions(parent.storyboard, storyboard, captions, storyboard);
      captions = refreshed.captions;
      warnings.push(...refreshed.warnings);
    } else if (narrated.length) {
      const track = buildFallbackCaptions(storyboard, storyboard);
      captions = track.words.length ? track : null;
    }
    for (const op of operations) {
      if (op.op !== 'captions.cue') continue;
      const before = parent.captions!.cues.find((c) => c.id === op.cueId)!;
      const now = captions?.cues.find((c) => c.id === op.cueId);
      if (!captions || !now || shown(now) !== shown(before))
        throw conflict(`Le cue ${op.cueId} est reconstruit par une autre opération de ce lot`);
      captions = captionTrackSchema.parse({
        ...captions,
        cues: captions.cues.map((c) => (c.id === op.cueId ? { ...c, lines: op.lines } : c))
      });
    }

    let audio = parent.audio;
    if (audio) {
      const replace = new Map(
        operations.flatMap((op) =>
          op.op === 'media.replace' ? [[op.assetId, op.withAssetId]] : []
        )
      );
      // Same merge as audio.track.update, revalidated as a full composition.
      audio = audioCompositionSchema.parse({
        ...audio,
        tracks: audio.tracks.map((t) => {
          const patch = operations.find((op) => op.op === 'audio.track' && op.trackId === t.id);
          return {
            ...t,
            ...(patch?.op === 'audio.track' ? patch.patch : {}),
            assetId: replace.get(t.assetId) ?? t.assetId
          };
        })
      });
    }
    const mode = operations.findLast((op) => op.op === 'captions.delivery');
    const delivery = captions
      ? mode?.op === 'captions.delivery'
        ? mode.mode
        : (parent.delivery ?? 'burned')
      : null;
    return { storyboard, audio, captions, delivery, warnings };
  } catch (error) {
    if (error instanceof ToolFailure) throw error;
    throw invalid(error);
  }
}

const without = <T extends object>(value: T, ...keys: string[]) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
const end = (s: EditState) => Math.max(0, ...s.storyboard.scenes.map((x) => x.start + x.duration));

/**
 * Pure plan of what the child's render rebuilds and what it reuses from the parent. Only
 * the parent's silent picture is reusable today (RenderJobRunner.reusablePicture, same
 * rule via reusableVariant; its file is checked at render time). There is no per-scene
 * cache (T130): a rebuilt picture re-renders every scene; mix, mux, SRT/VTT and QA run
 * at every render. Scene and target lists say what the edits actually change.
 */
export function invalidationPlan(
  parentId: string,
  parent: EditState,
  child: EditState
): InvalidationPlan {
  const before = new Map(parent.storyboard.scenes.map((s) => [s.id, s]));
  const burnedOut = child.captions !== null && child.delivery !== 'clean';
  const shownIn = (s: EditState) => new Set((s.captions?.cues ?? []).map(shown));
  const oldShown = shownIn(parent),
    newShown = shownIn(child);
  const changed = [
    ...(child.captions?.cues ?? []).filter((c) => !oldShown.has(shown(c))),
    ...(parent.captions?.cues ?? []).filter((c) => !newShown.has(shown(c)))
  ];
  const changedCues = [...new Set(changed.map((c) => c.id))];
  // Windows of changed cues (child and parent times): the burned scenes they cross.
  const windows = changed;
  const sceneWords = (s: EditState, id: string) =>
    JSON.stringify(s.captions?.words.filter((w) => w.sceneId === id) ?? []);
  const wordsChanged =
    JSON.stringify(parent.captions?.words ?? null) !==
    JSON.stringify(child.captions?.words ?? null);
  const scenes = child.storyboard.scenes.map((scene) => {
    const old = before.get(scene.id)!;
    const burnedChange =
      burnedOut &&
      (windows.some((c) => c.startMs < scene.start + scene.duration && c.endMs > scene.start) ||
        sceneWords(parent, scene.id) !== sceneWords(child, scene.id));
    const change = !isDeepStrictEqual(
      without(old, 'start', 'narration'),
      without(scene, 'start', 'narration')
    )
      ? ('content' as const)
      : old.start !== scene.start
        ? ('timing' as const)
        : burnedChange
          ? ('captions' as const)
          : ('unchanged' as const);
    return { sceneId: scene.id, change };
  });
  const touched = (...kinds: string[]) =>
    scenes.filter((s) => kinds.includes(s.change)).map((s) => s.sceneId);

  type Entry = InvalidationPlan['artefacts'][number];
  const reused = (artefact: Entry['artefact']): Entry => ({
    artefact,
    status: 'reused',
    cause: null,
    reusedFrom: parentId,
    targets: []
  });
  const invalidated = (
    artefact: Entry['artefact'],
    cause: NonNullable<Entry['cause']>,
    targets: string[] = []
  ): Entry => ({ artefact, status: 'invalidated', cause, reusedFrom: null, targets });
  const picture = (artefact: 'picture' | 'picture-clean', burned: boolean): Entry => {
    const variant = reusableVariant(parent, child, burned);
    const produced =
      variant === 'plain' ||
      (variant === 'clean' && parent.delivery !== 'burned') ||
      (variant === 'burned' && parent.delivery !== 'clean');
    if (variant && produced) return reused(artefact);
    if (variant) return invalidated(artefact, 'parent-lacks-variant');
    return invalidated(
      artefact,
      'operation',
      burned ? touched('content', 'timing', 'captions') : touched('content', 'timing')
    );
  };

  const artefacts: Entry[] = [];
  // Same variants as the runner: main picture unless clean only; clean when asked.
  if (child.delivery !== 'clean') artefacts.push(picture('picture', burnedOut));
  if (child.delivery === 'clean' || child.delivery === 'both')
    artefacts.push(picture('picture-clean', false));
  if (child.audio?.tracks.length) {
    const old = new Map((parent.audio?.tracks ?? []).map((t) => [t.id, JSON.stringify(t)]));
    const moved = new Set(touched('content', 'timing'));
    // Event anchors follow their scene; a new total length moves fades and loops.
    const targets =
      end(parent) !== end(child)
        ? child.audio.tracks.map((t) => t.id)
        : child.audio.tracks
            .filter(
              (t) =>
                old.get(t.id) !== JSON.stringify(t) ||
                (t.anchor.type === 'event' && moved.has(t.anchor.sceneId))
            )
            .map((t) => t.id);
    const master =
      JSON.stringify(parent.audio?.master ?? null) !== JSON.stringify(child.audio.master);
    artefacts.push(
      targets.length || master
        ? invalidated('mix', 'operation', targets)
        : invalidated('mix', 'no-reuse-mechanism')
    );
  }
  if (child.captions)
    artefacts.push(
      changedCues.length || wordsChanged
        ? invalidated('captions-sidecars', 'operation', changedCues)
        : invalidated('captions-sidecars', 'no-reuse-mechanism')
    );
  artefacts.push(
    invalidated('video', 'no-reuse-mechanism'),
    invalidated('qa-report', 'no-reuse-mechanism')
  );
  return { scenes, artefacts };
}
