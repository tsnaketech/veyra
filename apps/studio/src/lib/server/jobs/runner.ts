import { copyFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { dirname, join, resolve } from 'node:path';
import { ConfigLoader, configSchemas } from '@veyra/config';
import { ProjectStorage, safePath } from '@veyra/storage';
import {
  HyperFramesEngine,
  compose,
  writeComposition,
  renderResultSchema,
  progressSchema,
  type CompositionCheck,
  type VideoEngine
} from '@veyra/hyperframes-adapter';
import {
  analyzeFlashes,
  deterministicChecks,
  measureTextContrast,
  photosensitivityCheck,
  PHOTOSENSITIVITY_CHECK_NAME,
  ProcessError,
  textContrastCheck,
  TEXT_CONTRAST_CHECK_NAME
} from '@veyra/video';
import {
  analysisModesFor,
  frameCount,
  newId,
  qualityReportSchema,
  captionPrecisionSummary,
  quantizeCues,
  toSrt,
  toWebVtt,
  type CaptionTrack,
  type QuantizedCue,
  type RenderJob,
  type VideoRevision
} from '@veyra/schemas';
import type { ReviewFinding } from '@veyra/ai';
import { mixToWav, muxAudio, resolveAudioComposition, type AudioMetadata } from '@veyra/audio';
import { audioQualityChecks } from './audio-qa';
import { visualTimeline } from '@veyra/motion';
import type { createRepository } from '../db/repo';
type Repository = ReturnType<typeof createRepository>;
/** Qualitative review run after deterministic QA; findings keep their own analysisMode. */
export type Reviewer = (
  revision: ReturnType<Repository['getRevision']>,
  videoPath: string
) => Promise<ReviewFinding[]>;
export function defaultConfigDir() {
  if (process.env.VEYRA_CONFIG_DIR) return resolve(process.env.VEYRA_CONFIG_DIR);
  let current = process.cwd();
  while (true) {
    if (
      existsSync(join(current, 'pnpm-workspace.yaml')) &&
      existsSync(join(current, 'config/app.yaml'))
    )
      return join(current, 'config');
    const parent = dirname(current);
    if (parent === current) throw new Error('Veyra configuration not found; set VEYRA_CONFIG_DIR');
    current = parent;
  }
}
export function loadRenderSettings(configDir = defaultConfigDir()) {
  const app = new ConfigLoader(configSchemas.app).load([{ file: join(configDir, 'app.yaml') }]);
  const engines = new ConfigLoader(configSchemas.engines).load([
    { file: join(configDir, 'engines.json') }
  ]);
  const style = new ConfigLoader(configSchemas.style).load([
    { file: join(configDir, 'style-guide.md') }
  ]);
  const quality = new ConfigLoader(configSchemas.quality).load([
    { file: join(configDir, 'quality.yaml') }
  ]);
  const audio = new ConfigLoader(configSchemas.audio).load([
    { file: join(configDir, 'audio.yaml') }
  ]);
  return {
    app: app.value,
    engine: engines.value.hyperframes,
    style: style.value,
    quality: quality.value,
    audio: audio.value,
    // VEYRA_PROJECTS_ROOT lets tests isolate their media from the default projects/ folder.
    storageRoot: resolve(
      process.env.VEYRA_PROJECTS_ROOT ?? join(dirname(configDir), app.value.projectsRoot)
    ),
    snapshot: {
      app: app.redacted(),
      engines: engines.redacted(),
      style: style.redacted(),
      quality: quality.redacted(),
      audio: audio.redacted()
    }
  };
}
export type RenderSettings = ReturnType<typeof loadRenderSettings>;
/** How captions are delivered; ignored when the revision has no captions. */
export const captionDeliverySchema = z.enum(['burned', 'clean', 'both']).default('burned');
export const CAPTION_EXPORT_CHECK_NAME = 'Sous-titres — calage des exports';
export const CAPTION_PRECISION_CHECK_NAME = 'Sous-titres — précision des temps';
// Narration is spoken, never drawn: it does not change the picture (burned captions are compared separately).
const pictureKey = (board: { scenes: { narration?: unknown }[] }) =>
  JSON.stringify(board, (key, value) => (key === 'narration' ? undefined : value));
type PictureSide = Pick<VideoRevision, 'storyboard' | 'captions'>;
/**
 * Which parent picture can stand in for the child's (pure; shared with the T128 edit plan):
 * `plain` = the parent's only picture (it had no captions), `burned` = its picture with the
 * same captions burned in, `clean` = its clean picture; null = must be rendered.
 */
export function reusableVariant(parent: PictureSide, child: PictureSide, burned: boolean) {
  if (pictureKey(parent.storyboard) !== pictureKey(child.storyboard)) return null;
  if (!parent.captions) return burned ? null : ('plain' as const);
  if (!burned) return 'clean' as const;
  return JSON.stringify(parent.captions) === JSON.stringify(child.captions)
    ? ('burned' as const)
    : null;
}
export class RenderJobRunner {
  private tail: Promise<void> = Promise.resolve();
  private pending = new Map<string, Promise<ReturnType<Repository['getRenderJob']>>>();
  constructor(
    private repo: Repository,
    private storage: ProjectStorage,
    private engine: VideoEngine,
    private settings: RenderSettings,
    private reviewer?: Reviewer
  ) {}
  enqueue(jobId: string): Promise<ReturnType<Repository['getRenderJob']>> {
    const pending = this.pending.get(jobId);
    if (pending) return pending;
    const work = this.tail.then(() => this.execute(jobId));
    this.tail = work.then(
      () => {},
      () => {}
    );
    this.pending.set(jobId, work);
    void work.then(
      () => this.pending.delete(jobId),
      () => this.pending.delete(jobId)
    );
    return work;
  }
  resumeQueued() {
    return Promise.all(this.repo.queuedRenderJobs().map((job) => this.enqueue(job.id)));
  }
  private async execute(jobId: string) {
    const job = this.repo.getRenderJob(jobId);
    if (job.status !== 'queued') throw new Error('Job must be queued');
    this.repo.transitionRenderJob(jobId, 'running', {
      resolvedConfig: {
        ...this.settings.snapshot,
        engineKind: this.engine.kind
      } as RenderJob['resolvedConfig']
    });
    let revisionStarted = false;
    let stderrTail = '';
    try {
      const revision = this.repo.getRevision(job.revisionId);
      this.repo.transitionRevision(revision.id, 'rendering');
      revisionStarted = true;
      if (
        Math.max(...revision.storyboard.scenes.map((scene) => scene.start + scene.duration)) >
        this.settings.app.maxDurationSeconds * 1000
      )
        throw new Error('Configured maximum duration exceeded');
      const workspace = this.storage.ensureRevision(revision.projectId, revision.id);
      const durationMs = Math.max(
        ...revision.storyboard.scenes.map((scene) => scene.start + scene.duration)
      );
      // Captions: one quantized table on the render rate feeds the burned layer and is
      // compared with the table re-quantized on the exported video (sidecars).
      const captions = revision.captions;
      const mode = captions
        ? captionDeliverySchema.parse(revision.resolvedConfig.captionDelivery)
        : null;
      const renderRate = { num: this.settings.engine.fps, den: 1 };
      const composed = captions
        ? quantizeCues(captions.cues, renderRate, frameCount(durationMs, renderRate))
        : null;
      const clean = {
        burned: false,
        silent: safePath(workspace.renders, `${jobId}.clean.video.mp4`),
        output: safePath(workspace.renders, `${jobId}.clean.mp4`)
      };
      const main = {
        burned: Boolean(captions),
        silent: this.storage.silentRenderPath(revision.projectId, revision.id, jobId),
        output: this.storage.renderPath(revision.projectId, revision.id, jobId)
      };
      // Main picture first: burned (or plain without captions), clean when mode is clean.
      const variants = mode === 'clean' ? [clean] : mode === 'both' ? [main, clean] : [main];
      const silentPath = variants[0].silent;
      const outputPath = variants[0].output;
      let compositionCheck: CompositionCheck | null = null;
      let checkError: string | null = null;
      let renderSeconds = 0;
      let reuseFrom: ReturnType<Repository['getRevision']> | null = null;
      let cleanReusedFrom: string | null = null;
      // Progress never decreases: two renders share the 0-88 % range.
      const spans = variants.length > 1 ? [0, 60, 88] : [0, 90];
      for (const [index, variant] of variants.entries()) {
        const base = spans[index],
          span = spans[index + 1] - base,
          secondary = index > 0;
        const reusable = this.reusablePicture(revision, variant.burned);
        if (reusable) {
          // Same storyboard (and captions when burned): the parent's picture is reused.
          this.repo.updateRenderProgress(
            jobId,
            base + 2,
            secondary ? 'reuse-clean' : 'reuse-video'
          );
          copyFileSync(reusable.path, variant.silent);
          if (secondary) cleanReusedFrom = reusable.parent.id;
          else reuseFrom = reusable.parent;
          continue;
        }
        this.repo.updateRenderProgress(jobId, base, secondary ? 'render-clean' : 'compose');
        const files = compose(
          revision.storyboard,
          { width: revision.storyboard.width, height: revision.storyboard.height },
          this.settings.style,
          ...(variant.burned ? [{ track: captions, cues: composed, rate: renderRate }] : [])
        );
        writeComposition(workspace.composition, files);
        if (!secondary) {
          // Layout, contrast, runtime and motion checks in a real browser, before encoding.
          this.repo.updateRenderProgress(jobId, base + 2, 'check');
          try {
            compositionCheck = await this.engine.check(workspace.composition);
          } catch (error) {
            checkError = error instanceof Error ? error.message : String(error);
          }
        }
        const renderStarted = Date.now();
        const result = renderResultSchema.parse(
          await this.engine.render(
            workspace.composition,
            {
              revisionDir: workspace.revision,
              outputPath: variant.silent,
              quality: this.settings.engine.quality,
              fps: this.settings.engine.fps
            },
            (raw) => {
              const progress = progressSchema.parse(raw);
              this.repo.updateRenderProgress(
                jobId,
                Math.max(
                  base + 2,
                  Math.min(base + span, base + Math.round((progress.percent * span) / 100))
                ),
                secondary ? 'render-clean' : progress.stage
              );
            }
          )
        );
        if (resolve(result.path) !== variant.silent || result.engine !== this.engine.kind)
          throw new Error('Engine result does not match job');
        if (!secondary) {
          stderrTail = result.stderrTail;
          renderSeconds = (Date.now() - renderStarted) / 1000;
        }
      }
      this.repo.updateRevision(revision.id, { silentVideoPath: silentPath });
      const silent = await this.engine.inspect(silentPath);
      const audio = await this.soundtrack(
        revision,
        variants.map((v) => [v.silent, v.output] as const),
        jobId,
        silent
      );
      this.repo.updateRevision(revision.id, { videoPath: outputPath });
      this.repo.transitionRevision(revision.id, 'qa');
      this.repo.updateRenderProgress(jobId, 95, 'qa');
      const metadata = await this.engine.inspect(outputPath);
      // The measured stream timing is the reference for frame-accurate comments.
      const rate = metadata.frameRate ?? { num: Math.round(this.settings.engine.fps), den: 1 };
      this.repo.updateRevision(revision.id, {
        media: {
          fpsNum: rate.num,
          fpsDen: rate.den,
          durationMs: metadata.durationMs,
          startMs: metadata.startMs ?? 0,
          frameCount: metadata.frameCount ?? frameCount(metadata.durationMs, rate),
          // An engine that cannot prove CFR is not assumed CFR (probe compares r/avg rates).
          constantFrameRate: metadata.constantFrameRate ?? false
        }
      });
      const checks = deterministicChecks(
        metadata,
        {
          durationMs,
          width: revision.storyboard.width,
          height: revision.storyboard.height,
          fps: this.settings.engine.fps
        },
        this.settings.quality
      );
      if (reuseFrom)
        checks.push({
          id: newId('qck'),
          name: 'Vidéo réutilisée',
          passed: true,
          severity: 'info',
          timestamp: 0,
          evidence: `Image identique à la révision ${reuseFrom.id} (storyboard inchangé) : composition et rendu HyperFrames non relancés ; voir son rapport.`,
          recommendation: 'No action required',
          analysisMode: 'deterministic'
        });
      else
        checks.push(
          ...compositionChecks(compositionCheck, checkError),
          renderPerformanceCheck(
            renderSeconds,
            durationMs / 1000,
            this.settings.engine.wallTimeoutMs
          ),
          ...(await renderedPictureChecks(silentPath, compositionCheck, revision.storyboard))
        );
      if (audio)
        checks.push(
          ...audioPlacementChecks(audio),
          ...(await audioQualityChecks(
            outputPath,
            metadata.durationMs,
            revision.audio!,
            audio.tracks,
            this.settings.audio
          ))
        );
      let delivery: Record<string, string> | null = null;
      if (captions && mode && composed) {
        this.repo.updateRenderProgress(jobId, 96, 'export-captions');
        delivery = { mode, ...(mode === 'clean' ? {} : { burned: main.output }) };
        if (mode !== 'burned') delivery.clean = clean.output;
        if (cleanReusedFrom) delivery.cleanReusedFrom = cleanReusedFrom;
        const exported = captionExport(captions, composed, metadata);
        if (exported.measured) {
          delivery.srt = safePath(workspace.renders, `${jobId}.srt`);
          delivery.vtt = safePath(workspace.renders, `${jobId}.vtt`);
          writeFileSync(delivery.srt, toSrt(captions, exported.measured), { flag: 'wx' });
          writeFileSync(delivery.vtt, toWebVtt(captions, exported.measured), { flag: 'wx' });
        }
        checks.push(exported.check, captionPrecisionCheck(captions));
      }
      if (this.engine.kind === 'fake-test-only')
        for (const check of checks) {
          if (check.analysisMode === 'not-performed') continue;
          check.analysisMode = 'simulated';
          check.evidence = `FakeEngine test-only: ${check.evidence}`;
        }
      const findings = this.reviewer ? await this.reviewer(revision, outputPath) : [];
      for (const finding of findings)
        checks.push({
          id: newId('qck'),
          name: finding.name,
          passed: finding.passed,
          severity: finding.severity,
          timestamp: finding.timestampMs,
          evidence: finding.evidence,
          recommendation: finding.recommendation,
          analysisMode: finding.analysisMode
        });
      const issues = findings
        // An unperformed review is reported as a check, not as a defect of the video.
        .filter((finding) => !finding.passed && finding.analysisMode !== 'not-performed')
        .map((finding) => ({
          id: newId('qis'),
          sceneId: revision.storyboard.scenes.some((scene) => scene.id === finding.sceneId)
            ? finding.sceneId
            : null,
          severity: finding.severity,
          timestamp: finding.timestampMs,
          evidence: finding.evidence,
          recommendation: finding.recommendation,
          analysisMode: finding.analysisMode
        }));
      const report = qualityReportSchema.parse({
        id: newId('qar'),
        revisionId: revision.id,
        checks,
        issues,
        analysisModes: analysisModesFor([...checks, ...issues]),
        createdAt: Date.now()
      });
      this.repo.createQualityReport(report);
      // QA findings are reviewable even when checks fail; no automatic human approval.
      this.repo.transitionRevision(revision.id, 'awaiting_approval');
      this.repo.transitionRenderJob(jobId, 'succeeded', {
        outputPath,
        stderrTail,
        resolvedConfig: {
          ...this.repo.getRenderJob(jobId).resolvedConfig,
          ...(reuseFrom ? { videoReusedFrom: reuseFrom.id } : {}),
          ...(delivery ? { delivery } : {}),
          ...(audio ? { audio: JSON.parse(JSON.stringify(audio)) } : {})
        } as RenderJob['resolvedConfig']
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Unknown render failure').slice(
        0,
        4096
      );
      stderrTail = error instanceof ProcessError ? error.stderrTail.slice(-8192) : stderrTail;
      if (revisionStarted) {
        this.repo.updateRevision(job.revisionId, { error: message });
        const { status } = this.repo.getRevision(job.revisionId);
        if (status === 'rendering' || status === 'qa')
          this.repo.transitionRevision(job.revisionId, 'failed');
      }
      this.repo.transitionRenderJob(jobId, 'failed', { error: message, stderrTail });
    }
    return this.repo.getRenderJob(jobId);
  }

  /**
   * Parent picture that can stand in for this one: same storyboard and, for a burned
   * picture, the same captions. By name, `<rnd>.video.mp4` holds the parent's captions
   * burned in (or no captions if it had none) and `<rnd>.clean.video.mp4` its clean picture.
   */
  private reusablePicture(revision: ReturnType<Repository['getRevision']>, burned: boolean) {
    if (!revision.parentRevisionId) return null;
    // An automatic re-render exists precisely to produce a new picture.
    if ((revision.resolvedConfig.origin as { autoFix?: number } | undefined)?.autoFix) return null;
    const parent = this.repo.getRevision(revision.parentRevisionId);
    if (!parent.silentVideoPath || !parent.silentVideoPath.startsWith(this.storage.root + '/'))
      return null;
    const base = /^(.*\/rnd_[A-Za-z0-9-]+)(?:\.clean)?\.video\.mp4$/.exec(
      parent.silentVideoPath
    )?.[1];
    if (!base) return null;
    const variant = reusableVariant(parent, revision, burned);
    const path =
      variant === 'plain'
        ? parent.silentVideoPath
        : variant && `${base}${variant === 'clean' ? '.clean' : ''}.video.mp4`;
    return path && existsSync(path) ? { parent, path } : null;
  }

  /**
   * Writes the final video: the silent render as is, or with the revision's soundtrack
   * resolved on the visual timeline, mixed and muxed. Returns the resolution, if any.
   */
  private async soundtrack(
    revision: ReturnType<Repository['getRevision']>,
    outputs: (readonly [silentPath: string, outputPath: string])[],
    jobId: string,
    silent: Awaited<ReturnType<VideoEngine['inspect']>>
  ) {
    const composition = revision.audio;
    if (!composition?.tracks.length) {
      for (const [silentPath, outputPath] of outputs) copyFileSync(silentPath, outputPath);
      return null;
    }
    const rate = silent.frameRate ?? { num: Math.round(this.settings.engine.fps), den: 1 };
    const events = visualTimeline(revision.storyboard, rate, this.settings.style.palette);
    const assets = new Map<string, { path: string; metadata: AudioMetadata }>();
    for (const track of composition.tracks) {
      const asset = this.repo.getAsset(track.assetId);
      // A missing or invalid file becomes an explicit asset-missing issue, not a crash.
      if (
        asset?.projectId === revision.projectId &&
        asset.audio?.status === 'valid' &&
        asset.audio.metadata &&
        asset.path.startsWith(this.storage.root + '/') &&
        existsSync(asset.path)
      )
        assets.set(asset.id, {
          path: asset.path,
          metadata: asset.audio.metadata as unknown as AudioMetadata
        });
    }
    const resolved = resolveAudioComposition(composition, events, assets, silent.durationMs);
    const mix = this.storage.mixPath(revision.projectId, revision.id, jobId);
    const settings = {
      ...this.settings.audio.mix,
      cpuSeconds: this.settings.audio.cpuSeconds,
      timeoutMs: this.settings.audio.timeoutMs
    };
    this.repo.updateRenderProgress(jobId, 92, 'audio');
    try {
      await mixToWav(resolved.tracks, mix, settings, silent.durationMs);
      for (const [silentPath, outputPath] of outputs)
        await muxAudio(silentPath, mix, outputPath, settings);
    } finally {
      rmSync(mix, { force: true });
    }
    return { expected: composition.tracks.length, ...resolved };
  }
}

/**
 * Re-quantizes the cues on the exported video (measured rate and frame count) and
 * compares that table with the one the burned layer was composed from. The sidecars
 * are written from the measured table; null when the video has no measured rate.
 */
/**
 * Says how word times were obtained. Approximate times (scene spread, ASR tokens) are a
 * minor finding to check by ear: never presented as validated, never auto-fixed.
 */
export function captionPrecisionCheck(track: CaptionTrack) {
  const { counts, total, approximateShare } = captionPrecisionSummary(track);
  const approximate = approximateShare > 0;
  return {
    id: newId('qck'),
    name: CAPTION_PRECISION_CHECK_NAME,
    passed: !approximate,
    severity: approximate ? ('minor' as const) : ('info' as const),
    timestamp: 0,
    evidence: JSON.stringify({
      mots: total,
      partApproximative: Math.round(approximateShare * 1000) / 1000,
      repartition: counts,
      fournisseur: track.provenance.provider
    }),
    recommendation: approximate
      ? "Temps approximatifs (répartition dans la scène ou transcription) : vérifier la synchronisation à l'écoute, ou corriger les temps à la main"
      : 'No action required',
    analysisMode: 'deterministic' as const
  };
}

export function captionExport(
  track: CaptionTrack,
  composed: QuantizedCue[],
  video: {
    frameRate?: { num: number; den: number };
    frameCount?: number;
    durationMs: number;
    constantFrameRate?: boolean;
  }
) {
  const check = (
    passed: boolean,
    severity: 'info' | 'major' | 'minor',
    evidence: unknown,
    mode: 'deterministic' | 'not-performed'
  ) => ({
    id: newId('qck'),
    name: CAPTION_EXPORT_CHECK_NAME,
    passed,
    severity,
    timestamp: 0,
    evidence: (typeof evidence === 'string' ? evidence : JSON.stringify(evidence)).slice(0, 2000),
    recommendation: passed
      ? 'No action required'
      : 'Relancer le rendu ; vérifier la cadence de la vidéo exportée',
    analysisMode: mode
  });
  const rate = video.frameRate;
  if (!rate)
    return {
      measured: null,
      check: check(
        false,
        'minor',
        'Non mesuré : cadence de la vidéo exportée illisible ; SRT/VTT non écrits',
        'not-performed'
      )
    };
  const frames = video.frameCount ?? frameCount(video.durationMs, rate);
  const measured = quantizeCues(track.cues, rate, frames);
  if (video.constantFrameRate !== true)
    return {
      measured,
      check: check(
        false,
        'minor',
        `Non mesuré : cadence variable ou non prouvée constante (${rate.num}/${rate.den}) ; SRT/VTT écrits sur la cadence nominale`,
        'not-performed'
      )
    };
  const byId = new Map(measured.map((q) => [q.cueId, q]));
  const ids = [...new Set([...composed, ...measured].map((q) => q.cueId))];
  const span = (q?: QuantizedCue) => (q ? [q.startFrame, q.endFrame] : null);
  const composedById = new Map(composed.map((q) => [q.cueId, q]));
  const gaps = ids
    .map((cueId) => ({
      cueId,
      attendu: span(composedById.get(cueId)),
      mesure: span(byId.get(cueId))
    }))
    .filter((g) => JSON.stringify(g.attendu) !== JSON.stringify(g.mesure));
  const facts = {
    cadence: `${rate.num}/${rate.den}`,
    frames,
    nombreFrames: video.frameCount === undefined ? 'déduit de la durée mesurée' : 'mesuré',
    cues: measured.length
  };
  return {
    measured,
    check: gaps.length
      ? check(false, 'major', { ...facts, ecarts: gaps.slice(0, 20) }, 'deterministic')
      : check(true, 'info', facts, 'deterministic')
  };
}

/** Placement checks of a soundtrack; level, clipping and silence checks come with audio QA. */
export function audioPlacementChecks(audio: {
  expected: number;
  tracks: { trackId: string }[];
  issues: { trackId: string; code: string; message: string }[];
}) {
  const anchorIssues = audio.issues.filter((i) => i.code !== 'asset-missing');
  const placed = audio.tracks.length === audio.expected;
  const syncOk = anchorIssues.length === 0;
  return [
    {
      id: newId('qck'),
      name: 'Pistes audio attendues',
      passed: placed,
      severity: placed ? ('info' as const) : ('major' as const),
      timestamp: 0,
      evidence: JSON.stringify({
        attendues: audio.expected,
        placees: audio.tracks.length,
        problemes: audio.issues.map((i) => `${i.trackId} ${i.code} : ${i.message}`)
      }),
      recommendation: placed ? 'No action required' : 'Réimporter le fichier ou corriger la piste',
      analysisMode: 'deterministic' as const
    },
    {
      id: newId('qck'),
      name: 'Synchronisation audio',
      passed: syncOk,
      severity: syncOk ? ('info' as const) : ('minor' as const),
      timestamp: 0,
      evidence: JSON.stringify({
        ancrages: syncOk ? 'tous résolus' : anchorIssues.map((i) => `${i.trackId} : ${i.message}`)
      }),
      recommendation: syncOk ? 'No action required' : 'Réancrer la piste sur un événement existant',
      analysisMode: 'deterministic' as const
    }
  ];
}
const checkGroups = [
  {
    name: 'Mise en page (marges, débordements)',
    sections: ['layout'],
    severity: 'major',
    advice: 'Raccourcir le texte ou changer de composant'
  },
  {
    name: 'Lisibilité (contraste WCAG AA)',
    sections: ['contrast'],
    severity: 'major',
    advice: 'Augmenter le contraste du texte'
  },
  {
    name: 'Exécution de la composition',
    sections: ['lint', 'runtime'],
    severity: 'major',
    advice: 'Corriger la composition'
  },
  {
    name: 'Animations et transitions (conseils HyperFrames)',
    sections: ['motion', 'craft'],
    severity: 'minor',
    advice: 'Revoir le rythme et les transitions'
  }
] as const;
/** Turns `hyperframes check` sections into QA checks; warnings stay visible as evidence. */
export function compositionChecks(check: CompositionCheck | null, error: string | null) {
  if (!check)
    return [
      {
        id: newId('qck'),
        name: 'Contrôle de composition HyperFrames',
        passed: false,
        severity: 'minor',
        timestamp: 0,
        evidence: `Non exécuté : ${error ?? 'erreur inconnue'}`.slice(0, 2000),
        recommendation: 'Relancer le rendu ; vérifier Chrome headless',
        analysisMode: 'deterministic'
      } as const
    ];
  return checkGroups.map((group) => {
    const findings = group.sections.flatMap((s) => check.sections[s]?.findings ?? []);
    const errors = findings.filter((f) => f.severity === 'error');
    const passed = errors.length === 0;
    return {
      id: newId('qck'),
      name: group.name,
      passed,
      severity: passed ? ('info' as const) : group.severity,
      timestamp: Math.round((errors[0]?.time ?? 0) * 1000),
      evidence: JSON.stringify({
        erreurs: errors.length,
        avertissements: findings.length - errors.length,
        constats: findings
          .slice(0, 5)
          .map(
            (f) =>
              `${f.code}${f.time !== undefined ? `@${f.time}s` : ''} : ${f.message.slice(0, 140)}`
          )
      }),
      recommendation: passed ? 'No action required' : group.advice,
      analysisMode: 'deterministic' as const
    };
  });
}
/**
 * Measurements on the rendered picture: flashes, and contrast inside the boxes that
 * HyperFrames reports. Never auto-corrected; a failure to measure is `not-performed`.
 */
export async function renderedPictureChecks(
  video: string,
  check: CompositionCheck | null,
  size: { width: number; height: number }
) {
  const notMeasured = (name: string, error: unknown) => ({
    id: newId('qck'),
    name,
    passed: false,
    severity: 'minor' as const,
    timestamp: 0,
    evidence: `Non mesuré : ${error instanceof Error ? error.message : String(error)}`.slice(
      0,
      2000
    ),
    recommendation: "Vérifier à l'œil ; relancer le rendu",
    analysisMode: 'not-performed' as const
  });
  const flashes = await analyzeFlashes(video).then(photosensitivityCheck, (error) =>
    notMeasured(PHOTOSENSITIVITY_CHECK_NAME, error)
  );
  const section = check?.sections.contrast;
  const zones = (section?.findings ?? []).filter((f) => f.code === 'contrast_aa_failure');
  const contrast = await (
    section && zones.length
      ? measureTextContrast(video, zones, {
          compositionWidth: size.width,
          compositionHeight: size.height
        })
      : Promise.resolve([])
  ).then(
    (measurements) => textContrastCheck(measurements, section),
    (error) => notMeasured(TEXT_CONTRAST_CHECK_NAME, error)
  );
  return [flashes, contrast];
}
export function renderPerformanceCheck(
  renderSeconds: number,
  videoSeconds: number,
  wallTimeoutMs: number
) {
  const passed = renderSeconds * 1000 <= wallTimeoutMs * 0.8;
  return {
    id: newId('qck'),
    name: 'Performance de rendu',
    passed,
    severity: passed ? ('info' as const) : ('minor' as const),
    timestamp: 0,
    evidence: JSON.stringify({
      renduSecondes: Math.round(renderSeconds * 10) / 10,
      videoSecondes: videoSeconds,
      tempsReel: Math.round((renderSeconds / Math.max(videoSeconds, 0.001)) * 100) / 100
    }),
    recommendation: passed ? 'No action required' : 'Simplifier la composition ou réduire la durée',
    analysisMode: 'deterministic' as const
  };
}
// Keep one runner per server process. No worker or background server is started on import.
const runners = new WeakMap<Repository, RenderJobRunner>();
export function createRenderJobRunner(
  repo: Repository,
  settings = loadRenderSettings(),
  reviewer?: Reviewer
) {
  let runner = runners.get(repo);
  if (!runner) {
    runner = new RenderJobRunner(
      repo,
      new ProjectStorage(settings.storageRoot),
      new HyperFramesEngine(settings.engine),
      settings,
      reviewer
    );
    runners.set(repo, runner);
  }
  return runner;
}
