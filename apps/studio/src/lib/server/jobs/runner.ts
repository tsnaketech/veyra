import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigLoader, configSchemas } from '@veyra/config';
import { ProjectStorage } from '@veyra/storage';
import {
  HyperFramesEngine,
  compose,
  writeComposition,
  renderResultSchema,
  progressSchema,
  type VideoEngine
} from '@veyra/hyperframes-adapter';
import { deterministicChecks, ProcessError } from '@veyra/video';
import {
  analysisModesFor,
  frameCount,
  newId,
  qualityReportSchema,
  type RenderJob
} from '@veyra/schemas';
import type { ReviewFinding } from '@veyra/ai';
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
  return {
    app: app.value,
    engine: engines.value.hyperframes,
    style: style.value,
    quality: quality.value,
    // VEYRA_PROJECTS_ROOT lets tests isolate their media from the default projects/ folder.
    storageRoot: resolve(
      process.env.VEYRA_PROJECTS_ROOT ?? join(dirname(configDir), app.value.projectsRoot)
    ),
    snapshot: {
      app: app.redacted(),
      engines: engines.redacted(),
      style: style.redacted(),
      quality: quality.redacted()
    }
  };
}
export type RenderSettings = ReturnType<typeof loadRenderSettings>;
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
      this.repo.updateRenderProgress(jobId, 0, 'compose');
      const workspace = this.storage.ensureRevision(revision.projectId, revision.id);
      const files = compose(
        revision.storyboard,
        { width: revision.storyboard.width, height: revision.storyboard.height },
        this.settings.style
      );
      writeComposition(workspace.composition, files);
      const outputPath = this.storage.renderPath(revision.projectId, revision.id, jobId);
      const result = renderResultSchema.parse(
        await this.engine.render(
          workspace.composition,
          {
            revisionDir: workspace.revision,
            outputPath,
            quality: this.settings.engine.quality,
            fps: this.settings.engine.fps
          },
          (raw) => {
            const progress = progressSchema.parse(raw);
            this.repo.updateRenderProgress(
              jobId,
              Math.min(90, Math.round(progress.percent * 0.9)),
              progress.stage
            );
          }
        )
      );
      if (resolve(result.path) !== outputPath || result.engine !== this.engine.kind)
        throw new Error('Engine result does not match job');
      stderrTail = result.stderrTail;
      this.repo.updateRevision(revision.id, { videoPath: result.path });
      this.repo.transitionRevision(revision.id, 'qa');
      this.repo.updateRenderProgress(jobId, 95, 'qa');
      const metadata = await this.engine.inspect(result.path);
      // The measured stream timing is the reference for frame-accurate comments.
      const rate = metadata.frameRate ?? { num: Math.round(this.settings.engine.fps), den: 1 };
      this.repo.updateRevision(revision.id, {
        media: {
          fpsNum: rate.num,
          fpsDen: rate.den,
          durationMs: metadata.durationMs,
          startMs: metadata.startMs ?? 0,
          frameCount: metadata.frameCount ?? frameCount(metadata.durationMs, rate),
          constantFrameRate: metadata.constantFrameRate ?? true
        }
      });
      const durationMs = Math.max(
        ...revision.storyboard.scenes.map((scene) => scene.start + scene.duration)
      );
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
      if (this.engine.kind === 'fake-test-only')
        for (const check of checks) {
          check.analysisMode = 'simulated';
          check.evidence = `FakeEngine test-only: ${check.evidence}`;
        }
      const findings = this.reviewer ? await this.reviewer(revision, result.path) : [];
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
        .filter((finding) => !finding.passed)
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
      this.repo.transitionRenderJob(jobId, 'succeeded', { outputPath: result.path, stderrTail });
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
