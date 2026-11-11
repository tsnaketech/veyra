import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
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
  assertConstantFrameRate,
  frameAt,
  frameCount,
  frameTimestampMs,
  newId,
  resolveAnchor,
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
  type RevisionPlan,
  captionRulesSchema,
  captionStyleSchema,
  captionTrackSchema,
  groupCaptions,
  sceneFallbackWords,
  type CaptionRules,
  type CaptionStyle,
  type CaptionTrack,
  type CaptionWord,
  type Storyboard,
  storyboardSchema,
  voiceResultSchema,
  BudgetExceededError,
  usageMicroUsd,
  usdToMicroUsd,
  worstCaseMicroUsd
} from '@veyra/schemas';
import { captionBandRect, captionMetrics } from '@veyra/hyperframes-adapter';
import {
  type CallOptions,
  AssistedProvider,
  instructions,
  ProviderUnavailableError,
  applyProposal,
  sanitizeReview,
  type EvaluationImage,
  type EvaluationInput,
  type ExpertReview,
  toStoryboard,
  type FeedbackInput,
  type Provider,
  type ProviderId,
  type ReviewFinding,
  type RevisionProposal,
  type StoryboardDraft,
  directorGrants,
  planDirectorRevision,
  planProduction,
  planRevisionPhases,
  proposeAudio,
  providerCapabilities
} from '@veyra/ai';
import { visualTimeline, getComponent, registryVersion } from '@veyra/motion';
import {
  AudioMediaError,
  probeAudio,
  meanVolumeDb,
  importedVoiceResult,
  placeSceneVoice,
  voiceProvider
} from '@veyra/audio';
import type { createRepository } from './db/repo';
import type { RenderJobRunner, RenderSettings } from './jobs/runner';
import { Orchestrator, type RevisionEdit, type Runners } from './production';
import {
  answerQuestion,
  decidePermission,
  directorStepSource,
  LoopBudgetError,
  toolLoopRunner,
  type StepSource
} from './tool-loop';
import { studioToolRegistry, type ToolRegistry } from './tools';

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
  (revision.resolvedConfig.origin ?? {}) as { planId?: string; batchId?: string; runId?: string };
const verdictLabels: Record<CorrectionVerdict, string> = {
  applied: 'appliquée',
  partially_applied: 'partiellement appliquée',
  not_applied: 'non appliquée',
  contradicts_request: 'contraire à la demande',
  unverifiable: 'non vérifiable'
};
/** Providers billed per call on an API key: every call goes through the D022 envelope. */
const isBillable = (ai: Provider): ai is Provider & { model?: string } =>
  ai.kind === 'anthropic-api' || ai.kind === 'openai-api';
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
// Originals are stored as `${id}-${name}`; show the uploaded name only.
const assetName = (asset: { id: string; path: string }) => {
  const base = asset.path.split('/').at(-1) ?? asset.id;
  return base.startsWith(`${asset.id}-`) ? base.slice(asset.id.length + 1) : base;
};
const SEQUENCE_FRAMES = 5;
const soundWords = /musique|music|\bson\b|sonore|audio|voix|bruitage|effets? sonores?/i;
// Output defects a fresh render can fix; layout or content issues need a correction instead.
/** AI decisions of one Director run (each loop step is one call; maxSteps is 20). */
const DIRECTOR_AI_CALLS = 20;
const clip = (value: unknown, max: number) => {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
/** Revision run whose plan phase is the Director's tool loop (T129b-2). */
const isDirectorRun = (run: ProductionRun) =>
  run.kind === 'revision' &&
  run.plan.phases.some((p) => p.phase === 'plan' && p.agent === 'director');
const RETRYABLE = new Set(['duration', 'resolution', 'fps', 'codec', 'non-empty', 'black-frames']);

// --- Captions without any engine: words spread inside their scene from the narration.

type Format = { width: number; height: number };
/**
 * Characters that fit on one caption line: the style limit, bounded by the text
 * column of captionBandRect (rect width minus the horizontal padding) at an average
 * glyph width of 0.6 em. Font and padding follow the compositor (font = sizePct % of
 * the height, padX = font / 2).
 */
export function fittedCharsPerLine(style: CaptionStyle, format: Format) {
  const { font, padX } = captionMetrics(style, format);
  const rect = captionBandRect(style, format, 1);
  // 0.6 em: conservative average advance of a bold sans-serif glyph.
  const fit = Math.floor((rect.width - 2 * padX) / (0.6 * font));
  return Math.max(1, Math.min(style.maxCharsPerLine, fit));
}
const groupFitted = (
  words: CaptionWord[],
  track: Pick<CaptionTrack, 'style' | 'rules'>,
  format: Format
) =>
  groupCaptions(
    words,
    { maxLines: track.style.maxLines, maxCharsPerLine: fittedCharsPerLine(track.style, format) },
    track.rules
  );

/** Caption track from the script only: provider "script", every word timing "scene" (approximate). */
export function buildFallbackCaptions(
  storyboard: Pick<Storyboard, 'scenes'>,
  format: Format,
  style: Partial<CaptionStyle> = {},
  rules: Partial<CaptionRules> = {}
): CaptionTrack {
  const track = {
    style: captionStyleSchema.parse(style),
    rules: captionRulesSchema.parse(rules)
  };
  const words = sceneFallbackWords(storyboard.scenes);
  return captionTrackSchema.parse({
    schemaVersion: 1,
    id: newId('cap'),
    language: 'fr',
    words,
    cues: groupFitted(words, track, format),
    ...track,
    provenance: { provider: 'script' }
  });
}

/**
 * Rebuilds the fallback words of the given scenes of `board` and keeps every other
 * scene's words; cues are regrouped (deterministic, so unchanged scenes keep the same
 * cues). Non-"scene" timings that get replaced are reported, never dropped silently.
 */
function rebuildCaptionScenes(
  reference: Pick<Storyboard, 'scenes'>,
  board: Pick<Storyboard, 'scenes'>,
  captions: CaptionTrack,
  format: Format,
  rebuild: ReadonlySet<string>
) {
  const owner = (w: CaptionWord) => w.sceneId ?? sceneAt(reference as Storyboard, w.startMs)?.id;
  const warnings: string[] = [];
  const words = board.scenes.flatMap((scene, i) => {
    const old = captions.words.filter((w) => owner(w) === scene.id);
    if (!rebuild.has(scene.id)) return old;
    const kept = old.filter((w) => w.timing !== 'scene').length;
    if (kept)
      warnings.push(
        `Sous-titres de la scène ${i + 1} : ${kept} mot(s) aux temps ${[...new Set(old.filter((w) => w.timing !== 'scene').map((w) => w.timing))].join(', ')} remplacés par une répartition approximative dans la scène.`
      );
    return sceneFallbackWords([scene]);
  });
  const dropped = captions.words.filter((w) => !board.scenes.some((s) => s.id === owner(w))).length;
  if (dropped) warnings.push(`Sous-titres : ${dropped} mot(s) hors de toute scène retirés.`);
  const track = captionTrackSchema.parse({
    ...captions,
    words,
    cues: groupFitted(words, captions, format)
  });
  return { captions: track, warnings };
}

/**
 * Captions of a child revision whose storyboard changed: scenes whose start, duration
 * or narration changed (or that are new) get fresh "scene" words; the others are kept.
 */
export function refreshCaptions(
  parentBoard: Pick<Storyboard, 'scenes'>,
  childBoard: Pick<Storyboard, 'scenes'>,
  captions: CaptionTrack | null,
  format: Format
): { captions: CaptionTrack | null; warnings: string[] } {
  if (!captions) return { captions, warnings: [] };
  const before = new Map(parentBoard.scenes.map((s) => [s.id, s]));
  const changed = new Set(
    childBoard.scenes
      .filter((s) => {
        const old = before.get(s.id);
        return (
          !old ||
          old.start !== s.start ||
          old.duration !== s.duration ||
          old.narration?.text !== s.narration?.text
        );
      })
      .map((s) => s.id)
  );
  const removed = parentBoard.scenes.some((s) => !childBoard.scenes.some((c) => c.id === s.id));
  if (!changed.size && !removed) return { captions, warnings: [] };
  return rebuildCaptionScenes(parentBoard, childBoard, captions, format, changed);
}

const editReasons: Record<RevisionEdit['edit'], string> = {
  voice: 'Voix de scène : image réutilisée, nouveau mixage, sous-titres de la scène reconstruits.',
  narration: 'Narration modifiée : sous-titres de la scène reconstruits.',
  'caption-delivery': 'Livraison des sous-titres modifiée.'
};
export const captionDeliveries = ['burned', 'clean', 'both'] as const;

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
    this.orchestrator = new Orchestrator(
      repo,
      (projectId, text) => this.say(projectId, 'system', text),
      (runId) => {
        // Finished runs never call the AI again: drop their abort controller.
        if (['completed', 'failed', 'stopped'].includes(this.repo.getRun(runId).status))
          this.controllers.delete(runId);
      }
    );
    // No call can be in flight yet: reservations still held were orphaned by a crash.
    this.orchestrator.settleOrphanReservations();
  }

  get aiKind() {
    return this.ai?.kind ?? null;
  }
  /** Changing provider is explicit; work already exported keeps its own provider. */
  setProvider(provider: Provider | null) {
    this.ai = provider;
  }
  /** Builds a provider by id or throws why it cannot run; null when VEYRA_AI_PROVIDER locks the choice. */
  private projectAi: ((id: ProviderId) => Provider) | null = null;
  setProjectProviders(resolve: ((id: ProviderId) => Provider) | null) {
    this.projectAi = resolve;
  }
  /** Effective provider (D024): the project's own choice if set, else the global one; never a fallback. */
  private aiFor(projectId: string): Provider | null {
    const id = this.repo.getProject(projectId)?.aiProvider;
    return id && this.projectAi ? this.projectAi(id) : this.ai;
  }
  /** Effective provider of a project for display; an unavailable one is reported, not replaced. */
  providerFor(projectId: string) {
    try {
      return { kind: this.aiFor(projectId)?.kind ?? null, error: null };
    } catch (error) {
      return { kind: null, error: message(error) };
    }
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
  private label(text: string, kind = this.ai?.kind, model?: string | null) {
    if (kind === 'fake') return `[Simulé] ${text}`;
    if (kind === 'claude-subscribe') return `[Claude Code — mode assisté] ${text}`;
    if (kind === 'anthropic-api' && model) return `[API Anthropic — ${model}] ${text}`;
    if (kind === 'openai-api' && model) return `[API OpenAI — ${model}] ${text}`;
    if (kind === 'codex-chatgpt') return `[Codex — abonnement ChatGPT] ${text}`;
    return text;
  }

  // --- Spend envelope (D022): every billable call goes through a run and its envelope.

  private controllers = new Map<string, AbortController>();
  /** Abort signal of a run's AI calls; « Arrêter » aborts the call in flight. */
  private signalFor(runId: string) {
    let controller = this.controllers.get(runId);
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      this.controllers.set(runId, controller);
    }
    return controller.signal;
  }
  /** Run that produced a revision: its envelope pays the calls made about it. */
  private runOf(revision: Pick<RevisionRow, 'id' | 'projectId' | 'resolvedConfig'>) {
    return (
      originOf(revision).runId ??
      this.repo.listRuns(revision.projectId).find((r) => r.revisionId === revision.id)?.id ??
      null
    );
  }
  private price(model: string) {
    const row = this.settings.models.pricing[model];
    if (!row) throw new Error(`Appel facturable refusé : modèle ${model} sans tarif local`);
    return row;
  }
  /**
   * Options of one AI call. A billable provider needs a run: the worst case is reserved
   * on its envelope before the request and settled with the billed usage after it.
   * Simulated providers cost nothing and get no meter.
   */
  private callFor(ai: Provider, runId: string | null): CallOptions & { model?: string } {
    // Subscription (codex-chatgpt): no dollars to reserve, but « Arrêter » still stops the process.
    if (ai.kind === 'codex-chatgpt') return runId ? { signal: this.signalFor(runId) } : {};
    if (!isBillable(ai)) return {};
    if (!runId)
      throw new Error(
        'Appel facturable refusé : aucune production (et donc aucune enveloppe) ne couvre cette révision'
      );
    // Cheapest possible call (output ceiling only): refused here, before even counting tokens.
    const run = this.repo.getRun(runId);
    const floor = worstCaseMicroUsd(this.price(ai.model ?? ''), 0, this.settings.models.maxTokens);
    if (run.spentMicroUsd + run.reservedMicroUsd + floor > run.budgetMicroUsd)
      throw new BudgetExceededError(
        run.spentMicroUsd,
        run.reservedMicroUsd,
        run.budgetMicroUsd,
        floor
      );
    // One reservation at a time: a reused call is refused until the previous one is settled.
    let reserved: number | null = null;
    let model = '';
    const call: CallOptions & { model?: string } = {
      signal: this.signalFor(runId),
      meter: {
        before: (request) => {
          if (reserved !== null)
            throw new Error('Appel facturable refusé : la réservation précédente n’est pas réglée');
          model = request.model;
          const amount = worstCaseMicroUsd(
            this.price(model),
            request.inputTokens,
            request.maxTokens
          );
          this.repo.reserveBudget(runId, amount);
          reserved = amount;
        },
        after: (result) => {
          if (reserved === null) return;
          const amount = reserved;
          reserved = null;
          call.model = result?.model;
          this.repo.settleBudget(
            runId,
            amount,
            result ? usageMicroUsd(this.price(model), result.usage) : null
          );
        }
      }
    };
    return call;
  }
  /** Worst case of one storyboard call, for the prompt form; null without a billable provider. */
  storyboardEstimate(projectId: string) {
    const ai = this.providerFor(projectId).kind ? this.aiFor(projectId) : null;
    if (!ai || !isBillable(ai) || !ai.model || !this.settings.models.pricing[ai.model]) return null;
    const system = instructions.storyboard({
      targetDurationMs: 20000,
      styleInstructions: this.settings.style.instructions
    });
    // Upper bound without a network call: at most one token per byte, prompt up to 4 kB.
    const inputTokens = Buffer.byteLength(system) + 4096;
    return {
      model: ai.model,
      microUsd: worstCaseMicroUsd(this.price(ai.model), inputTokens, this.settings.models.maxTokens)
    };
  }
  /** Explicit increase of a run's envelope, in USD (never lowered, never above the ceiling). */
  raiseBudget(runId: string, usd: number) {
    this.assertBudgetCeiling(usd);
    return this.repo.raiseBudget(runId, usdToMicroUsd(usd));
  }
  private assertBudgetCeiling(usd: number) {
    const max = this.settings.models.maxBudgetUsd;
    if (usd > max)
      throw new Error(
        `Enveloppe refusée : ${usd} $ dépasse le plafond de ${max} $ par production (maxBudgetUsd de config/models.json)`
      );
  }
  private requireAi(projectId: string) {
    const ai = this.aiFor(projectId);
    if (!ai)
      throw new Error(
        'IA non configurée : choisir un fournisseur dans Paramètres (ou VEYRA_AI_PROVIDER).'
      );
    return ai;
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

  /**
   * A message in the project's chat. With a revision awaiting approval it is an edit
   * request for the Director (T129b-2) when the provider has the `director` capability;
   * otherwise (or with `fresh`) it produces a new video, as before.
   */
  sendPrompt(projectId: string, prompt: string, budgetUsd = 0, options: { fresh?: boolean } = {}) {
    const text = prompt.trim();
    if (!text) throw new Error('Message vide');
    if (!this.repo.getProject(projectId)) throw new Error('Projet introuvable');
    const ai = this.requireAi(projectId);
    this.assertBudgetCeiling(budgetUsd);
    const head = options.fresh
      ? undefined
      : this.repo.listRevisions(projectId).findLast((r) => r.status === 'awaiting_approval');
    const capability = providerCapabilities[ai.kind];
    if (head && ai.mode === 'direct' && capability?.director && ai.decideStep)
      return this.startDirector(head, text, budgetUsd);
    const parent = this.repo.listRevisions(projectId).at(-1) ?? null;
    if (ai.mode !== 'assisted') this.busy(projectId, 'generating');
    this.say(projectId, 'user', text);
    if (head)
      this.say(
        projectId,
        'system',
        `Montage par le Director indisponible pour ${ai.kind} (${capability?.directorNote ?? 'capacité director absente'}) : la demande produit une nouvelle vidéo, comme auparavant.`
      );
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
    if (budgetUsd > 0) this.repo.raiseBudget(run.id, usdToMicroUsd(budgetUsd));
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
          // Renders of this run: its composed revision and the automatic re-render children.
          // A Director run also counts the renders of revisions its tool loop produced.
          const owned = new Set([revisionId, ...this.loopRevisions(run.id)]);
          for (let grew = true; grew;) {
            grew = false;
            for (const r of this.repo.listRevisions(run.projectId)) {
              const origin = r.resolvedConfig.origin as Record<string, unknown> | undefined;
              if (
                !owned.has(r.id) &&
                r.parentRevisionId &&
                owned.has(r.parentRevisionId) &&
                (origin?.autoFix !== undefined || origin?.renderRetry !== undefined)
              ) {
                owned.add(r.id);
                grew = true;
              }
            }
          }
          const { maxRenders } = run.plan.budget;
          const remaining = maxRenders - this.repo.renderJobsFor([...owned]).length;
          if (remaining <= 0) throw new Error(`Budget de rendus épuisé (${maxRenders})`);
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
              target.audio,
              target.captions
            );
            this.repo.updateRun(run.id, { revisionId: target.id });
          }
          const revision = this.repo.getRevision(
            await this.render(run.projectId, target, 0, remaining)
          );
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
          const failed =
            report?.checks
              .filter((c) => !c.passed && c.analysisMode !== 'not-performed')
              .map((c) => c.name) ?? [];
          return {
            kind: 'done',
            payload: { failed, failedCount: failed.length, total: report?.checks.length ?? 0 },
            provider: 'engine',
            validation: 'needs-human'
          };
        }
      },
      // The approve button shows while expert QA still runs: a decision taken then is kept.
      'human-approval': {
        run: async () => {
          const { revisionId } = this.repo.getRun(run.id);
          const status = revisionId ? this.repo.getRevision(revisionId).status : null;
          if (status === 'approved')
            return { kind: 'done', payload: { approvedRevisionId: revisionId }, provider: 'human' };
          if (status === 'changes_requested')
            return {
              kind: 'done',
              payload: { decision: 'changes_requested' },
              provider: 'human'
            };
          return { kind: 'waiting' };
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
    const scriptResult = () =>
      this.orchestrator.phases(run.id).find((p) => p.phase === 'script')?.result as
        { provider: Provider['kind']; provenance?: { model?: string | null } } | undefined;
    const scriptProvider = () => scriptResult()?.provider as Provider['kind'];
    return {
      ...this.renderRunners(run),
      script: {
        usesAi: true,
        run: async () => {
          const ai = this.requireAi(projectId);
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
          const call = this.callFor(ai, run.id);
          return {
            kind: 'done',
            payload: await ai.generateStoryboard(brief.prompt, options, call),
            provider: ai.kind,
            model: call.model ?? null
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
              kind,
              scriptResult()?.provenance?.model
            )
          );
          return { kind: 'done', payload: { storyboard, registryVersion }, provider: 'rules' };
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
              label: assetName(a)
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
    kind: string = this.providerFor(projectId).kind ?? 'none',
    // Corrections and re-renders keep the soundtrack; a new prompt starts silent.
    audio: VideoRevision['audio'] = null,
    // Same rule for captions: children keep the source track; a new prompt has none.
    captions: VideoRevision['captions'] = null,
    // Revision settings beyond origin/provider; children carry the parent's caption delivery.
    config: Record<string, string> = {}
  ) {
    const now = Date.now();
    const parent = parentRevisionId ? this.repo.getRevision(parentRevisionId) : null;
    // Scenes moved, resized or re-narrated get fresh fallback words: no silent stale captions.
    const refreshed = parent
      ? refreshCaptions(parent.storyboard, storyboard, captions, storyboard)
      : { captions, warnings: [] };
    for (const warning of refreshed.warnings) this.say(projectId, 'system', warning);
    const delivery = parent?.resolvedConfig.captionDelivery;
    return this.repo.createRevision({
      id: newId('rev'),
      projectId,
      parentRevisionId,
      storyboard,
      audio,
      captions: refreshed.captions,
      resolvedConfig: {
        ...(typeof delivery === 'string' ? { captionDelivery: delivery } : {}),
        ...config,
        origin,
        aiProvider: kind
      },
      videoPath: null,
      error: null,
      createdAt: now,
      updatedAt: now
    });
  }

  private async render(
    projectId: string,
    revision: Pick<VideoRevision, 'id' | 'storyboard'>,
    autoFix: number,
    /** Renders still allowed by the run's budget, this one included. */
    budget = Infinity
  ): Promise<string> {
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
      return revision.id;
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
    if (technical?.length && autoFix < this.settings.quality.maxAutoFixAttempts && budget > 1) {
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
        source.audio,
        source.captions
      );
      return this.render(projectId, retry, autoFix + 1, budget - 1);
    }
    const failed =
      report?.checks.filter((check) => !check.passed && check.analysisMode !== 'not-performed')
        .length ?? 0;
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
    return revision.id;
  }

  // --- Annotations: saved locally, never sent to the AI and never rendered on their own.

  async addAnnotation(input: {
    revisionId: string;
    frameIndex?: number | null;
    timestampMs?: number | null;
    rangeEndMs?: number | null;
    audioTrackId?: string | null;
    captionCueId?: string | null;
    text: string;
    author: string;
  }) {
    const revision = this.repo.getRevision(input.revisionId);
    const text = input.text.trim();
    if (!text) throw new Error('Commentaire vide');
    const max = this.settings.app.review.maxCommentLength;
    if (text.length > max) throw new Error(`Commentaire limité à ${max} caractères`);
    const media = revision.media;
    // Frame indices are only exact at a constant frame rate (VFR refused).
    assertConstantFrameRate(media);
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
    if (input.captionCueId && !revision.captions?.cues.some((c) => c.id === input.captionCueId))
      throw new Error('Sous-titre introuvable dans cette révision');
    const now = Date.now();
    const row = this.repo.createFeedback({
      id: newId('fdb'),
      projectId: revision.projectId,
      revisionId: revision.id,
      timestampMs,
      rangeEndMs: input.rangeEndMs ?? null,
      audioTrackId: input.audioTrackId ?? null,
      captionCueId: input.captionCueId ?? null,
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
    const ids = [...new Set(input.feedbackIds)];
    if (!ids.length) throw new Error('Aucun commentaire sélectionné');
    if (ids.length > this.settings.app.review.maxBatchSize)
      throw new Error(`Lot limité à ${this.settings.app.review.maxBatchSize} commentaires`);
    const revision = this.repo.getRevision(input.revisionId);
    const ai = this.requireAi(revision.projectId);
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
    let ai: Provider | null;
    try {
      ai = this.aiFor(revision.projectId);
    } catch (error) {
      fail(error);
      return Promise.resolve();
    }
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
    // Outside any run: the envelope of the run that produced the source revision pays.
    let call: ReturnType<Studio['callFor']>;
    try {
      call = this.callFor(ai, this.runOf(revision));
    } catch (error) {
      fail(error);
      return Promise.resolve();
    }
    this.busy(revision.projectId, 'planning');
    this.repo.updateBatch(batchId, { status: 'submitted' });
    this.markItems(batch, 'submitted');
    this.say(revision.projectId, 'system', 'Analyse du lot en cours…');
    return ai
      .planRevision(revision.storyboard, inputs, revision.audio, call)
      .then((proposal) => {
        this.savePlan(batchId, proposal, ai.kind, call.model);
      })
      .catch(fail)
      .finally(() => this.activity.delete(revision.projectId));
  }

  private savePlan(
    batchId: string,
    proposal: RevisionProposal,
    kind: Provider['kind'],
    model?: string
  ) {
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
        kind,
        model
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
    payload: RevisionPlan | AudioComposition | RevisionEdit,
    provider: Provider['kind'] | 'rules'
  ) {
    const edit = 'edit' in payload ? payload : null;
    const manual = 'tracks' in payload || Boolean(edit);
    const routing = planRevisionPhases(
      'edit' in payload
        ? {
            changes: [],
            audioChanges:
              JSON.stringify(payload.audio) === JSON.stringify(source.audio) ? [] : [payload.audio]
          }
        : 'tracks' in payload
          ? { changes: [], audioChanges: [payload] }
          : payload,
      this.productionBudget(),
      source.audio
    );
    if (edit) routing.warnings.push(...edit.warnings);
    const plan: ProductionPlan = {
      ...routing.plan,
      ...(edit ? { reason: editReasons[edit.edit] } : {}),
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
          warnings: routing.warnings,
          validation: routing.warnings.length ? 'needs-human' : 'valid',
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
    const payload = this.phasePayload<RevisionPlan | AudioComposition | RevisionEdit>(
      run.id,
      'plan'
    );
    const edit = 'edit' in payload ? payload : null;
    const manual = 'tracks' in payload || Boolean(edit);
    const plan = manual ? null : (payload as RevisionPlan);
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
            ),
            registryVersion
          }
        })
      },
      audio: {
        run: async () => ({
          kind: 'done',
          provider: 'rules',
          payload: edit
            ? edit.audio
            : manual
              ? payload
              : this.patchedAudio(source.audio, plan!.audioChanges)
        })
      },
      composition: {
        run: async (inputs) => {
          const child = this.repo.transaction(() => {
            const revision = this.newRevision(
              source.projectId,
              edit?.storyboard ??
                (inputs.motion as { storyboard: VideoRevision['storyboard'] } | undefined)
                  ?.storyboard ??
                source.storyboard,
              source.id,
              {
                ...(plan
                  ? batch
                    ? { planId: plan.id, batchId: batch.id }
                    : { planId: plan.id }
                  : edit
                    ? { edit: edit.edit }
                    : { audioRevision: 'manual' }),
                runId: run.id
              },
              batch?.provider ?? String(source.resolvedConfig.aiProvider ?? 'none'),
              edit ? edit.audio : ((inputs.audio as AudioComposition) ?? source.audio),
              edit ? edit.captions : source.captions,
              edit?.config
            );
            if (batch)
              this.repo.updateBatch(batch.id, { status: 'applied', resultRevisionId: revision.id });
            return revision;
          });
          // Anchors that no longer resolve are reported before the render, not only after it.
          const events = visualTimeline(child.storyboard, {
            num: Math.round(child.storyboard.fps),
            den: 1
          });
          const warnings = (child.audio?.tracks ?? []).flatMap((track) => {
            const resolved = resolveAnchor(track.anchor, events);
            return 'error' in resolved ? [`Piste ${track.label} : ${resolved.error.message}`] : [];
          });
          return {
            kind: 'done',
            payload: { revisionId: child.id },
            revisionId: child.id,
            provider: 'engine',
            warnings,
            validation: warnings.length ? 'needs-human' : 'valid'
          };
        }
      }
    };
  }

  private finishApproval(revisionId: string, payload: Record<string, string>) {
    const revision = this.repo.getRevision(revisionId);
    for (const run of this.repo.listRuns(revision.projectId)) {
      // A stopped run keeps the decision: resuming it then completes the run.
      if (run.revisionId !== revisionId || (run.status !== 'waiting' && run.status !== 'stopped'))
        continue;
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
      this.orchestrator
        .drive(run.id, {})
        .catch((error: unknown) =>
          this.say(revision.projectId, 'system', `Échec de la production : ${message(error)}`)
        );
    }
  }

  stopProduction(runId: string) {
    this.orchestrator.stop(runId);
    this.controllers.get(runId)?.abort();
    this.controllers.delete(runId);
  }

  /**
   * Director of a tool loop run on this run (T129b-1): the project's effective provider,
   * never another one. Each decision counts in maxAiCalls and, when billable, is reserved
   * on the run's envelope before the request (callFor, D022); « Arrêter » aborts it.
   */
  directorSource(runId: string, goal: string): StepSource {
    const run = this.repo.getRun(runId);
    const ai = this.aiFor(run.projectId);
    const capability = ai ? providerCapabilities[ai.kind] : null;
    if (!ai || ai.mode !== 'direct' || !capability?.director || !ai.decideStep)
      throw new Error(
        `Director indisponible pour ${ai?.kind ?? 'aucun fournisseur'}${capability ? ` : ${capability.directorNote}` : ''}`
      );
    const decide = ai.decideStep.bind(ai);
    const left = () => {
      const current = this.repo.getRun(runId);
      return current.plan.budget.maxAiCalls - current.aiCalls;
    };
    return directorStepSource({
      goal,
      aiCallsLeft: left,
      project: () => {
        const current = this.repo.getRun(runId);
        const id = current.revisionId ?? current.sourceRevisionId;
        if (!id) return { revisionId: null, summary: null };
        const revision = this.repo.getRevision(id);
        return {
          revisionId: id,
          summary: {
            status: revision.status,
            durationMs: endOf(revision),
            scenes: revision.storyboard.scenes.map((scene) => ({
              id: scene.id,
              start: scene.start,
              duration: scene.duration,
              text: scene.text,
              animation: scene.animation,
              component: scene.component?.id ?? null,
              narration: Boolean(scene.narration)
            })),
            tracks: (revision.audio?.tracks ?? []).map((t) => ({
              id: t.id,
              label: t.label,
              category: t.category,
              gainDb: t.gainDb
            })),
            captions: Boolean(revision.captions)
          }
        };
      },
      decide: async (view, signal) => {
        if (left() <= 0)
          throw new LoopBudgetError(
            `Budget d'appels IA épuisé (${this.repo.getRun(runId).plan.budget.maxAiCalls})`
          );
        this.repo.updateRun(runId, { aiCalls: this.repo.getRun(runId).aiCalls + 1 });
        // Throws BudgetExceededError before any request when the envelope cannot pay.
        const call = this.callFor(ai, runId);
        const signals = [call.signal, signal].filter((s): s is AbortSignal => Boolean(s));
        return decide(view, {
          ...call,
          ...(signals.length ? { signal: AbortSignal.any(signals) } : {})
        });
      }
    });
  }

  // --- Director in the Studio (T129b-2): an edit request in the chat drives a tool loop.

  private registries = new Map<string, ToolRegistry>();
  /** One registry per project (it tracks calls still running), with the render engine. */
  private toolRegistry(projectId: string) {
    let registry = this.registries.get(projectId);
    if (!registry) {
      registry = studioToolRegistry({
        repo: this.repo,
        storage: this.storage,
        settings: this.settings,
        engine: this.runner.engine,
        studio: this,
        projectId
      });
      this.registries.set(projectId, registry);
    }
    return registry;
  }

  private startDirector(source: RevisionRow, text: string, budgetUsd: number) {
    const { projectId } = source;
    if (
      this.repo.listRuns(projectId).some(
        (r) =>
          isDirectorRun(r) &&
          (r.status === 'running' || r.status === 'waiting') &&
          // Waiting only for the human approval of its result does not block a new request.
          this.orchestrator.phases(r.id).find((p) => p.phase === 'plan')?.status !== 'done'
      )
    )
      throw new Error(
        'Un montage du Director est déjà en cours : répondez-lui, ou arrêtez-le, avant une nouvelle demande'
      );
    const ai = this.requireAi(projectId);
    this.busy(projectId, 'generating');
    this.say(projectId, 'user', text);
    const run = this.orchestrator.create({
      projectId,
      kind: 'revision',
      brief: this.productionBrief(projectId, text),
      plan: planDirectorRevision({
        maxAiCalls: DIRECTOR_AI_CALLS,
        maxRenders: this.productionBudget().maxRenders
      }),
      sourceRevisionId: source.id
    });
    if (budgetUsd > 0) this.repo.raiseBudget(run.id, usdToMicroUsd(budgetUsd));
    const version = this.repo.listRevisions(projectId).findIndex((r) => r.id === source.id) + 1;
    this.say(
      projectId,
      'assistant',
      this.label(
        `Demande de montage confiée au Director (révision v${version}). Ses décisions et les outils exécutés s'affichent dans le panneau Production ; rendu, contrôle qualité et votre validation restent des étapes fixes.`,
        ai.kind,
        isBillable(ai) ? ai.model : null
      )
    );
    return this.background(projectId, async () => {
      await this.orchestrator.drive(run.id, this.directorRunners(run));
    });
  }

  private loopPhase(runId: string) {
    const run = this.repo.getRun(runId);
    const phase = this.orchestrator.phases(runId).find((p) => p.phase === 'plan');
    if (!isDirectorRun(run) || !phase) throw new Error('Production sans Director');
    return { run, phase };
  }

  /** Revisions produced by the run's tool loop (child of revision.apply, audio.track.update). */
  private loopRevisions(runId: string) {
    const phase = this.orchestrator.phases(runId).find((p) => p.phase === 'plan');
    if (!phase) return [];
    return this.repo.loopSteps(phase.id).flatMap((r) => {
      const id =
        r.status === 'done' && r.result?.ok
          ? (r.result.output as { revisionId?: unknown })?.revisionId
          : null;
      return typeof id === 'string' ? [id] : [];
    });
  }

  /**
   * A rendered child ready for approval supersedes its parent, as an applied correction
   * plan does: the parent goes `changes_requested` and its own approval phase completes.
   */
  private supersede(parentId: string, childId: string) {
    if (parentId === childId) return;
    if (this.repo.getRevision(childId).status !== 'awaiting_approval') return;
    if (this.repo.getRevision(parentId).status !== 'awaiting_approval') return;
    this.repo.transitionRevision(parentId, 'changes_requested');
    this.finishApproval(parentId, { decision: 'changes_requested' });
  }

  private directorRunners(run: ProductionRun): Runners {
    const { projectId } = run;
    const base = this.renderRunners(run);
    return {
      ...base,
      plan: {
        run: async (inputs) => {
          // Built at each drive: the project's provider now, never another (no fallback).
          const source = this.directorSource(run.id, run.brief!.prompt);
          const ai = this.aiFor(projectId)!;
          const outcome = await toolLoopRunner({
            repo: this.repo,
            registry: this.toolRegistry(projectId),
            source,
            runId: run.id,
            grants: directorGrants(run.plan),
            signal: this.signalFor(run.id),
            provider: ai.kind
          }).run(inputs);
          if (outcome.kind === 'waiting') {
            const phase = this.loopPhase(run.id).phase;
            const pending = this.repo
              .loopSteps(phase.id)
              .find((r) => r.status === 'awaiting-permission');
            const request = (pending?.request ?? {}) as { question?: string; toolId?: string };
            this.say(
              projectId,
              'assistant',
              this.label(
                pending?.action === 'ask_user'
                  ? `Question du Director : ${clip(request.question, 500)}`
                  : `Le Director demande votre autorisation pour ${request.toolId ?? 'une action'} (panneau Production).`,
                ai.kind,
                isBillable(ai) ? ai.model : null
              )
            );
          }
          return outcome;
        }
      },
      render: {
        run: async (inputs) => {
          const produced =
            (inputs.plan as { revisionId?: string | null } | null)?.revisionId ??
            run.sourceRevisionId!;
          const current = this.repo.getRevision(this.repo.getRun(run.id).revisionId ?? produced);
          // Already rendered (unchanged source, or audio.track.update's own run): reused.
          if (
            current.videoPath &&
            ['awaiting_approval', 'changes_requested', 'approved'].includes(current.status)
          ) {
            this.repo.updateRun(run.id, { revisionId: current.id });
            this.supersede(run.sourceRevisionId!, current.id);
            return {
              kind: 'done',
              payload: { revisionId: current.id, status: 'reused' },
              revisionId: current.id,
              provider: 'engine'
            };
          }
          const outcome = await base.render!.run({ composition: { revisionId: produced } });
          if (outcome.kind === 'done' && outcome.revisionId)
            this.supersede(run.sourceRevisionId!, outcome.revisionId);
          return outcome;
        }
      }
    };
  }

  /** Human decision on a call the Director paused on; the loop then continues. */
  decideDirector(runId: string, stepId: string, granted: boolean) {
    const { run, phase } = this.loopPhase(runId);
    decidePermission(this.repo, phase.id, stepId, granted);
    this.say(
      run.projectId,
      'system',
      granted ? 'Action autorisée par l’utilisateur.' : 'Action refusée par l’utilisateur.'
    );
    return this.wakeDirector(run);
  }

  /** The user's answer to the Director's question (it grants nothing); the loop continues. */
  answerDirector(runId: string, stepId: string, text: string) {
    const { run, phase } = this.loopPhase(runId);
    answerQuestion(this.repo, phase.id, stepId, text);
    this.say(run.projectId, 'user', text.trim().slice(0, 2000));
    return this.wakeDirector(run);
  }

  private wakeDirector(run: ProductionRun) {
    // A stopped run keeps the decision; « Reprendre » continues from it.
    if (this.repo.getRun(run.id).status === 'stopped') return Promise.resolve();
    this.busy(run.projectId, 'generating');
    let work: Promise<unknown>;
    try {
      work = this.orchestrator.wake(run.id, 'plan', this.directorRunners(run));
    } catch (error) {
      this.activity.delete(run.projectId);
      throw error;
    }
    return this.background(run.projectId, async () => {
      await work;
    });
  }

  resumeProduction(runId: string) {
    const run = this.repo.getRun(runId);
    const runners =
      run.kind === 'production'
        ? this.productionRunners(run)
        : isDirectorRun(run)
          ? this.directorRunners(run)
          : this.revisionRunners(run);
    let assisted = false;
    try {
      assisted = this.aiFor(run.projectId)?.mode === 'assisted';
    } catch {
      // Unavailable provider: the run fails at its next AI phase with the reason.
    }
    if (!assisted) this.busy(run.projectId, 'generating');
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
      `Demande ${kind === 'plan' ? 'de plan de correction' : kind === 'evaluation' ? "d'expertise QA" : 'de storyboard'} exportée. Veyra n'appelle pas Claude : dans Claude Code (connecté à votre abonnement), à la racine du dépôt Veyra, lancez « /veyra-assisted-task ${dir} », le résultat est importé automatiquement dès que Claude Code l'a écrit (« Importer le résultat » reste disponible en repli).`,
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
      const text = readResult(task.dir);
      try {
        raw = JSON.parse(text);
      } catch {
        // JSON.parse quotes the file in its message: never surface raw content.
        throw new Error('JSON invalide');
      }
    } catch (error) {
      const text = `Résultat illisible : ${message(error)}`;
      this.repo.updateTask(taskId, { error: text });
      throw new Error(text, { cause: error });
    }
    // The effect and the 'imported' status commit together: a failure leaves the task importable.
    const commit = <T>(effect: () => T) =>
      this.repo.transaction(() => {
        const result = effect();
        this.repo.updateTask(taskId, { status: 'imported', error: null });
        return result;
      });
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
      return commit(() =>
        this.completeEvaluation(
          evaluationId,
          clean,
          clean.imagesExamined.length ? 'multimodal' : 'text-only'
        )
      );
    }
    if (task.kind === 'plan') {
      let proposal: RevisionProposal;
      try {
        proposal = assisted.parseResult('plan', raw);
      } catch (error) {
        this.repo.updateTask(taskId, { error: `Résultat non conforme : ${message(error)}` });
        throw new Error('Résultat non conforme au schéma attendu', { cause: error });
      }
      return commit(() => this.savePlan(task.batchId!, proposal, 'claude-subscribe'));
    }
    let draft: StoryboardDraft;
    try {
      draft = assisted.parseResult('storyboard', raw);
    } catch (error) {
      this.repo.updateTask(taskId, { error: `Résultat non conforme : ${message(error)}` });
      throw new Error('Résultat non conforme au schéma attendu', { cause: error });
    }
    const input = task.input as { prompt: string; parentRevisionId: string | null; runId?: string };
    // Ids come from a row the export wrote; still check they belong to this project.
    const owner = (read: () => { projectId: string }) => {
      try {
        return read().projectId;
      } catch {
        return null;
      }
    };
    if (
      (input.runId && owner(() => this.repo.getRun(input.runId!)) !== task.projectId) ||
      (input.parentRevisionId &&
        owner(() => this.repo.getRevision(input.parentRevisionId!)) !== task.projectId)
    ) {
      const text = 'Tâche refusée : production ou révision étrangère au projet';
      this.repo.updateTask(taskId, { error: text });
      throw new Error(text);
    }
    this.busy(task.projectId, 'generating');
    let run: ProductionRun;
    try {
      run = commit(() => this.acceptStoryboard(task.projectId, input, draft));
    } catch (error) {
      // A refused import releases the project and leaves the task importable.
      this.activity.delete(task.projectId);
      throw error;
    }
    // complete() respects a voluntary stop: the script is kept, nothing restarts.
    if (run.status === 'stopped')
      this.say(
        task.projectId,
        'system',
        'Storyboard importé ; la production est arrêtée : cliquez sur « Reprendre » pour la poursuivre.'
      );
    return this.background(task.projectId, async () => {
      await this.orchestrator.drive(run.id, this.productionRunners(run));
    });
  }

  private watched = new Map<string, { version: string; failed?: string }>();
  /**
   * One pass of the assisted-mode watcher: each result.json whose size and mtime held
   * still since the previous pass goes through importTask, once per file version.
   */
  watchAssistedTasks() {
    const awaiting = this.repo.listAwaitingTasks();
    for (const id of this.watched.keys())
      if (!awaiting.some((t) => t.id === id)) this.watched.delete(id);
    for (const task of awaiting) {
      let version: string;
      try {
        const info = lstatSync(join(task.dir, 'result.json'));
        version = `${info.size}:${info.mtimeMs}`;
      } catch {
        this.watched.delete(task.id);
        continue;
      }
      const seen = this.watched.get(task.id);
      this.watched.set(task.id, { version, failed: seen?.failed });
      if (seen?.version !== version || seen.failed === version) continue;
      // Busy project: retry on a later pass, the file version is not marked failed.
      if (this.activity.has(task.projectId)) continue;
      try {
        void this.importTask(task.id);
      } catch (error) {
        this.watched.set(task.id, { version, failed: version });
        try {
          this.say(task.projectId, 'system', `Import automatique impossible : ${message(error)}`);
        } catch {
          // The task row keeps its error; a missing conversation must not stop the watcher.
        }
      }
    }
  }

  private acceptStoryboard(
    projectId: string,
    input: { prompt: string; parentRevisionId: string | null; runId?: string },
    draft: StoryboardDraft
  ): ProductionRun {
    if (input.runId) {
      this.orchestrator.complete(input.runId, 'script', {
        kind: 'done',
        payload: draft,
        provider: 'claude-subscribe'
      });
      return this.repo.getRun(input.runId);
    }
    // Legacy exports carry no run: create one with the imported script.
    const brief = this.productionBrief(projectId, input.prompt);
    const plan = planProduction(brief, this.productionBudget());
    return this.orchestrator.create({
      projectId,
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

  // --- QA review: qualitative review by the provider, plus comparative correction checks.

  async review(revision: RevisionRow, videoPath: string): Promise<ReviewFinding[]> {
    const findings: ReviewFinding[] = [];
    // An unavailable project provider is reported as an unperformed review, never replaced.
    let ai: Provider | null = null;
    let unavailable: unknown = null;
    try {
      ai = this.aiFor(revision.projectId);
    } catch (error) {
      unavailable = error;
    }
    if (unavailable || ai?.mode === 'direct') {
      // The AI review is optional: a refused or failed call never loses the render (T145).
      try {
        if (ai?.mode !== 'direct') throw unavailable;
        const call = this.callFor(ai, this.runOf(revision));
        // Frames at each scene's midpoint: what the qualitative reviewer actually receives.
        const times = revision.storyboard.scenes.map((s) => Math.round(s.start + s.duration / 2));
        const frames = (await extractFrames(videoPath, times)).map((path, index) => ({
          path,
          timestampMs: times[index]
        }));
        findings.push(...(await ai.reviewFrames(revision.storyboard, frames, call)));
      } catch (error) {
        findings.push({
          name: 'Revue qualitative',
          passed: false,
          severity: 'info',
          timestampMs: 0,
          sceneId: null,
          evidence: `Revue IA non effectuée : ${message(error)}`,
          recommendation: 'Vérifier visuellement le rendu avant validation.',
          analysisMode: 'not-performed'
        });
      }
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
      const audioChanges = plan.audioChanges.filter((c) => c.feedbackId === feedbackId);
      if (audioChanges.length) {
        const audioVerdict = await this.verifyAudioChanges(
          parent,
          revision,
          videoPath,
          audioChanges
        );
        if (!changes.length) {
          verdict = audioVerdict.verdict;
          evidence = audioVerdict.evidence;
        } else {
          evidence += ' ' + audioVerdict.evidence;
          if (verdict !== audioVerdict.verdict)
            verdict =
              verdict === 'unverifiable' || audioVerdict.verdict === 'unverifiable'
                ? 'unverifiable'
                : 'partially_applied';
        }
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
          verdict === 'applied'
            ? 'Aucune action'
            : 'Vérifier l’image et le son, puis reformuler si besoin',
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

  private async verifyAudioChanges(
    parent: RevisionRow,
    revision: RevisionRow,
    videoPath: string,
    changes: RevisionPlan['audioChanges']
  ) {
    try {
      if (!parent.videoPath) throw new Error('rendu précédent absent');
      const notes: string[] = [];
      const outcomes: boolean[] = [];
      for (const change of changes) {
        const old = parent.audio?.tracks.find((t) => t.id === change.trackId);
        if (!old) throw new Error('piste source absente');
        const ranges = (change.patch.duck ?? [])
          .filter(
            (d) =>
              d.gainDb < 0 &&
              !old.duck.some(
                (o) => o.startMs === d.startMs && o.endMs === d.endMs && o.gainDb <= d.gainDb
              )
          )
          .map((d) => ({ startMs: d.startMs, endMs: d.endMs }));
        if (change.patch.gainDb != null && change.patch.gainDb < old.gainDb)
          ranges.push({ startMs: 0, endMs: Math.min(endOf(parent), endOf(revision)) });
        if (!ranges.length)
          throw new Error('modification audio non mesurable par une baisse de niveau');
        for (const range of ranges) {
          const [before, after] = await Promise.all([
            meanVolumeDb(parent.videoPath, range.startMs, range.endMs),
            meanVolumeDb(videoPath, range.startMs, range.endMs)
          ]);
          const decrease = before - after;
          outcomes.push(decrease >= 3);
          notes.push(
            `Mesuré sur le mix, ${range.startMs}–${range.endMs} ms : ${before} → ${after} dB ; baisse ${decrease.toFixed(1)} dB (seuil 3 dB).`
          );
        }
      }
      return {
        verdict: outcomes.every(Boolean) ? ('applied' as const) : ('not_applied' as const),
        evidence: notes.join(' ')
      };
    } catch (error) {
      return {
        verdict: 'unverifiable' as const,
        evidence: `Comparaison audio impossible : ${message(error)}.`
      };
    }
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
    const { error: unavailable } = this.providerFor(revision.projectId);
    const ai = unavailable ? null : this.aiFor(revision.projectId);
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
    if (!ai)
      return this.endEvaluation(
        row.id,
        'unavailable',
        unavailable ?? 'Aucun fournisseur IA configuré.'
      );
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
      // Outside the run's phases: the envelope of the run that produced the revision pays.
      const call = this.callFor(ai, this.runOf(revision));
      const { review, analysisMode } = await ai.qualityEvaluator(call).evaluate(pack);
      return this.completeEvaluation(
        row.id,
        sanitizeReview(review, pack),
        analysisMode,
        call.model
      );
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

  private completeEvaluation(
    id: string,
    review: ExpertReview,
    mode: EvaluationMode,
    model?: string
  ) {
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
        row.evaluator ?? undefined,
        model
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
      audio: {
        present: Boolean(revision.audio?.tracks.length),
        listened: false,
        feedbackIds: plan.audioChanges.flatMap((c) => (c.feedbackId ? [c.feedbackId] : [])),
        measurements: (report?.checks ?? [])
          .filter(
            (c) =>
              c.analysisMode === 'deterministic' && /audio|sonore|silence|écrêtage/i.test(c.name)
          )
          .map((c) => `mesuré — ${c.name} : ${c.evidence}`)
      },
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

  // --- Voice and captions (T115). Every edit is a child revision; the source is never changed.

  private editable(revisionId: string, sceneId?: string) {
    const source = this.repo.getRevision(revisionId);
    if (source.status !== 'awaiting_approval')
      throw new Error('Seule une révision en attente de validation peut être modifiée');
    const index = sceneId ? source.storyboard.scenes.findIndex((s) => s.id === sceneId) : -1;
    if (sceneId && index < 0) throw new Error('Scène introuvable');
    return { source, index };
  }

  private startEdit(source: RevisionRow, edit: RevisionEdit, text: string) {
    this.busy(source.projectId, 'generating');
    const run = this.repo.transaction(() => {
      this.repo.transitionRevision(source.id, 'changes_requested');
      return this.createRevisionRun(source, edit, 'rules');
    });
    this.finishApproval(source.id, { decision: 'changes_requested' });
    this.say(
      source.projectId,
      'assistant',
      [text, ...edit.warnings.map((w) => `Attention : ${w}`)].join('\n')
    );
    return this.background(source.projectId, async () => {
      await this.orchestrator.drive(run.id, this.revisionRunners(run));
    });
  }

  /** Captions of `board` with the given scenes rebuilt from their narration (fallback "scene"). */
  private sceneCaptions(source: RevisionRow, board: Storyboard, sceneIds: string[]) {
    if (!source.captions) {
      const track = buildFallbackCaptions(board, board);
      return { captions: track.words.length ? track : null, warnings: [] };
    }
    return rebuildCaptionScenes(
      source.storyboard,
      board,
      source.captions,
      board,
      new Set(sceneIds)
    );
  }

  /**
   * Narration of one scene (null removes it). The picture does not use the narration;
   * it changes only through burned captions (T114 delivery).
   */
  setNarration(revisionId: string, sceneId: string, text: string | null) {
    const { source, index } = this.editable(revisionId, sceneId);
    const scenes = source.storyboard.scenes.map((scene) => {
      if (scene.id !== sceneId) return scene;
      const { narration, ...rest } = scene;
      return text?.trim() ? { ...rest, narration: { ...narration, text: text.trim() } } : rest;
    });
    const storyboard = storyboardSchema.parse({ ...source.storyboard, scenes });
    const captions = this.sceneCaptions(source, storyboard, [sceneId]);
    const voiced = source.audio?.tracks.some(
      (t) => t.category === 'voiceover' && t.anchor.type === 'event' && t.anchor.sceneId === sceneId
    );
    return this.startEdit(
      source,
      {
        edit: 'narration',
        storyboard,
        audio: source.audio,
        captions: captions.captions,
        config: {},
        warnings: [
          ...captions.warnings,
          ...(voiced
            ? [`La voix de la scène ${index + 1} correspond encore à l'ancien texte.`]
            : [])
        ]
      },
      `Narration de la scène ${index + 1} ${text?.trim() ? 'mise à jour' : 'supprimée'} : nouvelle révision. Sous-titres de la scène reconstruits (temps approximatifs, répartis dans la scène).`
    );
  }

  private placeVoice(
    source: RevisionRow,
    index: number,
    voice: { assetId: string; durationMs: number; label: string },
    text: string
  ) {
    const scene = source.storyboard.scenes[index];
    const placed = placeSceneVoice(source.audio, scene, voice, endOf(source));
    // shortcut: no aligner yet (T119), so the scene's captions are rebuilt with "scene" times.
    const captions = this.sceneCaptions(source, source.storyboard, [scene.id]);
    return this.startEdit(
      source,
      {
        edit: 'voice',
        storyboard: source.storyboard,
        audio: placed.composition,
        captions: captions.captions,
        config: {},
        warnings: [...placed.warnings, ...captions.warnings]
      },
      `${text} Sous-titres de la scène : temps approximatifs (répartis dans la scène, aucun alignement installé).`
    );
  }

  /** Recorded voice for one scene: validated like any imported audio, original kept. */
  async importVoice(revisionId: string, sceneId: string, file: File, data: Uint8Array) {
    const { source, index } = this.editable(revisionId, sceneId);
    const asset = await this.importAudio(source.projectId, file, data, 'voiceover');
    if (asset.audio?.status !== 'valid')
      throw new Error(`Voix refusée : ${asset.audio?.error ?? 'fichier invalide'}`);
    const result = importedVoiceResult(
      sceneId,
      asset.id,
      asset.audio.metadata as { durationMs: number }
    );
    return this.placeVoice(
      source,
      index,
      { assetId: asset.id, durationMs: result.durationMs, label: `Voix scène ${index + 1}` },
      `Voix importée pour la scène ${index + 1} : nouvelle révision, storyboard inchangé.`
    );
  }

  /** Generated voice; an unavailable provider is an explicit error, never a simulated voice. */
  async generateVoice(revisionId: string, sceneId: string, kind: 'fake' | 'local-tts') {
    const { source, index } = this.editable(revisionId, sceneId);
    const provider = voiceProvider(kind);
    const status = provider.available();
    if (!status.ok)
      throw new Error(
        `Voix « ${kind} » indisponible : ${status.reason ?? 'inconnue'}${status.installHint ? ` — ${status.installHint}` : ''}`
      );
    const text = source.storyboard.scenes[index].narration?.text;
    if (!text) throw new Error(`La scène ${index + 1} n'a pas de narration`);
    const dir = mkdtempSync(join(tmpdir(), 'veyra-voice-'));
    try {
      const out = join(dir, 'voice.wav');
      const synthesis = await provider.synthesize!({ sceneId, text }, out, this.audioLimits());
      const simulated = synthesis.simulated ? '[Simulé] ' : '';
      const bytes = new Uint8Array(readFileSync(out));
      const name = `voix-${kind}-scene-${index + 1}.wav`;
      const asset = await this.importAudio(
        source.projectId,
        new File([bytes], name, { type: 'audio/wav' }),
        bytes,
        'voiceover'
      );
      if (asset.audio?.status !== 'valid')
        throw new Error(`Voix générée refusée : ${asset.audio?.error ?? 'fichier invalide'}`);
      voiceResultSchema.parse({ ...synthesis, assetId: asset.id });
      return await this.placeVoice(
        source,
        index,
        {
          assetId: asset.id,
          durationMs: synthesis.durationMs,
          label: `${simulated}Voix scène ${index + 1}`
        },
        `${simulated}Voix ${synthesis.simulated ? 'simulée (tonalité de test, pas une vraie voix)' : 'générée'} pour la scène ${index + 1} : nouvelle révision, storyboard inchangé.`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Burned, clean or both: stored in the child revision's resolvedConfig.captionDelivery. */
  setCaptionDelivery(revisionId: string, mode: (typeof captionDeliveries)[number]) {
    if (!captionDeliveries.includes(mode)) throw new Error('Livraison des sous-titres inconnue');
    const { source } = this.editable(revisionId);
    const labels = { burned: 'incrustés', clean: 'vidéo propre + SRT/VTT', both: 'les deux' };
    return this.startEdit(
      source,
      {
        edit: 'caption-delivery',
        storyboard: source.storyboard,
        audio: source.audio,
        captions: source.captions,
        config: { captionDelivery: mode },
        warnings: []
      },
      `Livraison des sous-titres : ${labels[mode]}. Nouvelle révision.`
    );
  }

  /** Everything the Studio page needs, in one read. */
  snapshot(projectId: string) {
    const project = this.repo.getProject(projectId);
    if (!project) return null;
    const revisions = this.repo.listRevisions(projectId);
    const ids = revisions.map((r) => r.id);
    const runs = this.repo.listRuns(projectId);
    const conversation = this.repo.conversationFor(projectId);
    const jobs = this.repo.renderJobsFor(ids).map((job) => {
      const audio = job.resolvedConfig.audio as
        | {
            tracks?: { trackId: string; startMs: number; playMs: number }[];
            issues?: { trackId: string; code: string; message: string }[];
          }
        | undefined;
      return {
        ...job,
        resolvedConfig: {
          ...job.resolvedConfig,
          ...(audio
            ? {
                audio: {
                  tracks: (audio.tracks ?? []).map((t) => ({
                    trackId: t.trackId,
                    startMs: t.startMs,
                    endMs: t.startMs + t.playMs
                  })),
                  issues: audio.issues ?? []
                }
              }
            : {})
        }
      };
    });
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
      jobs,
      audioMaxFileBytes: this.settings.audio.maxFileBytes,
      visualEvents: revisions.map((r) => ({
        revisionId: r.id,
        events: visualTimeline(r.storyboard, {
          num: r.media?.fpsNum ?? Math.round(r.storyboard.fps),
          den: r.media?.fpsDen ?? 1
        })
      })),
      reports: this.repo.reportsFor(ids),
      plans: this.repo.plansFor(ids),
      // Each evaluation with the evidence it was given (no local paths).
      evaluations: this.repo.evaluationsFor(ids).map((evaluation) => ({
        ...evaluation,
        provided: this.providedEvidence(evaluation)
      })),
      assets: this.repo.listAssets(projectId).map((asset) => ({
        id: asset.id,
        mediaType: asset.mediaType,
        audio: asset.audio,
        name: assetName(asset)
      })),
      director: this.directorHistory(projectId, runs),
      activity: this.activityFor(projectId)
    };
  }

  /**
   * Steps of each Director run, bounded for display: the model's decisions (origin
   * `source`) apart from the loop's own forced stops (`engine`). Tool outputs, questions
   * and justifications are untrusted text, shown escaped and cut.
   */
  private directorHistory(projectId: string, runs: ProductionRun[]) {
    const current = this.providerFor(projectId).kind;
    return runs.filter(isDirectorRun).map((run) => {
      const phase = this.orchestrator.phases(run.id).find((p) => p.phase === 'plan');
      const registry = this.toolRegistry(projectId);
      return {
        runId: run.id,
        goal: clip(run.brief?.prompt ?? '', 500),
        provider: String(
          (phase?.result as { provider?: string } | null)?.provider ?? current ?? 'aucun'
        ),
        steps: (phase ? this.repo.loopSteps(phase.id) : []).map((r) => {
          const q = (r.request ?? {}) as Record<string, unknown>;
          const toolId = r.invocation?.toolId ?? (typeof q.toolId === 'string' ? q.toolId : null);
          const meta = toolId ? registry.meta(toolId) : undefined;
          return {
            id: r.id,
            step: r.step,
            origin: r.origin,
            action: r.action,
            status: r.status,
            justification: clip(q.justification ?? q.summary ?? q.reason ?? '', 500),
            toolId,
            permissions: meta?.permissions ?? [],
            cost: meta?.cost.kind ?? null,
            detail: clip(q.input ?? q.plan ?? q.question ?? q.preview ?? q.revisionId ?? '', 600),
            answer: clip((q.answer as { text?: string } | undefined)?.text ?? '', 500) || null,
            output: r.result?.ok ? clip(r.result.output, 600) : null,
            error: r.error ? clip(r.error.message, 400) : null,
            simulated: r.result?.simulated ?? false,
            durationMs: r.durationMs
          };
        })
      };
    });
  }
}

const RESULT_MAX_BYTES = 1024 * 1024;
/** Reads result.json without following links: a regular file of at most 1 MB only. */
function readResult(dir: string) {
  // O_NONBLOCK: opening a FIFO planted in place of the file must not hang the server.
  const fd = openSync(
    safePath(dir, 'result.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!fstatSync(fd).isFile()) throw new Error('result.json n’est pas un fichier régulier');
    // Bounded read: the file may grow after fstat, so the size is never trusted.
    const buffer = Buffer.alloc(RESULT_MAX_BYTES + 1);
    let length = 0;
    let n = -1;
    while (n !== 0 && length < buffer.length) {
      n = readSync(fd, buffer, length, buffer.length - length, null);
      length += n;
    }
    if (length > RESULT_MAX_BYTES) throw new Error('result.json dépasse 1 Mo');
    return buffer.toString('utf8', 0, length);
  } finally {
    closeSync(fd);
  }
}
