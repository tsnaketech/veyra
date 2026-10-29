import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigLoader, configSchemas } from '@veyra/config';
import { ProjectStorage, safePath, validateId } from '@veyra/storage';
import {
  compareFrames,
  extractFrameByIndex,
  extractFrames,
  extractFramesByIndex
} from '@veyra/video';
import {
  frameAt,
  frameCount,
  frameTimestampMs,
  newId,
  sceneAt,
  type CorrectionBatch,
  type CorrectionVerdict,
  type Feedback,
  type Scene,
  type ScenePatch,
  type VideoRevision,
  audioCompositionSchema,
  type AudioCategory,
  type AudioComposition,
  type ProductionBrief,
  type ProductionPlan,
  type ProductionRun,
  type RevisionPlan
} from '@veyra/schemas';
import {
  AssistedProvider,
  ProviderUnavailableError,
  applyProposal,
  sanitizeReview,
  type EvaluationImage,
  type EvaluationInput,
  type ExpertReview,
  toStoryboard,
  type FeedbackInput,
  type Provider,
  type ReviewFinding,
  type RevisionProposal,
  type StoryboardDraft,
  planProduction,
  planRevisionPhases,
  proposeAudio
} from '@veyra/ai';
import { getComponent } from '@veyra/motion';
import { AudioMediaError, probeAudio } from '@veyra/audio';
import type { createRepository } from './db/repo';
import type { RenderJobRunner, RenderSettings } from './jobs/runner';
import { Orchestrator, type Runners } from './production';

type Repository = ReturnType<typeof createRepository>;
type RevisionRow = ReturnType<Repository['getRevision']>;
type EvaluationMode = NonNullable<ReturnType<Repository['getEvaluation']>['analysisMode']>;
export type Activity = { stage: 'generating' | 'planning'; startedAt: number };

export function loadStudioSettings(settings: RenderSettings, configDir: string) {
  const formats = new ConfigLoader(configSchemas.formats).load([
    { file: join(configDir, 'formats.yaml') }
  ]);
  const models = new ConfigLoader(configSchemas.models).load([
    { file: join(configDir, 'models.json') }
  ]);
  return { ...settings, formats: formats.value, models: models.value };
}
export type StudioSettings = ReturnType<typeof loadStudioSettings>;

const message = (error: unknown) => (error instanceof Error ? error.message : 'erreur inconnue');
const endOf = (revision: Pick<VideoRevision, 'storyboard'>) =>
  revision.storyboard.scenes.reduce((max, s) => Math.max(max, s.start + s.duration), 0);
const originOf = (revision: Pick<RevisionRow, 'resolvedConfig'>) =>
  (revision.resolvedConfig.origin ?? {}) as { planId?: string; batchId?: string };
const verdictLabels: Record<CorrectionVerdict, string> = {
  applied: 'appliquée',
  partially_applied: 'partiellement appliquée',
  not_applied: 'non appliquée',
  contradicts_request: 'contraire à la demande',
  unverifiable: 'non vérifiable'
};
const modeLabel = (evaluator: string | null, mode: string | null) =>
  mode === 'simulated'
    ? 'simulée, aucune image analysée'
    : mode === 'multimodal'
      ? evaluator === 'claude-subscribe'
        ? 'multimodale, déclarée par Claude Code'
        : 'multimodale'
      : mode === 'text-only'
        ? 'texte seul, aucune image regardée'
        : 'non réalisée';
const SEQUENCE_FRAMES = 5;
const soundWords = /musique|music|\bson\b|sonore|audio|voix|bruitage|effets? sonores?/i;
// Output defects a fresh render can fix; layout or content issues need a correction instead.
const RETRYABLE = new Set(['duration', 'resolution', 'fps', 'codec', 'non-empty', 'black-frames']);

export class Studio {
  private orchestrator: Orchestrator;
  private activity = new Map<string, Activity>();
  constructor(
    private repo: Repository,
    private runner: RenderJobRunner,
    private ai: Provider | null,
    private settings: StudioSettings,
    private storage: ProjectStorage
  ) {
    this.orchestrator = new Orchestrator(repo, (projectId, text) =>
      this.say(projectId, 'system', text)
    );
  }

  get aiKind() {
    return this.ai?.kind ?? null;
  }
  /** Changing provider is explicit; work already exported keeps its own provider. */
  setProvider(provider: Provider | null) {
    this.ai = provider;
  }
  activityFor(projectId: string) {
    return this.activity.get(projectId) ?? null;
  }

  createProject(name: string) {
    const now = Date.now();
    const project = this.repo.createProject({
      id: newId('prj'),
      name: name.trim().slice(0, 120) || 'Projet sans titre',
      resolvedConfig: {},
      createdAt: now,
      updatedAt: now
    });
    this.repo.createConversation({
      id: newId('cnv'),
      projectId: project.id,
      createdAt: now,
      updatedAt: now
    });
    return project;
  }

  private say(projectId: string, role: 'user' | 'assistant' | 'system', text: string) {
    const conversation = this.repo.conversationFor(projectId);
    if (!conversation) throw new Error(`Conversation not found for ${projectId}`);
    this.repo.createMessage({
      id: newId('msg'),
      conversationId: conversation.id,
      role,
      text,
      createdAt: Date.now()
    });
    this.repo.touchProject(projectId);
  }
  private label(text: string, kind = this.ai?.kind) {
    if (kind === 'fake') return `[Simulé] ${text}`;
    if (kind === 'claude-subscribe') return `[Claude Code — mode assisté] ${text}`;
    return text;
  }
  private requireAi() {
    if (!this.ai)
      throw new Error(
        'IA non configurée : choisir un fournisseur dans Paramètres (ou VEYRA_AI_PROVIDER).'
      );
    return this.ai;
  }
  private busy(projectId: string, stage: Activity['stage']) {
    if (this.activity.has(projectId)) throw new Error('Un traitement est déjà en cours');
    this.activity.set(projectId, { stage, startedAt: Date.now() });
  }
  /** Runs work in the background; failures are persisted as system messages. */
  private background(projectId: string, work: () => Promise<void>) {
    return work()
      .catch((error: unknown) => {
        this.say(projectId, 'system', `Échec : ${message(error)}`);
      })
      .finally(() => this.activity.delete(projectId));
  }

  sendPrompt(projectId: string, prompt: string) {
    const text = prompt.trim();
    if (!text) throw new Error('Message vide');
    if (!this.repo.getProject(projectId)) throw new Error('Projet introuvable');
    const ai = this.requireAi();
    const parent = this.repo.listRevisions(projectId).at(-1) ?? null;
    if (ai.mode !== 'assisted') this.busy(projectId, 'generating');
    this.say(projectId, 'user', text);
    const brief = this.productionBrief(projectId, text);
    const plan = planProduction(brief, this.productionBudget());
    const run = this.orchestrator.create({
      projectId,
      kind: 'production',
      brief,
      plan,
      sourceRevisionId: parent?.id ?? null,
      done: { plan: { kind: 'done', payload: plan, provider: 'rules' } }
    });
    return this.background(projectId, async () => {
      await this.orchestrator.drive(run.id, this.productionRunners(run));
    });
  }

  private productionBudget() {
    return { maxAiCalls: 3, maxRenders: this.settings.quality.maxAutoFixAttempts + 1 };
  }

  private productionBrief(projectId: string, prompt: string): ProductionBrief {
    const assets = this.repo
      .listAssets(projectId)
      .filter((a) => a.audio?.status === 'valid' && a.audio.category);
    return {
      prompt,
      targetDurationMs: 20000,
      format: { ...this.settings.formats.formats.landscape, fps: this.settings.engine.fps },
      audio: {
        wanted: assets.length > 0 || soundWords.test(prompt),
        assetIds: assets.map((a) => a.id)
      },
      constraints: []
    };
  }

  private phasePayload<T>(runId: string, phase: string): T {
    const result = this.orchestrator.phases(runId).find((p) => p.phase === phase)?.result;
    return (result as { payload: T } | null)?.payload as T;
  }

  private renderRunners(run: ProductionRun): Runners {
    return {
      render: {
        run: async (inputs) => {
          const { revisionId } = inputs.composition as { revisionId: string };
          let target = this.repo.getRevision(this.repo.getRun(run.id).revisionId ?? revisionId);
          // Failed revisions are immutable; retry the render in a child, keeping completed phases.
          if (target.status === 'failed') {
            target = this.newRevision(
              run.projectId,
              target.storyboard,
              target.id,
              {
                ...(target.resolvedConfig.origin as Record<string, string | number>),
                renderRetry: run.id
              },
              String(target.resolvedConfig.aiProvider ?? 'none'),
              target.audio
            );
            this.repo.updateRun(run.id, { revisionId: target.id });
          }
          await this.render(run.projectId, target, 0);
          const revision = this.repo.listRevisions(run.projectId).at(-1)!;
          this.repo.updateRun(run.id, { revisionId: revision.id });
          const job = this.repo.renderJobsFor([revision.id]).at(-1);
          if (job?.status !== 'succeeded') throw new Error(job?.error ?? 'Échec du rendu');
          return {
            kind: 'done',
            payload: { revisionId: revision.id, status: job.status },
            revisionId: revision.id,
            provider: 'engine'
          };
        }
      },
      qa: {
        run: async (inputs) => {
          const { revisionId } = inputs.render as { revisionId: string };
          const report = this.repo.reportsFor([revisionId]).at(-1);
          const failed = report?.checks.filter((c) => !c.passed).map((c) => c.name) ?? [];
          return {
            kind: 'done',
            payload: { failed, failedCount: failed.length, total: report?.checks.length ?? 0 },
            provider: 'engine',
            validation: 'needs-human'
          };
        }
      }
    };
  }

  private productionRunners(run: ProductionRun): Runners {
    const { projectId } = run;
    const brief = run.brief!;
    // Both parallel agents must address the same scenes, including after a restart.
    const storyboardFrom = (draft: StoryboardDraft) => {
      const storyboard = toStoryboard(draft, brief.format);
      return {
        ...storyboard,
        scenes: storyboard.scenes.map((scene, i) => ({
          ...scene,
          id: `scn_${run.id.slice(4)}-${i}`
        }))
      };
    };
    const scriptProvider = () =>
      this.orchestrator.phases(run.id).find((p) => p.phase === 'script')?.result
        ?.provider as Provider['kind'];
    return {
      ...this.renderRunners(run),
      script: {
        usesAi: true,
        run: async () => {
          const ai = this.requireAi();
          const options = {
            targetDurationMs: brief.targetDurationMs,
            styleInstructions: this.settings.style.instructions
          };
          if (ai.mode === 'assisted') {
            const task = this.exportTask(
              projectId,
              'storyboard',
              ai.storyboardRequest(brief.prompt, options),
              {
                input: {
                  prompt: brief.prompt,
                  parentRevisionId: run.sourceRevisionId,
                  runId: run.id
                }
              }
            );
            this.say(projectId, 'assistant', this.assistedInstructions(task.dir, 'storyboard'));
            return { kind: 'waiting' };
          }
          return {
            kind: 'done',
            payload: await ai.generateStoryboard(brief.prompt, options),
            provider: ai.kind
          };
        }
      },
      motion: {
        run: async (inputs) => {
          const draft = inputs.script as StoryboardDraft;
          const storyboard = storyboardFrom(draft);
          const total = endOf({ storyboard });
          if (total > this.settings.app.maxDurationSeconds * 1000)
            throw new Error(
              `Durée demandée supérieure à ${this.settings.app.maxDurationSeconds} s`
            );
          const kind = scriptProvider();
          this.say(
            projectId,
            'assistant',
            this.label(
              `Storyboard « ${draft.title} » : ${storyboard.scenes.length} scènes, ${total / 1000} s.\n` +
                storyboard.scenes
                  .map(
                    (scene, i) =>
                      `${i + 1}. ${scene.component ? `${getComponent(scene.component.id).name} — ` : ''}${scene.text} (${scene.duration / 1000} s)`
                  )
                  .join('\n') +
                (kind === 'fake' && storyboard.scenes.some((s) => s.component)
                  ? "\nParamètres d'exemple (fonctionnalités, chiffres) à remplacer par les vôtres."
                  : ''),
              kind
            )
          );
          return { kind: 'done', payload: { storyboard }, provider: 'rules' };
        }
      },
      audio: {
        run: async (inputs) => {
          const storyboard = storyboardFrom(inputs.script as StoryboardDraft);
          const assets = this.repo
            .listAssets(projectId)
            .filter((a) => brief.audio.assetIds.includes(a.id) && a.audio?.status === 'valid');
          const { composition, warnings } = proposeAudio(
            storyboard,
            assets.map((a) => ({
              id: a.id,
              category: a.audio!.category,
              durationMs: Number(a.audio!.metadata!.durationMs),
              label: a.path.split('/').at(-1)!
            }))
          );
          this.say(
            projectId,
            'assistant',
            `Bande son proposée : ${composition.tracks.length} piste(s).` +
              (warnings.length ? '\n' + warnings.join('\n') : '')
          );
          return { kind: 'done', payload: composition, warnings, provider: 'rules' };
        }
      },
      composition: {
        run: async (inputs) => {
          const revision = this.newRevision(
            projectId,
            (inputs.motion as { storyboard: VideoRevision['storyboard'] }).storyboard,
            run.sourceRevisionId,
            { prompt: brief.prompt, runId: run.id },
            scriptProvider(),
            (inputs.audio as AudioComposition) ?? null
          );
          return {
            kind: 'done',
            payload: { revisionId: revision.id },
            revisionId: revision.id,
            provider: 'engine'
          };
        }
      }
    };
  }

  private newRevision(
    projectId: string,
    storyboard: VideoRevision['storyboard'],
    parentRevisionId: string | null,
    origin: Record<string, string | number>,
    kind: string = this.ai?.kind ?? 'none',
    // Corrections and re-renders keep the soundtrack; a new prompt starts silent.
    audio: VideoRevision['audio'] = null
  ) {
    const now = Date.now();
    return this.repo.createRevision({
      id: newId('rev'),
      projectId,
      parentRevisionId,
      storyboard,
      audio,
      resolvedConfig: { origin, aiProvider: kind },
      videoPath: null,
      error: null,
      createdAt: now,
      updatedAt: now
    });
  }

  private async render(
    projectId: string,
    revision: Pick<VideoRevision, 'id' | 'storyboard'>,
    autoFix: number
  ): Promise<void> {
    const now = Date.now();
    const job = this.repo.createRenderJob({
      id: newId('rnd'),
      revisionId: revision.id,
      outputPath: null,
      error: null,
      createdAt: now,
      updatedAt: now
    });
    const done = await this.runner.enqueue(job.id);
    this.repo.touchProject(projectId);
    if (done.status !== 'succeeded') {
      this.say(projectId, 'system', `Échec du rendu : ${done.error ?? 'inconnu'}`);
      return;
    }
    const report = this.repo.reportsFor([revision.id]).at(-1);
    // Only clearly identified technical defects are retried automatically; creative changes wait for a human.
    const technical = report?.checks.filter(
      (check) =>
        !check.passed &&
        RETRYABLE.has(check.name) &&
        check.analysisMode === 'deterministic' &&
        (check.severity === 'major' || check.severity === 'critical')
    );
    if (technical?.length && autoFix < this.settings.quality.maxAutoFixAttempts) {
      this.repo.transitionRevision(revision.id, 'changes_requested');
      this.say(
        projectId,
        'assistant',
        `Contrôle technique en échec (${technical.map((c) => c.name).join(', ')}). Correction automatique ${autoFix + 1}/${this.settings.quality.maxAutoFixAttempts} : nouveau rendu.`
      );
      const source = this.repo.getRevision(revision.id);
      const retry = this.newRevision(
        projectId,
        revision.storyboard,
        revision.id,
        { ...originOf(source), autoFix: autoFix + 1 },
        String(source.resolvedConfig.aiProvider ?? 'none'),
        source.audio
      );
      return this.render(projectId, retry, autoFix + 1);
    }
    const failed = report?.checks.filter((check) => !check.passed).length ?? 0;
    const { batchId } = originOf(this.repo.getRevision(revision.id));
    const verification = batchId ? this.repo.getBatch(batchId).verification : null;
    const verified = verification?.length
      ? `\nVérification des corrections : ${verification
          .map((v, i) => `#${i + 1} ${verdictLabels[v.verdict]}`)
          .join(', ')}.`
      : '';
    this.say(
      projectId,
      'assistant',
      `Vidéo prête (${revision.storyboard.scenes.length} scènes). QA : ${failed ? `${failed} contrôle(s) en échec` : 'aucun contrôle en échec'}.${verified} En attente de votre validation.`
    );
    // Expert QA of the corrections; it never blocks or changes the revision.
    if (originOf(this.repo.getRevision(revision.id)).planId)
      await this.requestEvaluation(revision.id).catch((error: unknown) =>
        this.say(projectId, 'system', `Expertise QA impossible : ${message(error)}`)
      );
  }

  // --- Annotations: saved locally, never sent to the AI and never rendered on their own.

  async addAnnotation(input: {
    revisionId: string;
    frameIndex?: number | null;
    timestampMs?: number | null;
    rangeEndMs?: number | null;
    audioTrackId?: string | null;
    text: string;
    author: string;
  }) {
    const revision = this.repo.getRevision(input.revisionId);
    const text = input.text.trim();
    if (!text) throw new Error('Commentaire vide');
    const max = this.settings.app.review.maxCommentLength;
    if (text.length > max) throw new Error(`Commentaire limité à ${max} caractères`);
    const media = revision.media;
    let frameIndex: number | null = null;
    let timestampMs: number;
    if (media && input.frameIndex != null) {
      frameIndex = Math.trunc(input.frameIndex);
      if (!Number.isFinite(frameIndex) || frameIndex < 0 || frameIndex >= media.frameCount)
        throw new Error('Frame hors de la vidéo');
      timestampMs = frameTimestampMs(frameIndex, { num: media.fpsNum, den: media.fpsDen });
    } else {
      timestampMs = Math.round(input.timestampMs ?? NaN);
      if (media && Number.isFinite(timestampMs))
        frameIndex = frameAt(
          timestampMs,
          { num: media.fpsNum, den: media.fpsDen },
          media.frameCount
        );
    }
    if (!Number.isFinite(timestampMs) || timestampMs < 0 || timestampMs > endOf(revision))
      throw new Error('Horodatage hors de la vidéo');
    if (
      input.rangeEndMs != null &&
      (!Number.isFinite(input.rangeEndMs) ||
        input.rangeEndMs <= timestampMs ||
        input.rangeEndMs > endOf(revision))
    )
      throw new Error('Fin de plage hors de la vidéo ou antérieure au début');
    if (input.audioTrackId && !revision.audio?.tracks.some((t) => t.id === input.audioTrackId))
      throw new Error('Piste audio introuvable dans cette révision');
    const now = Date.now();
    const row = this.repo.createFeedback({
      id: newId('fdb'),
      projectId: revision.projectId,
      revisionId: revision.id,
      timestampMs,
      rangeEndMs: input.rangeEndMs ?? null,
      audioTrackId: input.audioTrackId ?? null,
      frameIndex,
      fpsNum: media?.fpsNum ?? null,
      fpsDen: media?.fpsDen ?? null,
      sceneId: sceneAt(revision.storyboard, timestampMs)?.id ?? null,
      text,
      author: input.author,
      createdAt: now,
      updatedAt: now
    });
    this.repo.touchProject(revision.projectId);
    // The capture is evidence, not a requirement: a failed extraction keeps the comment.
    if (revision.videoPath && frameIndex !== null)
      try {
        const path = this.storage.annotationPath(revision.projectId, revision.id, row.id);
        await extractFrameByIndex(revision.videoPath, frameIndex, path);
        return this.repo.updateDraftFeedback(row.id, { capturePath: path });
      } catch {
        return row;
      }
    return row;
  }
  editAnnotation(id: string, text: string) {
    const value = text.trim();
    if (!value) throw new Error('Commentaire vide');
    if (value.length > this.settings.app.review.maxCommentLength)
      throw new Error('Commentaire trop long');
    return this.repo.updateDraftFeedback(id, { text: value });
  }
  deleteAnnotation(id: string) {
    const row = this.repo.deleteDraftFeedback(id);
    if (row.capturePath) rmSync(row.capturePath, { force: true });
    return row;
  }

  // --- Correction batches: one logical AI request for a group of comments.

  /**
   * Idempotent on `submissionKey`: resubmitting the same form returns the same batch
   * without a second request. Only drafts of a single source revision can be sent.
   */
  submitBatch(input: { revisionId: string; feedbackIds: string[]; submissionKey: string }) {
    const existing = this.repo.batchByKey(input.submissionKey);
    if (existing) return existing;
    const ai = this.requireAi();
    const ids = [...new Set(input.feedbackIds)];
    if (!ids.length) throw new Error('Aucun commentaire sélectionné');
    if (ids.length > this.settings.app.review.maxBatchSize)
      throw new Error(`Lot limité à ${this.settings.app.review.maxBatchSize} commentaires`);
    const revision = this.repo.getRevision(input.revisionId);
    if (revision.status !== 'awaiting_approval')
      throw new Error('Seule une révision en attente de validation peut être corrigée');
    if (this.activity.has(revision.projectId)) throw new Error('Un traitement est déjà en cours');
    const batch = this.repo.transaction(() => {
      const items = ids.map((id) => this.repo.getFeedback(id));
      if (items.some((item) => !item || item.revisionId !== revision.id))
        throw new Error('Les commentaires doivent appartenir à la même révision source');
      if (items.some((item) => item!.status !== 'draft'))
        throw new Error('Commentaire déjà envoyé dans un autre lot');
      const now = Date.now();
      const row = this.repo.createBatch({
        id: newId('cbt'),
        projectId: revision.projectId,
        sourceRevisionId: revision.id,
        submissionKey: input.submissionKey,
        provider: ai.kind,
        feedbackIds: ids,
        createdAt: now,
        updatedAt: now
      });
      this.repo.attachFeedbackToBatch(ids, row.id);
      for (const id of ids) this.repo.transitionFeedback(id, 'queued');
      return row;
    });
    this.say(
      revision.projectId,
      'user',
      `Lot de ${ids.length} correction(s) envoyé à l'IA (${ai.kind}).`
    );
    void this.processBatch(batch.id);
    return batch;
  }

  retryBatch(batchId: string) {
    const batch = this.repo.getBatch(batchId);
    if (batch.status !== 'failed') throw new Error('Seul un lot en échec peut être relancé');
    if (this.activity.has(batch.projectId)) throw new Error('Un traitement est déjà en cours');
    this.repo.transaction(() => {
      this.repo.updateBatch(batchId, { status: 'queued', error: null });
      for (const id of batch.feedbackIds)
        if (this.repo.getFeedback(id)?.status === 'failed')
          this.repo.transitionFeedback(id, 'queued');
    });
    return this.processBatch(batchId);
  }

  private feedbackInputs(batch: CorrectionBatch): FeedbackInput[] {
    return batch.feedbackIds.map((id) => {
      const item = this.repo.getFeedback(id)!;
      return {
        id: item.id,
        text: item.text,
        timestampMs: item.timestampMs,
        rangeEndMs: item.rangeEndMs,
        audioTrackId: item.audioTrackId,
        frameIndex: item.frameIndex,
        sceneId: item.sceneId,
        capturePath: item.capturePath
      };
    });
  }
  private markItems(batch: CorrectionBatch, to: Feedback['status']) {
    for (const id of batch.feedbackIds) {
      const item = this.repo.getFeedback(id);
      if (item && item.status !== to) this.repo.transitionFeedback(id, to);
    }
  }

  private processBatch(batchId: string): Promise<void> {
    const batch = this.repo.getBatch(batchId);
    const revision = this.repo.getRevision(batch.sourceRevisionId);
    const ai = this.ai;
    const fail = (error: unknown) => {
      // Comments are kept; the batch can be retried as is.
      this.repo.updateBatch(batchId, { status: 'failed', error: message(error).slice(0, 2000) });
      for (const id of batch.feedbackIds) {
        const status = this.repo.getFeedback(id)?.status;
        if (status === 'queued' || status === 'submitted')
          this.repo.transitionFeedback(id, 'failed');
      }
      this.say(revision.projectId, 'system', `Échec du lot de corrections : ${message(error)}`);
    };
    if (!ai || ai.kind !== batch.provider) {
      fail(new Error(`Fournisseur « ${batch.provider} » non actif : aucun autre n'est utilisé.`));
      return Promise.resolve();
    }
    const inputs = this.feedbackInputs(batch);
    if (ai.mode === 'assisted') {
      try {
        const task = this.exportTask(
          revision.projectId,
          'plan',
          ai.planRequest(revision.storyboard, inputs, revision.audio),
          {
            batchId,
            input: { sourceRevisionId: revision.id },
            frames: inputs.filter((i) => i.capturePath).map((i) => [i.id, i.capturePath!])
          }
        );
        this.repo.updateBatch(batchId, { status: 'awaiting_import' });
        this.markItems(batch, 'submitted');
        this.say(revision.projectId, 'assistant', this.assistedInstructions(task.dir, 'plan'));
      } catch (error) {
        fail(error);
      }
      return Promise.resolve();
    }
    this.busy(revision.projectId, 'planning');
    this.repo.updateBatch(batchId, { status: 'submitted' });
    this.markItems(batch, 'submitted');
    this.say(revision.projectId, 'system', 'Analyse du lot en cours…');
    return ai
      .planRevision(revision.storyboard, inputs, revision.audio)
      .then((proposal) => {
        this.savePlan(batchId, proposal, ai.kind);
      })
      .catch(fail)
      .finally(() => this.activity.delete(revision.projectId));
  }

  private savePlan(batchId: string, proposal: RevisionProposal, kind: Provider['kind']) {
    const batch = this.repo.getBatch(batchId);
    const revision = this.repo.getRevision(batch.sourceRevisionId);
    const known = new Set(batch.feedbackIds);
    // Ids come from a model or an imported file: keep only ones that exist in this batch.
    const changes = proposal.changes.map((change) => ({
      ...change,
      feedbackId: change.feedbackId && known.has(change.feedbackId) ? change.feedbackId : null,
      sceneId: revision.storyboard.scenes.some((s) => s.id === change.sceneId)
        ? change.sceneId
        : null
    }));
    const conflicts = proposal.conflicts
      .map((c) => ({ ...c, feedbackIds: c.feedbackIds.filter((id) => known.has(id)) }))
      .filter((c) => c.feedbackIds.length >= 2);
    const plan = this.repo.createRevisionPlan({
      id: newId('pln'),
      revisionId: revision.id,
      feedbackIds: batch.feedbackIds,
      summary: proposal.summary,
      changes,
      audioChanges: proposal.audioChanges
        .filter((c) => revision.audio?.tracks.some((t) => t.id === c.trackId))
        .map((c) => ({
          ...c,
          feedbackId: c.feedbackId && known.has(c.feedbackId) ? c.feedbackId : null
        })),
      conflicts,
      createdAt: Date.now()
    });
    this.repo.updateBatch(batchId, { status: 'planned', planId: plan.id, error: null });
    this.say(
      revision.projectId,
      'assistant',
      this.label(
        `Plan de correction (${plan.changes.length + plan.audioChanges.length} modification(s)) :\n` +
          plan.changes.map((c) => `- ${c.instruction}`).join('\n') +
          (plan.audioChanges.length
            ? '\n' + plan.audioChanges.map((c) => `- Audio : ${c.instruction}`).join('\n')
            : '') +
          (plan.conflicts.length
            ? `\nConflits à arbitrer :\n${plan.conflicts.map((c) => `- ${c.description}`).join('\n')}`
            : '') +
          '\nVérifiez puis appliquez ou rejetez le plan.',
        kind
      )
    );
    return plan;
  }

  rejectPlan(batchId: string) {
    const batch = this.repo.getBatch(batchId);
    this.repo.transaction(() => {
      this.repo.updateBatch(batchId, { status: 'rejected' });
      this.markItems(batch, 'rejected');
    });
    this.say(batch.projectId, 'system', 'Plan de correction rejeté par l’utilisateur.');
  }

  applyPlan(planId: string) {
    const plan = this.repo.getPlan(planId);
    if (!plan) throw new Error('Plan introuvable');
    const source = this.repo.getRevision(plan.revisionId);
    if (source.status !== 'awaiting_approval')
      throw new Error('Plan déjà appliqué ou révision close');
    // Plans created before correction batches existed have no batch.
    const batch = this.repo.listBatches(source.projectId).find((item) => item.planId === planId);
    if (batch && batch.status !== 'planned') throw new Error('Plan déjà traité');
    applyProposal(source.storyboard, plan.changes, this.settings.app.maxDurationSeconds * 1000);
    this.patchedAudio(source.audio, plan.audioChanges);
    this.busy(source.projectId, 'generating');
    const run = this.repo.transaction(() => {
      this.repo.transitionRevision(source.id, 'changes_requested');
      for (const id of plan.feedbackIds)
        if (this.repo.getFeedback(id)?.status === 'submitted')
          this.repo.transitionFeedback(id, 'applied');
      return this.createRevisionRun(
        source,
        plan,
        (batch?.provider as Provider['kind'] | undefined) ?? 'rules'
      );
    });
    this.finishApproval(source.id, { decision: 'changes_requested' });
    this.say(source.projectId, 'assistant', 'Plan appliqué : rendu de la nouvelle révision.');
    return this.background(source.projectId, async () => {
      await this.orchestrator.drive(run.id, this.revisionRunners(run));
    });
  }

  private patchedAudio(audio: AudioComposition | null, changes: RevisionPlan['audioChanges']) {
    if (!changes.length) return audio;
    let result = audio;
    for (const change of changes) {
      result = audioCompositionSchema.parse({
        ...result,
        tracks: result?.tracks.map((t) => (t.id === change.trackId ? { ...t, ...change.patch } : t))
      });
    }
    return result;
  }

  private createRevisionRun(
    source: RevisionRow,
    payload: RevisionPlan | AudioComposition,
    provider: Provider['kind'] | 'rules'
  ) {
    const manual = 'tracks' in payload;
    const routing = planRevisionPhases(
      manual ? { changes: [], audioChanges: [payload] } : payload,
      this.productionBudget()
    );
    const plan: ProductionPlan = {
      ...routing.plan,
      phases: [
        { phase: 'plan', agent: 'review', dependsOn: [], maxAttempts: 1 },
        ...routing.plan.phases.map((p) => ({
          ...p,
          dependsOn: p.dependsOn.length ? p.dependsOn : ['plan' as const]
        }))
      ]
    };
    return this.orchestrator.create({
      projectId: source.projectId,
      kind: 'revision',
      sourceRevisionId: source.id,
      plan,
      done: {
        plan: {
          kind: 'done',
          provider,
          payload: manual
            ? payload
            : {
                ...payload,
                affectedAgents: routing.affectedAgents,
                affectedPhases: routing.affectedPhases
              }
        }
      }
    });
  }

  private revisionRunners(run: ProductionRun): Runners {
    const source = this.repo.getRevision(run.sourceRevisionId!);
    const payload = this.phasePayload<RevisionPlan | AudioComposition>(run.id, 'plan');
    const manual = 'tracks' in payload;
    const plan = manual ? null : payload;
    const batch = plan
      ? this.repo.listBatches(run.projectId).find((b) => b.planId === plan.id)
      : null;
    return {
      ...this.renderRunners(run),
      motion: {
        run: async () => ({
          kind: 'done',
          provider: 'rules',
          payload: {
            storyboard: applyProposal(
              source.storyboard,
              plan!.changes,
              this.settings.app.maxDurationSeconds * 1000
            )
          }
        })
      },
      audio: {
        run: async () => ({
          kind: 'done',
          provider: 'rules',
          payload: manual ? payload : this.patchedAudio(source.audio, plan!.audioChanges)
        })
      },
      composition: {
        run: async (inputs) => {
          const child = this.repo.transaction(() => {
            const revision = this.newRevision(
              source.projectId,
              (inputs.motion as { storyboard: VideoRevision['storyboard'] } | undefined)
                ?.storyboard ?? source.storyboard,
              source.id,
              plan
                ? batch
                  ? { planId: plan.id, batchId: batch.id }
                  : { planId: plan.id }
                : { audioRevision: 'manual' },
              batch?.provider ?? String(source.resolvedConfig.aiProvider ?? 'none'),
              (inputs.audio as AudioComposition) ?? source.audio
            );
            if (batch)
              this.repo.updateBatch(batch.id, { status: 'applied', resultRevisionId: revision.id });
            return revision;
          });
          return {
            kind: 'done',
            payload: { revisionId: child.id },
            revisionId: child.id,
            provider: 'engine'
          };
        }
      }
    };
  }

  private finishApproval(revisionId: string, payload: Record<string, string>) {
    const revision = this.repo.getRevision(revisionId);
    for (const run of this.repo.listRuns(revision.projectId)) {
      if (run.revisionId !== revisionId || run.status !== 'waiting') continue;
      if (
        !this.orchestrator
          .phases(run.id)
          .some((p) => p.phase === 'human-approval' && p.status === 'waiting')
      )
        continue;
      this.orchestrator.complete(run.id, 'human-approval', {
        kind: 'done',
        payload,
        provider: 'human'
      });
      void this.orchestrator.drive(run.id, {});
    }
  }

  stopProduction(runId: string) {
    this.orchestrator.stop(runId);
  }

  resumeProduction(runId: string) {
    const run = this.repo.getRun(runId);
    const runners =
      run.kind === 'production' ? this.productionRunners(run) : this.revisionRunners(run);
    if (this.ai?.mode !== 'assisted') this.busy(run.projectId, 'generating');
    return this.background(run.projectId, async () => {
      await this.orchestrator.resume(runId, runners);
    });
  }

  approve(revisionId: string) {
    const revision = this.repo.getRevision(revisionId);
    this.repo.transitionRevision(revisionId, 'approved');
    this.finishApproval(revisionId, { approvedRevisionId: revisionId });
    this.say(revision.projectId, 'system', 'Révision validée par l’utilisateur.');
  }

  // --- Assisted mode (claude-subscribe): export a request, import a validated result.

  private exportTask(
    projectId: string,
    kind: 'storyboard' | 'plan' | 'evaluation',
    request: object,
    options: { batchId?: string; input: Record<string, string | null>; frames?: string[][] }
  ) {
    const id = newId('tsk');
    const dir = this.storage.taskDir(projectId, id);
    writeFileSync(join(dir, 'request.json'), JSON.stringify(request, null, 2));
    if (options.frames?.length) {
      mkdirSync(join(dir, 'frames'), { recursive: true });
      for (const [feedbackId, path] of options.frames)
        copyFileSync(path, safePath(dir, 'frames', `${validateId(feedbackId, 'fdb')}.png`));
    }
    const now = Date.now();
    return this.repo.createTask({
      id,
      projectId,
      kind,
      provider: 'claude-subscribe',
      batchId: options.batchId ?? null,
      input: options.input,
      dir,
      createdAt: now,
      updatedAt: now
    });
  }
  private assistedInstructions(dir: string, kind: 'storyboard' | 'plan' | 'evaluation') {
    return this.label(
      `Demande ${kind === 'plan' ? 'de plan de correction' : kind === 'evaluation' ? "d'expertise QA" : 'de storyboard'} exportée. Veyra n'appelle pas Claude : dans Claude Code (connecté à votre abonnement), à la racine du dépôt Veyra, lancez « /veyra-assisted-task ${dir} », puis cliquez sur « Importer le résultat ».`,
      'claude-subscribe'
    );
  }

  /** Validates result.json written by the user's Claude Code session; nothing runs from it. */
  importTask(taskId: string) {
    const task = this.repo.getTask(taskId);
    if (task.status !== 'awaiting_import') throw new Error('Tâche déjà importée');
    const assisted = new AssistedProvider();
    let raw: unknown;
    try {
      const path = safePath(task.dir, 'result.json');
      if (statSync(path).size > 1024 * 1024) throw new Error('result.json dépasse 1 Mo');
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      const text = `Résultat illisible : ${message(error)}`;
      this.repo.updateTask(taskId, { error: text });
      throw new Error(text, { cause: error });
    }
    if (task.kind === 'evaluation') {
      let review: ExpertReview;
      try {
        review = assisted.parseResult('evaluation', raw);
      } catch (error) {
        this.repo.updateTask(taskId, { error: `Résultat non conforme : ${message(error)}` });
        throw new Error('Résultat non conforme au schéma attendu', { cause: error });
      }
      const { evaluationId } = task.input as { evaluationId: string };
      const evaluation = this.repo.getEvaluation(evaluationId);
      const pack = this.loadPack(evaluation);
      const clean = sanitizeReview(review, pack);
      // Multimodal only if Claude Code says it looked at images that were really in the pack.
      const done = this.completeEvaluation(
        evaluationId,
        clean,
        clean.imagesExamined.length ? 'multimodal' : 'text-only'
      );
      this.repo.updateTask(taskId, { status: 'imported', error: null });
      return done;
    }
    if (task.kind === 'plan') {
      let proposal: RevisionProposal;
      try {
        proposal = assisted.parseResult('plan', raw);
      } catch (error) {
        this.repo.updateTask(taskId, { error: `Résultat non conforme : ${message(error)}` });
        throw new Error('Résultat non conforme au schéma attendu', { cause: error });
      }
      const plan = this.savePlan(task.batchId!, proposal, 'claude-subscribe');
      this.repo.updateTask(taskId, { status: 'imported', error: null });
      return plan;
    }
    let draft: StoryboardDraft;
    try {
      draft = assisted.parseResult('storyboard', raw);
    } catch (error) {
      this.repo.updateTask(taskId, { error: `Résultat non conforme : ${message(error)}` });
      throw new Error('Résultat non conforme au schéma attendu', { cause: error });
    }
    this.busy(task.projectId, 'generating');
    this.repo.updateTask(taskId, { status: 'imported', error: null });
    const input = task.input as { prompt: string; parentRevisionId: string | null; runId?: string };
    let run: ProductionRun;
    if (input.runId) {
      this.orchestrator.complete(input.runId, 'script', {
        kind: 'done',
        payload: draft,
        provider: 'claude-subscribe'
      });
      run = this.repo.getRun(input.runId);
    } else {
      const brief = this.productionBrief(task.projectId, input.prompt);
      const plan = planProduction(brief, this.productionBudget());
      run = this.orchestrator.create({
        projectId: task.projectId,
        kind: 'production',
        brief,
        plan,
        sourceRevisionId: input.parentRevisionId,
        done: {
          plan: { kind: 'done', payload: plan, provider: 'rules' },
          script: { kind: 'done', payload: draft, provider: 'claude-subscribe' }
        }
      });
    }
    return this.background(task.projectId, async () => {
      await this.orchestrator.drive(run.id, this.productionRunners(run));
    });
  }

  // --- QA review: qualitative review by the provider, plus comparative correction checks.

  async review(revision: RevisionRow, videoPath: string): Promise<ReviewFinding[]> {
    const findings: ReviewFinding[] = [];
    if (this.ai?.mode === 'direct') {
      // Frames at each scene's midpoint: what the qualitative reviewer actually receives.
      const times = revision.storyboard.scenes.map((s) => Math.round(s.start + s.duration / 2));
      const frames = (await extractFrames(videoPath, times)).map((path, index) => ({
        path,
        timestampMs: times[index]
      }));
      findings.push(...(await this.ai.reviewFrames(revision.storyboard, frames)));
    }
    findings.push(...(await this.verifyCorrections(revision, videoPath)));
    return findings;
  }

  /**
   * Deterministic before/after check of each requested correction: the storyboard
   * must carry the planned values, and the affected scene must visibly differ between
   * the previous and the new render. Untargeted scenes are checked for regressions.
   */
  private async verifyCorrections(
    revision: RevisionRow,
    videoPath: string
  ): Promise<ReviewFinding[]> {
    const { planId, batchId } = originOf(revision);
    const plan = planId ? this.repo.getPlan(planId) : undefined;
    if (!plan || !revision.parentRevisionId) return [];
    const parent = this.repo.getRevision(revision.parentRevisionId);
    const threshold = this.settings.quality.correctionCheck.psnrThresholdDb;
    const findings: ReviewFinding[] = [];
    const verification: NonNullable<CorrectionBatch['verification']> = [];
    const scenesById = (rev: RevisionRow) => new Map(rev.storyboard.scenes.map((s) => [s.id, s]));
    const before = scenesById(parent);
    const after = scenesById(revision);
    const workdir = join(
      this.storage.ensureRevision(revision.projectId, revision.id).revision,
      'qa'
    );
    rmSync(workdir, { recursive: true, force: true });
    mkdirSync(workdir, { recursive: true });
    let shot = 0;
    /** Smallest PSNR between both renders at the same offsets inside a scene. */
    const differs = async (old: Scene, next: Scene, offsets: number[]) => {
      if (!parent.videoPath) throw new Error('rendu précédent absent');
      let min = Infinity;
      for (const offset of offsets) {
        const [a] = await extractFrames(parent.videoPath, [old.start + offset]);
        const [b] = await extractFrames(videoPath, [next.start + offset]);
        const [ca, cb] = [join(workdir, `${shot}-a.png`), join(workdir, `${shot++}-b.png`)];
        copyFileSync(a, ca);
        copyFileSync(b, cb);
        for (const path of [a, b]) rmSync(dirname(path), { recursive: true, force: true });
        min = Math.min(min, await compareFrames(ca, cb));
      }
      return min;
    };
    const targeted = new Set<string>();
    for (const [index, feedbackId] of plan.feedbackIds.entries()) {
      const item = this.repo.getFeedback(feedbackId);
      const changes = plan.changes.filter(
        (c) => c.feedbackId === feedbackId && c.sceneId && Object.keys(c.patch).length
      );
      let verdict: CorrectionVerdict;
      let evidence: string;
      if (!changes.length) {
        verdict = 'not_applied';
        evidence = plan.conflicts.some((c) => c.feedbackIds.includes(feedbackId))
          ? 'Conflit avec un autre commentaire : aucune modification appliquée.'
          : 'Le plan ne contient aucune modification exprimable pour ce commentaire.';
      } else
        try {
          let expected = 0;
          let found = 0;
          const notes: string[] = [];
          let psnr = Infinity;
          for (const change of changes) {
            const old = before.get(change.sceneId!);
            const next = after.get(change.sceneId!);
            if (!old || !next) throw new Error('scène absente du rendu');
            targeted.add(next.id);
            // Component parameters are checked one by one against the new scene.
            const { params: paramPatch, ...fields } = change.patch;
            for (const [key, value] of Object.entries(paramPatch ?? {})) {
              expected++;
              const actual = (next.component?.params as Record<string, unknown> | undefined)?.[key];
              const same = JSON.stringify(actual) === JSON.stringify(value);
              if (same) found++;
              notes.push(`params.${key} ${same ? '=' : '≠'} ${JSON.stringify(value)}`);
            }
            for (const [key, value] of Object.entries(fields) as [
              Exclude<keyof ScenePatch, 'params'>,
              unknown
            ][]) {
              expected++;
              const actual = {
                text: next.text,
                durationMs: next.duration,
                enter: next.animation.enter,
                animationMs: next.animation.durationMs
              }[key];
              if (actual === value) found++;
              notes.push(`${key} ${actual === value ? '=' : '≠'} ${JSON.stringify(value)}`);
            }
            const anims = [old, next].map((s) => Number(s.animation.durationMs ?? 0));
            const span = Math.min(old.duration, next.duration) - 1;
            const offsets = [
              Math.min(...anims) / 2,
              Math.max(...anims) / 2,
              Math.max(...anims),
              Math.min(old.duration, next.duration) / 2
            ].map((ms) => Math.min(Math.round(ms), span));
            psnr = Math.min(psnr, await differs(old, next, [...new Set(offsets)]));
          }
          const visible = psnr < threshold;
          const measured = `PSNR min ${psnr === Infinity ? '∞' : psnr.toFixed(1)} dB (seuil ${threshold})`;
          evidence = `Storyboard : ${notes.join(', ')}. Rendu avant/après : ${measured}.`;
          verdict =
            found === 0
              ? 'not_applied'
              : found < expected || !visible
                ? 'partially_applied'
                : 'applied';
          if (found === expected && !visible)
            evidence += ' Source modifiée, mais aucune différence visuelle mesurée.';
        } catch (error) {
          verdict = 'unverifiable';
          evidence = `Comparaison impossible : ${message(error)}.`;
        }
      verification.push({ feedbackId, verdict, evidence });
      findings.push({
        name: `Correction ${index + 1} — ${verdictLabels[verdict]}`,
        passed: verdict === 'applied',
        severity: verdict === 'applied' || verdict === 'unverifiable' ? 'info' : 'minor',
        timestampMs: item?.timestampMs ?? 0,
        sceneId: changes[0]?.sceneId ?? item?.sceneId ?? null,
        evidence: `« ${item?.text.slice(0, 80) ?? feedbackId} » ${evidence}`,
        recommendation:
          verdict === 'applied' ? 'Aucune action' : 'Vérifier visuellement et reformuler si besoin',
        analysisMode: 'deterministic'
      });
    }
    // Scenes nobody asked to change should look the same as before.
    for (const next of revision.storyboard.scenes) {
      const old = before.get(next.id);
      if (targeted.has(next.id) || !old) continue;
      try {
        const psnr = await differs(old, next, [
          Math.round(Math.min(old.duration, next.duration) / 2)
        ]);
        if (psnr < threshold)
          findings.push({
            name: 'Régression possible',
            passed: false,
            severity: 'minor',
            timestampMs: Math.round(next.start + next.duration / 2),
            sceneId: next.id,
            evidence: `Scène non ciblée « ${next.text.slice(0, 60)} » différente du rendu précédent (PSNR ${psnr.toFixed(1)} dB).`,
            recommendation: 'Comparer les deux versions avant validation',
            analysisMode: 'deterministic'
          });
      } catch {
        // Regressions are best effort; correction verdicts above already report failures.
      }
    }
    if (batchId) this.repo.updateBatch(batchId, { verification });
    return findings;
  }

  // --- Expert QA (QualityEvaluator): intent-level verdicts on a corrected revision.

  /**
   * Builds the evidence pack and asks the active provider's evaluator. Unavailable
   * or failing providers are recorded as such; measurements stay as they are.
   */
  async requestEvaluation(revisionId: string) {
    const revision = this.repo.getRevision(revisionId);
    const { planId, batchId } = originOf(revision);
    const plan = planId ? this.repo.getPlan(planId) : undefined;
    if (!plan || !revision.parentRevisionId || !revision.videoPath)
      throw new Error('Aucune correction rendue à évaluer pour cette révision');
    const base = this.repo.getRevision(revision.parentRevisionId);
    const ai = this.ai;
    const now = Date.now();
    const row = this.repo.createEvaluation({
      id: newId('qev'),
      projectId: revision.projectId,
      revisionId,
      baseRevisionId: base.id,
      batchId: batchId ?? null,
      evaluator: ai?.kind ?? null,
      createdAt: now,
      updatedAt: now
    });
    if (!ai) return this.endEvaluation(row.id, 'unavailable', 'Aucun fournisseur IA configuré.');
    let pack: EvaluationInput;
    try {
      pack = await this.buildPack(row.id, revision, base, plan);
    } catch (error) {
      return this.endEvaluation(
        row.id,
        'failed',
        `Preuves impossibles à extraire : ${message(error)}`
      );
    }
    if (ai.mode === 'assisted') {
      const task = this.exportTask(revision.projectId, 'evaluation', ai.evaluationRequest(pack), {
        batchId,
        input: { evaluationId: row.id }
      });
      mkdirSync(join(task.dir, 'images'), { recursive: true });
      for (const image of pack.images)
        copyFileSync(image.path, safePath(task.dir, 'images', image.file));
      this.repo.updateEvaluation(row.id, { status: 'awaiting_import' });
      this.say(revision.projectId, 'assistant', this.assistedInstructions(task.dir, 'evaluation'));
      return this.repo.getEvaluation(row.id);
    }
    try {
      const { review, analysisMode } = await ai.qualityEvaluator().evaluate(pack);
      return this.completeEvaluation(row.id, sanitizeReview(review, pack), analysisMode);
    } catch (error) {
      return this.endEvaluation(
        row.id,
        error instanceof ProviderUnavailableError ? 'unavailable' : 'failed',
        message(error)
      );
    }
  }

  private endEvaluation(id: string, status: 'failed' | 'unavailable', reason: string) {
    const row = this.repo.updateEvaluation(id, { status, error: reason.slice(0, 2000) });
    this.say(
      row.projectId,
      'system',
      `Expertise QA ${status === 'unavailable' ? 'indisponible' : 'en échec'} : ${reason} Les mesures déterministes restent valables ; la validation reste la vôtre.`
    );
    return row;
  }

  private completeEvaluation(id: string, review: ExpertReview, mode: EvaluationMode) {
    const row = this.repo.updateEvaluation(id, {
      status: 'completed',
      analysisMode: mode,
      verdicts: review.verdicts as never,
      findings: review.findings as never,
      imagesExamined: review.imagesExamined,
      error: null
    });
    const regressions = row.findings.filter((f) => f.kind === 'regression').length;
    this.say(
      row.projectId,
      'assistant',
      this.label(
        `Expertise QA (${row.evaluator}, ${modeLabel(row.evaluator, mode)}) : ` +
          row.verdicts
            .map(
              (v, i) =>
                `#${i + 1} ${verdictLabels[v.verdict]} (${v.category}, confiance ${Math.round(v.confidence * 100)} %)`
            )
            .join(', ') +
          (regressions ? ` ; ${regressions} régression(s) signalée(s)` : '') +
          '. Avis consultatif : la validation reste la vôtre.',
        row.evaluator ?? undefined
      )
    );
    return row;
  }

  private packDir(evaluation: { projectId: string; revisionId: string; id: string }) {
    const { revision } = this.storage.ensureRevision(evaluation.projectId, evaluation.revisionId);
    mkdirSync(join(revision, 'qa-expert'), { recursive: true });
    const dir = safePath(revision, 'qa-expert', evaluation.id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  private providedEvidence(evaluation: { projectId: string; revisionId: string; id: string }) {
    try {
      return this.loadPack(evaluation).images.map(
        ({ file, revision, role, feedbackId, sceneId, timestampMs }) => ({
          file,
          revision,
          role,
          feedbackId,
          sceneId,
          timestampMs
        })
      );
    } catch {
      return [];
    }
  }
  private loadPack(evaluation: { projectId: string; revisionId: string; id: string }) {
    return JSON.parse(
      readFileSync(join(this.packDir(evaluation), 'input.json'), 'utf8')
    ) as EvaluationInput;
  }

  /**
   * Evidence for the evaluator: exact frames of both renders at the same moment of
   * each scene (scenes may have moved or changed length), temporal sequences for
   * timing changes, and untouched scenes for regressions.
   */
  private async buildPack(
    evaluationId: string,
    revision: RevisionRow,
    base: RevisionRow,
    plan: NonNullable<ReturnType<Repository['getPlan']>>
  ): Promise<EvaluationInput> {
    if (!base.videoPath || !revision.videoPath) throw new Error('rendu manquant');
    const dir = this.packDir({
      projectId: revision.projectId,
      revisionId: revision.id,
      id: evaluationId
    });
    const timing = (rev: RevisionRow) => {
      const rate = rev.media
        ? { num: rev.media.fpsNum, den: rev.media.fpsDen }
        : { num: Math.round(rev.storyboard.fps), den: 1 };
      return { rate, count: rev.media?.frameCount ?? frameCount(endOf(rev), rate) };
    };
    const clocks = { before: timing(base), after: timing(revision) };
    const wanted: Omit<EvaluationImage, 'path'>[] = [];
    const want = (
      side: 'before' | 'after',
      scene: Scene,
      offsetMs: number,
      role: EvaluationImage['role'],
      file: string,
      feedbackId: string | null
    ) => {
      const ms = scene.start + Math.max(0, Math.min(Math.round(offsetMs), scene.duration - 1));
      const { rate, count } = clocks[side];
      wanted.push({
        file,
        revision: side,
        role,
        feedbackId,
        sceneId: scene.id,
        frameIndex: frameAt(ms, rate, count),
        timestampMs: ms,
        offsetMs: ms - scene.start
      });
    };
    const before = new Map(base.storyboard.scenes.map((s) => [s.id, s]));
    const after = new Map(revision.storyboard.scenes.map((s) => [s.id, s]));
    const images: EvaluationImage[] = [];
    const comments: EvaluationInput['comments'] = [];
    const targeted = new Set<string>();
    for (const id of plan.feedbackIds) {
      const item = this.repo.getFeedback(id);
      if (!item) continue;
      const changes = plan.changes.filter((c) => c.feedbackId === id);
      const sceneId = changes.find((c) => c.sceneId)?.sceneId ?? item.sceneId;
      const old = sceneId ? before.get(sceneId) : undefined;
      const next = sceneId ? after.get(sceneId) : undefined;
      const offset = old ? item.timestampMs - old.start : 0;
      if (sceneId) targeted.add(sceneId);
      comments.push({
        feedbackId: id,
        text: item.text,
        frameIndex: item.frameIndex,
        timestampMs: item.timestampMs,
        sceneId: sceneId ?? null,
        alignedTimestampMs: next
          ? next.start + Math.min(Math.max(0, offset), next.duration - 1)
          : null,
        plannedChanges: changes.map(({ instruction, patch }) => ({ instruction, patch })),
        inConflict: plan.conflicts.some((c) => c.feedbackIds.includes(id))
      });
      // The annotated frame itself, exactly as the user saw it.
      if (item.capturePath && old) {
        const file = `${id}-before-capture.png`;
        copyFileSync(item.capturePath, join(dir, file));
        images.push({
          file,
          path: join(dir, file),
          revision: 'before',
          role: 'capture',
          feedbackId: id,
          sceneId: old.id,
          frameIndex:
            item.frameIndex ?? frameAt(item.timestampMs, clocks.before.rate, clocks.before.count),
          timestampMs: item.timestampMs,
          offsetMs: offset
        });
      }
      if (!old || !next) continue;
      want('after', next, offset, 'aligned', `${id}-after-aligned.png`, id);
      // Always a sequence: the comment may ask for motion even when the plan does not touch it.
      {
        const anim = Math.max(
          Number(old.animation.durationMs ?? 0),
          Number(next.animation.durationMs ?? 0),
          500
        );
        const span = Math.min(anim * 1.5, old.duration - 1, next.duration - 1);
        for (let k = 0; k < SEQUENCE_FRAMES; k++) {
          const at = (span * k) / (SEQUENCE_FRAMES - 1);
          want('before', old, at, 'sequence', `${id}-before-seq-${k}.png`, id);
          want('after', next, at, 'sequence', `${id}-after-seq-${k}.png`, id);
        }
      }
    }
    for (const next of revision.storyboard.scenes) {
      const old = before.get(next.id);
      if (!old || targeted.has(next.id)) continue;
      const mid = Math.min(old.duration, next.duration) / 2;
      want('before', old, mid, 'scene', `${next.id}-before-scene.png`, null);
      want('after', next, mid, 'scene', `${next.id}-after-scene.png`, null);
    }
    for (const side of ['before', 'after'] as const) {
      const list = wanted.filter((w) => w.revision === side);
      if (!list.length) continue;
      const video = side === 'before' ? base.videoPath : revision.videoPath;
      const paths = await extractFramesByIndex(
        video,
        list.map((w) => w.frameIndex),
        dir
      );
      list.forEach((w, i) => {
        copyFileSync(paths[i], join(dir, w.file));
        images.push({ ...w, path: join(dir, w.file) });
      });
    }
    let prompt: string | null = null;
    for (let rev: RevisionRow | null = base; rev && !prompt;) {
      prompt = (rev.resolvedConfig.origin as { prompt?: string } | undefined)?.prompt ?? null;
      rev = rev.parentRevisionId ? this.repo.getRevision(rev.parentRevisionId) : null;
    }
    const batch = this.repo.listBatches(revision.projectId).find((b) => b.planId === plan.id);
    const report = this.repo.reportsFor([revision.id]).at(-1);
    const pack: EvaluationInput = {
      language: this.settings.quality.reportLanguage,
      brief: {
        prompt,
        styleInstructions: this.settings.style.instructions,
        palette: this.settings.style.palette,
        fonts: this.settings.style.fonts
      },
      before: { revisionId: base.id, storyboard: base.storyboard },
      after: { revisionId: revision.id, storyboard: revision.storyboard },
      comments,
      measurements: [
        ...(batch?.verification ?? []).map((v) => ({
          feedbackId: v.feedbackId,
          sceneId: null,
          kind: 'correction' as const,
          verdict: v.verdict,
          evidence: v.evidence
        })),
        ...(report?.issues ?? [])
          .filter((i) => i.evidence.startsWith('Scène non ciblée'))
          .map((i) => ({
            feedbackId: null,
            sceneId: i.sceneId,
            kind: 'regression' as const,
            verdict: null,
            evidence: i.evidence
          }))
      ],
      images
    };
    writeFileSync(join(dir, 'input.json'), JSON.stringify(pack, null, 2));
    return pack;
  }

  /** Writes an upload once, as an exclusive original that nothing ever modifies. */
  private storeOriginal(projectId: string, file: File, data: Uint8Array) {
    if (!this.repo.getProject(projectId)) throw new Error('Projet introuvable');
    validateId(projectId, 'prj');
    const safeName =
      file.name
        .replace(/[^\w.-]+/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 100) || 'fichier';
    const id = newId('ast');
    const path = this.storage.writeOriginal(projectId, `${id}-${safeName}`, data);
    const now = Date.now();
    const asset = this.repo.createAsset({
      id,
      projectId,
      path,
      mediaType: file.type || 'application/octet-stream',
      createdAt: now,
      updatedAt: now
    });
    return { asset, safeName };
  }

  addAsset(projectId: string, file: File, data: Uint8Array) {
    const { safeName } = this.storeOriginal(projectId, file, data);
    this.say(projectId, 'system', `Fichier ajouté : ${safeName} (conservé sans modification).`);
  }

  // --- Audio: imported files are untrusted media, validated before any use.

  private audioLimits() {
    const a = this.settings.audio;
    return {
      allowedFormats: a.allowedFormats,
      maxFileBytes: a.maxFileBytes,
      maxDurationMs: a.maxDurationSeconds * 1000,
      cpuSeconds: a.cpuSeconds,
      timeoutMs: a.timeoutMs
    };
  }

  /** Keeps the original even when refused, so the user sees why; only valid files can be used. */
  async importAudio(
    projectId: string,
    file: File,
    data: Uint8Array,
    category: AudioCategory | null = null
  ) {
    const { asset, safeName } = this.storeOriginal(projectId, file, data);
    try {
      const metadata = await probeAudio(asset.path, this.audioLimits());
      const row = this.repo.setAssetAudio(asset.id, {
        status: 'valid',
        metadata,
        error: null,
        category
      });
      this.say(
        projectId,
        'system',
        `Fichier audio ajouté : ${safeName} (${(metadata.durationMs / 1000).toFixed(1)} s, ${metadata.codec}, ${metadata.sampleRate} Hz).`
      );
      return row;
    } catch (error) {
      if (!(error instanceof AudioMediaError)) throw error;
      const row = this.repo.setAssetAudio(asset.id, {
        status: 'invalid',
        metadata: null,
        error: error.message,
        category
      });
      this.say(projectId, 'system', `Fichier audio refusé : ${safeName} — ${error.message}`);
      return row;
    }
  }

  /**
   * New soundtrack for a revision awaiting approval: the source stays as it is, a child
   * revision with the same storyboard and the new audio is rendered (picture reused).
   */
  reviseAudio(revisionId: string, composition: unknown) {
    const parsed = audioCompositionSchema.parse(composition);
    const source = this.repo.getRevision(revisionId);
    if (source.status !== 'awaiting_approval')
      throw new Error('Seule une révision en attente de validation peut être modifiée');
    for (const track of parsed.tracks) {
      const asset = this.repo.getAsset(track.assetId);
      if (asset?.projectId !== source.projectId || asset.audio?.status !== 'valid')
        throw new Error(`Piste « ${track.label} » : fichier audio absent ou refusé`);
    }
    this.busy(source.projectId, 'generating');
    const run = this.repo.transaction(() => {
      this.repo.transitionRevision(source.id, 'changes_requested');
      return this.createRevisionRun(source, parsed, 'rules');
    });
    this.finishApproval(source.id, { decision: 'changes_requested' });
    this.say(
      source.projectId,
      'assistant',
      `Bande son mise à jour (${parsed.tracks.length} piste(s)) : nouvelle révision, image réutilisée.`
    );
    return this.background(source.projectId, async () => {
      await this.orchestrator.drive(run.id, this.revisionRunners(run));
    });
  }

  /** Everything the Studio page needs, in one read. */
  snapshot(projectId: string) {
    const project = this.repo.getProject(projectId);
    if (!project) return null;
    const revisions = this.repo.listRevisions(projectId);
    const ids = revisions.map((r) => r.id);
    const runs = this.repo.listRuns(projectId);
    const conversation = this.repo.conversationFor(projectId);
    return {
      project,
      revisions,
      runs,
      phases: this.repo.phasesFor(runs.map((r) => r.id)),
      messages: conversation ? this.repo.listMessages(conversation.id) : [],
      // Paths stay server-side; the page only learns whether a capture exists.
      feedback: this.repo
        .listFeedback(projectId)
        .map(({ capturePath, ...item }) => ({ ...item, hasCapture: Boolean(capturePath) })),
      batches: this.repo.listBatches(projectId),
      tasks: this.repo.listTasks(projectId).map((task) => ({ ...task, input: undefined })),
      jobs: this.repo.renderJobsFor(ids),
      reports: this.repo.reportsFor(ids),
      plans: this.repo.plansFor(ids),
      // Each evaluation with the evidence it was given (no local paths).
      evaluations: this.repo.evaluationsFor(ids).map((evaluation) => ({
        ...evaluation,
        provided: this.providedEvidence(evaluation)
      })),
      assets: this.repo.listAssets(projectId).map(({ id, mediaType, path }) => ({
        id,
        mediaType,
        name: path.split('/').at(-1) ?? id
      })),
      activity: this.activityFor(projectId)
    };
  }
}
