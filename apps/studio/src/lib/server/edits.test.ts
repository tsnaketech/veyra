import { describe, expect, it } from 'vitest';
import { editOperationSchema, storyboardSchema, type EditOperation } from '@veyra/schemas';
import { applyEdits, invalidationPlan, type EditState } from './edits';
import { captionDeliverySchema } from './jobs/runner';
import { buildFallbackCaptions } from './studio';
import { ToolFailure } from './tools/registry';

const PARENT = 'rev_parent';
const [s1, s2, s3] = ['scn_one', 'scn_two', 'scn_three'];
const storyboard = storyboardSchema.parse({
  width: 1920,
  height: 1080,
  fps: 30,
  scenes: [s1, s2, s3].map((id, i) => ({
    id,
    start: i * 3000,
    duration: 3000,
    text: `Scène ${i + 1}`,
    narration: { text: `Voici la scène numéro ${i + 1} de la vidéo` }
  }))
});
const audio = {
  schemaVersion: 1 as const,
  master: { targetLufs: -16, truePeakDb: -1 },
  tracks: [
    {
      id: 'atr_music',
      assetId: 'ast_music',
      category: 'music' as const,
      label: 'Musique',
      anchor: { type: 'absolute' as const, atMs: 0 },
      sourceInMs: 0,
      gainDb: -18,
      fadeInMs: 0,
      fadeOutMs: 0,
      loop: true,
      duck: []
    },
    {
      id: 'atr_rush',
      assetId: 'ast_rush',
      category: 'ambience' as const,
      label: 'Ambiance',
      anchor: { type: 'absolute' as const, atMs: 1000 },
      sourceInMs: 0,
      gainDb: -12,
      fadeInMs: 0,
      fadeOutMs: 0,
      loop: false,
      duck: []
    }
  ]
};
const captions = buildFallbackCaptions(storyboard, storyboard);
const state = (delivery: EditState['delivery']): EditState => ({
  storyboard,
  audio,
  captions,
  delivery
});
const options = { maxDurationMs: 60_000, usableAsset: (id: string) => id === 'ast_new' };
const ops = (...raw: unknown[]) => raw.map((op) => editOperationSchema.parse(op) as EditOperation);
function plan(parent: EditState, ...raw: unknown[]) {
  const child = applyEdits(parent, ops(...raw), options);
  const result = invalidationPlan(PARENT, parent, child);
  const by = Object.fromEntries(result.artefacts.map((a) => [a.artefact, a]));
  const changed = Object.fromEntries(result.scenes.map((s) => [s.sceneId, s.change]));
  const byOperation = result.artefacts
    .filter((a) => a.cause === 'operation')
    .map((a) => a.artefact)
    .sort();
  return { child, result, by, changed, byOperation };
}
const cueOf = (sceneId: string) => {
  const start = storyboard.scenes.find((s) => s.id === sceneId)!.start;
  return captions.cues.find((c) => c.startMs >= start && c.startMs < start + 3000)!;
};

describe('invalidation graph (required rules)', () => {
  it('music only: pictures reused from the parent, only the mix is invalidated by the edit', () => {
    const { by, changed, byOperation } = plan(state('both'), {
      op: 'audio.track',
      trackId: 'atr_music',
      patch: { gainDb: -6 }
    });
    expect(by.picture).toMatchObject({ status: 'reused', reusedFrom: PARENT });
    expect(by['picture-clean']).toMatchObject({ status: 'reused', reusedFrom: PARENT });
    expect(by.mix).toMatchObject({
      status: 'invalidated',
      cause: 'operation',
      targets: ['atr_music']
    });
    expect(byOperation).toEqual(['mix']);
    expect(Object.values(changed).every((c) => c === 'unchanged')).toBe(true);
    // Rebuilt at every render (no cache), never because of this edit.
    for (const a of ['captions-sidecars', 'video', 'qa-report'])
      expect(by[a]).toMatchObject({ status: 'invalidated', cause: 'no-reuse-mechanism' });
  });

  it('burned caption: the burned picture of the concerned scene only; the clean picture is reused', () => {
    const cue = cueOf(s2);
    const { by, changed, byOperation } = plan(state('both'), {
      op: 'captions.cue',
      cueId: cue.id,
      lines: ['Texte corrigé']
    });
    expect(by.picture).toMatchObject({ status: 'invalidated', cause: 'operation', targets: [s2] });
    expect(by['picture-clean']).toMatchObject({ status: 'reused' });
    expect(changed).toEqual({ [s1]: 'unchanged', [s2]: 'captions', [s3]: 'unchanged' });
    expect(by['captions-sidecars']).toMatchObject({ cause: 'operation', targets: [cue.id] });
    expect(byOperation).toEqual(['captions-sidecars', 'picture']);
  });

  it('exported caption only (clean delivery): SRT/VTT only, the clean picture is reused', () => {
    const { by, changed, byOperation } = plan(state('clean'), {
      op: 'captions.cue',
      cueId: cueOf(s1).id,
      lines: ['Sous-titre exporté']
    });
    expect(by.picture).toBeUndefined();
    expect(by['picture-clean']).toMatchObject({ status: 'reused', reusedFrom: PARENT });
    expect(byOperation).toEqual(['captions-sidecars']);
    expect(Object.values(changed).every((c) => c === 'unchanged')).toBe(true);
  });

  it('replaced media: only the renders using it (its track in the mix)', () => {
    const { child, by, byOperation } = plan(state('burned'), {
      op: 'media.replace',
      assetId: 'ast_rush',
      withAssetId: 'ast_new'
    });
    expect(child.audio!.tracks.map((t) => t.assetId)).toEqual(['ast_music', 'ast_new']);
    expect(by.mix).toMatchObject({ cause: 'operation', targets: ['atr_rush'] });
    expect(by.picture).toMatchObject({ status: 'reused' });
    expect(byOperation).toEqual(['mix']);
  });

  it('one scene edited: the other scenes are intact', () => {
    const { child, by, changed } = plan(state('burned'), {
      op: 'scene.update',
      sceneId: s2,
      patch: { text: 'Nouveau titre' }
    });
    expect(changed).toEqual({ [s1]: 'unchanged', [s2]: 'content', [s3]: 'unchanged' });
    expect(by.picture).toMatchObject({ status: 'invalidated', cause: 'operation', targets: [s2] });
    expect(child.storyboard.scenes[0]).toStrictEqual(storyboard.scenes[0]);
    expect(child.storyboard.scenes[2]).toStrictEqual(storyboard.scenes[2]);
    expect(child.captions).toStrictEqual(captions);
    expect(by.mix).toMatchObject({ cause: 'no-reuse-mechanism' });
  });
});

describe('invalidation graph (other operations)', () => {
  it('a duration change moves the later scenes, rebuilds their captions and the whole mix', () => {
    const { changed, by } = plan(state('burned'), {
      op: 'scene.duration',
      sceneId: s2,
      durationMs: 4000
    });
    expect(changed).toEqual({ [s1]: 'unchanged', [s2]: 'content', [s3]: 'timing' });
    expect(by.picture.targets).toEqual([s2, s3]);
    expect(by.mix).toMatchObject({ cause: 'operation', targets: ['atr_music', 'atr_rush'] });
    expect(by['captions-sidecars']).toMatchObject({ cause: 'operation' });
  });

  it('a transition or animation change is a content change of its scene', () => {
    for (const op of [
      { op: 'scene.transition', sceneId: s3, enter: 'scale' },
      { op: 'scene.animation', sceneId: s3, animationMs: 900 }
    ])
      expect(plan(state('burned'), op).changed).toEqual({
        [s1]: 'unchanged',
        [s2]: 'unchanged',
        [s3]: 'content'
      });
  });

  it('narration: picture unchanged when captions are not burned; burned picture of that scene otherwise', () => {
    const op = { op: 'voice.narration', sceneId: s1, text: 'Une autre narration pour la scène' };
    const clean = plan(state('clean'), op);
    expect(clean.by['picture-clean']).toMatchObject({ status: 'reused' });
    expect(clean.byOperation).toEqual(['captions-sidecars']);
    const burned = plan(state('burned'), op);
    expect(burned.by.picture).toMatchObject({ cause: 'operation', targets: [s1] });
  });

  it('a new delivery mode the parent never rendered is not reused', () => {
    const { by } = plan(state('burned'), { op: 'captions.delivery', mode: 'both' });
    expect(by.picture).toMatchObject({ status: 'reused' });
    expect(by['picture-clean']).toMatchObject({
      status: 'invalidated',
      cause: 'parent-lacks-variant'
    });
  });

  it('delivery values are the render runner’s', () => {
    for (const mode of captionDeliverySchema.unwrap().options)
      expect(editOperationSchema.parse({ op: 'captions.delivery', mode })).toBeTruthy();
  });
});

describe('conflicts and invalid edits (all or nothing)', () => {
  const fails = (code: string, message: RegExp, ...raw: unknown[]) => {
    let error: unknown;
    try {
      applyEdits(state('burned'), ops(...raw), options);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ToolFailure);
    expect(error).toMatchObject({ code, message: expect.stringMatching(message) });
  };
  it('same target twice', () =>
    fails(
      'conflict',
      /même cible/,
      { op: 'scene.update', sceneId: s1, patch: { text: 'A' } },
      { op: 'scene.update', sceneId: s1, patch: { text: 'B' } }
    ));
  it('missing scene, track, cue, media or replacement', () => {
    fails('conflict', /Scène introuvable/, {
      op: 'scene.duration',
      sceneId: 'scn_x',
      durationMs: 2000
    });
    fails('conflict', /Piste introuvable/, {
      op: 'audio.track',
      trackId: 'atr_x',
      patch: { gainDb: 0 }
    });
    fails('conflict', /Cue introuvable/, { op: 'captions.cue', cueId: 'cue_x', lines: ['x'] });
    fails('conflict', /n'utilise le média/, {
      op: 'media.replace',
      assetId: 'ast_x',
      withAssetId: 'ast_new'
    });
    fails('conflict', /remplacement/, {
      op: 'media.replace',
      assetId: 'ast_rush',
      withAssetId: 'ast_other'
    });
  });
  it('a cue rebuilt by another operation of the batch', () =>
    fails(
      'conflict',
      /reconstruit/,
      { op: 'voice.narration', sceneId: s2, text: 'Narration entièrement nouvelle' },
      { op: 'captions.cue', cueId: cueOf(s2).id, lines: ['Ancienne version'] }
    ));
  it('a valid operation followed by an invalid one: refused as a whole', () =>
    fails(
      'invalid-input',
      /composant/,
      { op: 'scene.update', sceneId: s1, patch: { text: 'Valide' } },
      { op: 'scene.update', sceneId: s2, patch: { params: { value: 1 } } }
    ));
  it('a result longer than the maximum duration', () =>
    expect(() =>
      applyEdits(state('burned'), ops({ op: 'scene.duration', sceneId: s1, durationMs: 15000 }), {
        ...options,
        maxDurationMs: 12_000
      })
    ).toThrow(/exceeds/));
});
