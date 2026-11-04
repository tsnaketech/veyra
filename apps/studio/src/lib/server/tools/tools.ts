import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { applyProposal } from '@veyra/ai';
import { voiceProvider } from '@veyra/audio';
import { compositionCheckSchema } from '@veyra/hyperframes-adapter';
import {
  audioCompositionSchema,
  audioMixPatchSchema,
  captionPrecisionSummary,
  captionTrackSchema,
  idSchema,
  quantizeCues,
  scenePatchSchema,
  storyboardSchema,
  toSrt,
  toWebVtt,
  transcriptionResultSchema,
  alignmentResultSchema,
  voiceResultSchema
} from '@veyra/schemas';
import { safePath } from '@veyra/storage';
import { extractFrameByIndex, probe, probeSchema } from '@veyra/video';
import { buildFallbackCaptions } from '../studio';
import { defineTool, type ToolContext } from './registry';

const revisionInput = z.object({ revisionId: idSchema('rev') }).strict();
const free = { kind: 'free' } as const;
const local = { kind: 'local-cpu' } as const;
const base = {
  version: 1,
  network: 'none' as const,
  requires: [] as string[],
  produces: [] as string[]
};

/** Rendered MP4 of a revision, re-confined to the storage root. */
function revisionVideo(ctx: ToolContext, revisionId: string) {
  const revision = ctx.repo.getRevision(revisionId);
  if (!revision.videoPath) throw new Error('Révision sans vidéo rendue');
  const root = ctx.storage.root;
  if (!revision.videoPath.startsWith(root + '/')) throw new Error('Chemin refusé');
  return { revision, path: safePath(root, relative(root, revision.videoPath)) };
}

export const mediaInspect = defineTool({
  meta: {
    ...base,
    id: 'media.inspect',
    description: 'Mesure la vidéo rendue d’une révision (ffprobe, cadence, segments noirs).',
    requires: ['ffprobe', 'ffmpeg'],
    capabilities: ['probe', 'measure-video'],
    permissions: ['read-only', 'local-compute'],
    sideEffects: 'none',
    cost: local,
    limits: { timeoutMs: 180_000 },
    validation: ['zod'],
    deterministic: true
  },
  input: revisionInput,
  output: probeSchema,
  run: async ({ revisionId }, ctx) => probe(revisionVideo(ctx, revisionId).path)
});

export const mediaFrame = defineTool({
  meta: {
    ...base,
    id: 'media.frame',
    description:
      'Extrait une frame exacte (index mesuré) de la vidéo rendue, en PNG, dans le dossier de l’appel.',
    requires: ['ffmpeg'],
    capabilities: ['extract-frame'],
    permissions: ['local-compute', 'writes-revision-artefacts'],
    sideEffects: 'artefacts',
    cost: local,
    limits: { timeoutMs: 90_000 },
    produces: ['png'],
    validation: ['zod', 'sha256'],
    deterministic: true
  },
  input: z
    .object({ revisionId: idSchema('rev'), frameIndex: z.number().int().nonnegative() })
    .strict(),
  output: z.object({ frameIndex: z.number().int().nonnegative(), path: z.string() }),
  async run({ revisionId, frameIndex }, ctx) {
    const { revision, path } = revisionVideo(ctx, revisionId);
    const out = ctx.artefactPath(revision.projectId, `frame-${frameIndex}.png`);
    await extractFrameByIndex(path, frameIndex, out);
    ctx.recordArtefact('png', out);
    return { frameIndex, path: relative(ctx.storage.root, out) };
  }
});

export const scenePatch = defineTool({
  meta: {
    ...base,
    id: 'scene.patch',
    description:
      'Applique des modifications de scène au storyboard d’une révision, sans créer de révision ; indique les scènes inchangées.',
    capabilities: ['patch-scene', 'preview-storyboard'],
    permissions: ['read-only'],
    sideEffects: 'none',
    cost: free,
    limits: { timeoutMs: 5_000 },
    validation: ['zod', 'storyboard', 'deep-equal'],
    deterministic: true
  },
  input: z
    .object({
      revisionId: idSchema('rev'),
      changes: z
        .array(z.object({ sceneId: idSchema('scn'), patch: scenePatchSchema }).strict())
        .min(1)
    })
    .strict(),
  output: z.object({
    storyboard: storyboardSchema,
    changedSceneIds: z.array(idSchema('scn')),
    unchangedSceneIds: z.array(idSchema('scn'))
  }),
  async run({ revisionId, changes }, ctx) {
    const before = ctx.repo.getRevision(revisionId).storyboard;
    const storyboard = applyProposal(before, changes, ctx.settings.app.maxDurationSeconds * 1000);
    // A shifted start (earlier duration change) counts as a change: only deep-equal scenes are unchanged.
    const same = (id: string) =>
      isDeepStrictEqual(
        before.scenes.find((s) => s.id === id),
        storyboard.scenes.find((s) => s.id === id)
      );
    const ids = storyboard.scenes.map((s) => s.id);
    return {
      storyboard,
      changedSceneIds: ids.filter((id) => !same(id)),
      unchangedSceneIds: ids.filter(same)
    };
  }
});

export const audioTrackUpdate = defineTool({
  meta: {
    ...base,
    id: 'audio.track.update',
    description:
      'Modifie le mixage d’une piste (gain, fondus, ducking, ancre) : révision enfant via Studio.reviseAudio, révision source intacte.',
    requires: ['ffmpeg', 'prlimit'],
    capabilities: ['mix-track', 'child-revision'],
    permissions: ['writes-revision-artefacts'],
    sideEffects: 'revision',
    cost: local,
    limits: { timeoutMs: 600_000 },
    produces: ['mp4'],
    validation: ['zod', 'audio-qa'],
    deterministic: true
  },
  input: z
    .object({ revisionId: idSchema('rev'), trackId: idSchema('atr'), patch: audioMixPatchSchema })
    .strict(),
  output: z.object({
    runId: idSchema('run'),
    revisionId: idSchema('rev'),
    parentRevisionId: idSchema('rev')
  }),
  async run({ revisionId, trackId, patch }, ctx) {
    const source = ctx.repo.getRevision(revisionId);
    if (!source.audio?.tracks.some((t) => t.id === trackId))
      throw new Error('Piste introuvable dans cette révision');
    // Same merge as Studio.patchedAudio (private), revalidated as a full composition.
    const composition = audioCompositionSchema.parse({
      ...source.audio,
      tracks: source.audio.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t))
    });
    // reviseAudio validates and creates the run synchronously; its promise ends with the run.
    const done = ctx.studio.reviseAudio(revisionId, composition);
    const run = ctx.repo
      .listRuns(source.projectId)
      .findLast((r) => r.kind === 'revision' && r.sourceRevisionId === source.id)!;
    await done;
    const finished = ctx.repo.getRun(run.id);
    if (!finished.revisionId)
      throw new Error(`Révision enfant non créée : ${finished.error ?? finished.status}`);
    return { runId: run.id, revisionId: finished.revisionId, parentRevisionId: source.id };
  }
});

export const captionsBuild = defineTool({
  meta: {
    ...base,
    id: 'captions.build',
    description:
      'Construit des sous-titres depuis la narration (temps approximatifs répartis dans la scène).',
    capabilities: ['build-captions'],
    permissions: ['read-only'],
    sideEffects: 'none',
    cost: free,
    limits: { timeoutMs: 5_000 },
    validation: ['zod', 'caption-precision'],
    // Track ids are random; words and cues are deterministic.
    deterministic: false
  },
  input: revisionInput,
  output: z.object({
    captions: captionTrackSchema,
    precision: z.object({
      counts: z.record(z.string(), z.number()),
      total: z.number(),
      approximateShare: z.number()
    }),
    approximate: z.boolean(),
    note: z.string()
  }),
  async run({ revisionId }, ctx) {
    const { storyboard } = ctx.repo.getRevision(revisionId);
    const captions = buildFallbackCaptions(storyboard, storyboard);
    const precision = captionPrecisionSummary(captions);
    return {
      captions,
      precision,
      approximate: precision.approximateShare > 0,
      note: 'Temps approximatifs : mots répartis dans leur scène, sans alignement sur la voix.'
    };
  }
});

export const captionsExport = defineTool({
  meta: {
    ...base,
    id: 'captions.export',
    description:
      'Exporte les sous-titres d’une révision en SRT ou WebVTT, calés sur la cadence et le nombre de frames mesurés.',
    capabilities: ['export-captions'],
    permissions: ['read-only'],
    sideEffects: 'none',
    cost: free,
    limits: { timeoutMs: 5_000, outputBytes: 1_000_000 },
    produces: ['srt', 'vtt'],
    validation: ['zod', 'quantize-cues'],
    deterministic: true
  },
  input: z.object({ revisionId: idSchema('rev'), format: z.enum(['srt', 'vtt']) }).strict(),
  output: z.object({
    format: z.enum(['srt', 'vtt']),
    text: z.string(),
    cues: z.number().int().nonnegative(),
    rate: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }),
    frameCount: z.number().int().nonnegative(),
    constantFrameRate: z.boolean()
  }),
  async run({ revisionId, format }, ctx) {
    const { captions, media } = ctx.repo.getRevision(revisionId);
    if (!captions) throw new Error('Révision sans sous-titres');
    if (!media) throw new Error('Vidéo non mesurée : cadence inconnue');
    const rate = { num: media.fpsNum, den: media.fpsDen };
    const quantized = quantizeCues(captions.cues, rate, media.frameCount);
    return {
      format,
      text: format === 'srt' ? toSrt(captions, quantized) : toWebVtt(captions, quantized),
      cues: quantized.length,
      rate,
      frameCount: media.frameCount,
      constantFrameRate: media.constantFrameRate
    };
  }
});

export const compositionCheck = defineTool({
  meta: {
    ...base,
    id: 'composition.check',
    description:
      'Vérifie la composition HyperFrames d’une révision (lint, exécution, mise en page, contraste, mouvement) dans la sandbox.',
    requires: ['bwrap', 'chrome'],
    capabilities: ['check-composition'],
    permissions: ['local-compute'],
    sideEffects: 'none',
    cost: local,
    limits: { timeoutMs: 300_000 },
    validation: ['zod'],
    deterministic: true
  },
  input: revisionInput,
  output: compositionCheckSchema,
  async run({ revisionId }, ctx) {
    const revision = ctx.repo.getRevision(revisionId);
    const dir = safePath(ctx.storage.revision(revision.projectId, revision.id), 'composition');
    if (!existsSync(safePath(dir, 'index.html'))) throw new Error('Composition absente');
    return ctx.engine.check(dir);
  }
});

// Declared but unavailable until their engine is integrated: never replaced by a simulator.
const engineTool = {
  cost: local,
  sideEffects: 'none' as const,
  permissions: ['local-compute' as const]
};
const notIntegrated = (task: string) => async () => {
  throw new Error(`Moteur non intégré (${task})`);
};
export const voiceLocalTts = defineTool({
  meta: {
    ...base,
    ...engineTool,
    id: 'voice.local-tts',
    description: 'Synthèse vocale locale (Piper) de la narration d’une scène.',
    requires: ['engine:piper'],
    capabilities: ['synthesize-voice'],
    limits: { timeoutMs: 120_000 },
    produces: ['wav'],
    validation: ['zod', 'probeAudio'],
    deterministic: true
  },
  input: z.object({ revisionId: idSchema('rev'), sceneId: idSchema('scn') }).strict(),
  output: voiceResultSchema,
  available() {
    const status = voiceProvider('local-tts').available();
    return {
      ...status,
      installHint: status.installHint ?? 'Intégration de Piper prévue avec T117'
    };
  },
  run: notIntegrated('T117')
});
export const transcriptionLocalAsr = defineTool({
  meta: {
    ...base,
    ...engineTool,
    id: 'transcription.local-asr',
    description: 'Transcription locale (whisper.cpp) d’un fichier audio du projet.',
    requires: ['engine:whisper.cpp'],
    capabilities: ['transcribe'],
    limits: { timeoutMs: 300_000 },
    produces: ['json'],
    validation: ['zod'],
    deterministic: true
  },
  input: z.object({ assetId: idSchema('ast') }).strict(),
  output: transcriptionResultSchema,
  available: () => ({
    ok: false,
    reason: 'Aucun moteur de transcription intégré',
    installHint: 'whisper.cpp prévu avec T118, après approbation de l’installation'
  }),
  run: notIntegrated('T118')
});
export const alignmentCtc = defineTool({
  meta: {
    ...base,
    ...engineTool,
    id: 'alignment.ctc',
    description: 'Alignement forcé (CTC) du texte de narration sur une voix.',
    requires: ['engine:ctc'],
    capabilities: ['align-words'],
    limits: { timeoutMs: 300_000 },
    produces: ['json'],
    validation: ['zod'],
    deterministic: true
  },
  input: z.object({ revisionId: idSchema('rev'), sceneId: idSchema('scn') }).strict(),
  output: alignmentResultSchema,
  available: () => ({
    ok: false,
    reason: 'Aucun moteur d’alignement choisi ni intégré',
    installHint: 'Moteur à choisir par l’étude T119a, intégration avec T119 après approbation'
  }),
  run: notIntegrated('T119')
});

export const studioTools = [
  mediaInspect,
  mediaFrame,
  scenePatch,
  audioTrackUpdate,
  captionsBuild,
  captionsExport,
  compositionCheck,
  voiceLocalTts,
  transcriptionLocalAsr,
  alignmentCtc
];
