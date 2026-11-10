import { z } from 'zod';
import { storyboardDraftSchema } from '@veyra/ai';
import { inputHash } from '@veyra/schemas/hash';
import {
  agentResultSchema,
  audioCompositionSchema,
  captionTrackSchema,
  motionCompositionSchema,
  storyboardSchema,
  newId,
  BudgetExceededError,
  type Phase,
  type ProductionPhase,
  type ProductionPlan,
  type ProductionRun,
  productionPlanSchema,
  reviewPlanSchema
} from '@veyra/schemas';
import type { createRepository } from './db/repo';

type Repository = ReturnType<typeof createRepository>;
type Provider = z.infer<ReturnType<typeof agentResultSchema>>['provider'];

export type PhaseOutcome =
  | {
      kind: 'done';
      payload: unknown;
      provider: Provider;
      revisionId?: string | null;
      warnings?: string[];
      validation?: 'valid' | 'needs-human';
      model?: string | null;
    }
  /** The phase waits for something outside Veyra (assisted import, human decision). */
  | { kind: 'waiting' };
export interface PhaseRunner {
  /** Counts against the run's AI-call budget. */
  usesAi?: boolean;
  run(inputs: Partial<Record<Phase, unknown>>): Promise<PhaseOutcome>;
}
export type Runners = Partial<Record<Phase, PhaseRunner>>;

/** Manual edit of a revision (voice, narration, caption delivery): the plan of its revision run. */
export const revisionEditSchema = z
  .object({
    edit: z.enum(['voice', 'narration', 'caption-delivery']),
    storyboard: storyboardSchema,
    audio: audioCompositionSchema.nullable(),
    captions: captionTrackSchema.nullable(),
    config: z.record(z.string(), z.string()),
    warnings: z.array(z.string())
  })
  .strict();
export type RevisionEdit = z.infer<typeof revisionEditSchema>;

const envelope = agentResultSchema(z.json());
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
// Payload contract of each phase; other phases carry free JSON.
const payloadSchemas: Record<ProductionRun['kind'], Partial<Record<Phase, z.ZodType>>> = {
  production: {
    plan: productionPlanSchema,
    script: storyboardDraftSchema,
    motion: motionCompositionSchema,
    audio: audioCompositionSchema
  },
  revision: {
    plan: z.union([reviewPlanSchema, audioCompositionSchema, revisionEditSchema]),
    motion: motionCompositionSchema,
    audio: audioCompositionSchema
  }
};

/**
 * Drives a Director plan: phases run when their dependencies are done (independent
 * phases in parallel), payloads are validated against their phase contract and persisted
 * as agent result envelopes, a completed phase is never re-run within its run (there is
 * no cross-run cache: inputHash is provenance only), failures are retried up to the
 * plan's limit, a stop is honoured between phases, and a run resumes where it stopped,
 * including after a crash of this single process.
 * It is provider-agnostic: runners decide which agent or engine does the work.
 */
export class Orchestrator {
  private driving = new Map<string, Promise<ProductionRun>>();
  constructor(
    private repo: Repository,
    private log: (projectId: string, text: string) => void
  ) {}

  create(input: {
    projectId: string;
    kind: ProductionRun['kind'];
    plan: ProductionPlan;
    brief?: ProductionRun['brief'];
    sourceRevisionId?: string | null;
    /** Phases already decided when the run is created (e.g. the Director's plan). */
    done?: Partial<Record<Phase, PhaseOutcome & { kind: 'done' }>>;
  }) {
    return this.repo.transaction(() => {
      const now = Date.now();
      const run = this.repo.createRun({
        id: newId('run'),
        projectId: input.projectId,
        kind: input.kind,
        brief: input.brief ?? null,
        plan: input.plan,
        sourceRevisionId: input.sourceRevisionId ?? null,
        createdAt: now,
        updatedAt: now
      });
      for (const spec of input.plan.phases) {
        const row = this.repo.createPhase({
          id: newId('phs'),
          runId: run.id,
          phase: spec.phase,
          agent: spec.agent,
          createdAt: now,
          updatedAt: now
        });
        const outcome = input.done?.[spec.phase];
        if (outcome) this.finish(run, row, outcome, inputHash({ phase: spec.phase, preset: true }));
      }
      return this.repo.getRun(run.id);
    });
  }

  phases(runId: string) {
    return this.repo.phasesFor([runId]);
  }
  private phase(runId: string, name: Phase) {
    const row = this.phases(runId).find((p) => p.phase === name);
    if (!row) throw new Error(`Phase ${name} absente de la production`);
    return row;
  }

  /** Records the result of a waiting phase (assisted import, human approval). */
  complete(runId: string, name: Phase, outcome: PhaseOutcome & { kind: 'done' }) {
    const run = this.repo.getRun(runId);
    const row = this.phase(runId, name);
    if (row.status !== 'waiting') throw new Error(`La phase ${name} n'attend pas de résultat`);
    this.finish(run, row, outcome, row.inputHash ?? inputHash({ phase: name }));
    if (run.status === 'waiting') this.repo.updateRun(runId, { status: 'running' });
  }

  /** Manual stop: the phase in progress finishes, no further phase starts. */
  stop(runId: string) {
    const run = this.repo.getRun(runId);
    if (run.status !== 'running' && run.status !== 'waiting')
      throw new Error('Production déjà terminée');
    this.repo.updateRun(runId, { status: 'stopped' });
    this.log(run.projectId, 'Production arrêtée par l’utilisateur.');
  }

  /**
   * Resumes a failed or stopped run from its first unfinished phase. A run still
   * 'running' without a drive in this process was orphaned by a crash: its 'running'
   * phases are failed then reset like any failed phase.
   */
  async resume(runId: string, runners: Runners) {
    await this.driving.get(runId);
    const run = this.repo.getRun(runId);
    // No drive in this process: phases still 'running' were interrupted (crash), even
    // if the run was stopped from the UI afterwards.
    const idle = !this.driving.has(runId);
    const orphan = run.status === 'running' && idle;
    if (run.status !== 'failed' && run.status !== 'stopped' && !orphan)
      throw new Error('Seule une production en échec ou arrêtée peut reprendre');
    for (const row of this.phases(runId)) {
      if (idle && row.status === 'running')
        this.repo.updatePhase(row.id, { status: 'failed', error: 'Interrompue (redémarrage)' });
      if (row.status === 'failed' || (idle && row.status === 'running'))
        this.repo.updatePhase(row.id, { status: 'pending', attempts: 0 });
    }
    this.repo.updateRun(runId, { status: 'running', error: null });
    return this.drive(runId, runners);
  }

  drive(runId: string, runners: Runners): Promise<ProductionRun> {
    const active = this.driving.get(runId);
    if (active) return active;
    const work = this.drivePhases(runId, runners).finally(() => this.driving.delete(runId));
    this.driving.set(runId, work);
    return work;
  }

  private async drivePhases(runId: string, runners: Runners): Promise<ProductionRun> {
    for (;;) {
      const run = this.repo.getRun(runId);
      if (run.status !== 'running') return run;
      const rows = this.phases(runId);
      const state = new Map(rows.map((r) => [r.phase, r.status]));
      if (rows.every((r) => r.status === 'done' || r.status === 'skipped'))
        return this.repo.updateRun(runId, { status: 'completed' });
      if (rows.some((r) => r.status === 'failed')) {
        const failed = rows.find((r) => r.status === 'failed')!;
        this.log(run.projectId, `Production en échec à la phase ${failed.phase} : ${failed.error}`);
        return this.repo.updateRun(runId, { status: 'failed', error: failed.error });
      }
      const ready = rows.filter(
        (r) =>
          r.status === 'pending' &&
          run.plan.phases
            .find((p) => p.phase === r.phase)!
            .dependsOn.every((d) => state.get(d) === 'done' || state.get(d) === 'skipped')
      );
      if (!ready.length) {
        if (rows.some((r) => r.status === 'waiting'))
          return this.repo.updateRun(runId, { status: 'waiting' });
        return this.repo.updateRun(runId, { status: 'failed', error: 'Dépendances bloquées' });
      }
      // Independent phases (Motion and Audio after the script) run in parallel.
      await Promise.all(ready.map((row) => this.execute(run, row, rows, runners)));
    }
  }

  private async execute(
    run: ProductionRun,
    row: ProductionPhase,
    rows: ProductionPhase[],
    runners: Runners
  ) {
    if (this.repo.getRun(run.id).status !== 'running') return;
    const spec = run.plan.phases.find((p) => p.phase === row.phase)!;
    const inputs: Partial<Record<Phase, unknown>> = {};
    for (const dep of spec.dependsOn) {
      const result = rows.find((r) => r.phase === dep)?.result as { payload?: unknown } | null;
      inputs[dep] = result?.payload ?? null;
    }
    const hash = inputHash({ phase: row.phase, brief: run.brief, inputs } as never);
    const runner = runners[row.phase];
    if (!runner) {
      // No agent or engine runs it here: it waits (human approval, assisted step).
      this.repo.updatePhase(row.id, { status: 'running', inputHash: hash, startedAt: Date.now() });
      this.repo.updatePhase(row.id, { status: 'waiting' });
      return;
    }
    let attempts = row.attempts;
    while (attempts < spec.maxAttempts) {
      const current = this.repo.getRun(run.id);
      if (current.status !== 'running') return;
      if (runner.usesAi && current.aiCalls >= current.plan.budget.maxAiCalls) {
        this.repo.updatePhase(row.id, { status: 'running', attempts });
        this.repo.updatePhase(row.id, {
          status: 'failed',
          error: `Budget d'appels IA épuisé (${current.plan.budget.maxAiCalls})`
        });
        return;
      }
      attempts++;
      this.repo.updatePhase(row.id, {
        status: 'running',
        attempts,
        inputHash: hash,
        startedAt: Date.now(),
        error: null
      });
      try {
        if (runner.usesAi) this.repo.updateRun(run.id, { aiCalls: current.aiCalls + 1 });
        const outcome = await runner.run(inputs);
        if (outcome.kind === 'waiting') {
          this.repo.updatePhase(row.id, { status: 'waiting' });
          return;
        }
        this.finish(this.repo.getRun(run.id), this.phase(run.id, row.phase), outcome, hash);
        return;
      } catch (error) {
        this.repo.updatePhase(row.id, {
          status: 'failed',
          error: message(error).slice(0, 2000),
          finishedAt: Date.now()
        });
        // Retrying cannot help: the user raises the envelope, then resumes.
        if (error instanceof BudgetExceededError) return;
        if (attempts < spec.maxAttempts) {
          this.log(
            run.projectId,
            `Phase ${row.phase} : tentative ${attempts}/${spec.maxAttempts} en échec, nouvel essai.`
          );
          this.repo.updatePhase(row.id, { status: 'pending' });
        }
      }
    }
  }

  private finish(
    run: ProductionRun,
    row: ProductionPhase,
    outcome: PhaseOutcome & { kind: 'done' },
    hash: string
  ) {
    const spec = run.plan.phases.find((p) => p.phase === row.phase)!;
    const done = this.phases(run.id).filter((p) => spec.dependsOn.includes(p.phase) && p.result);
    const checked = payloadSchemas[run.kind][row.phase]?.safeParse(outcome.payload);
    const errors =
      checked && !checked.success
        ? checked.error.issues.map((i) => `${i.path.join('.') || 'payload'} : ${i.message}`)
        : [];
    const result = envelope.parse({
      id: row.id,
      schemaVersion: 1,
      agent: spec.agent,
      phase: row.phase,
      revisionId: outcome.revisionId ?? run.revisionId,
      dependsOn: done.map((p) => p.id),
      provider: outcome.provider,
      provenance: { inputHash: hash, createdAt: Date.now(), model: outcome.model ?? null },
      warnings: outcome.warnings ?? [],
      errors,
      validation: errors.length ? 'invalid' : (outcome.validation ?? 'valid'),
      payload: JSON.parse(JSON.stringify(outcome.payload ?? null))
    });
    if (errors.length) {
      const error = `Résultat de la phase ${row.phase} non conforme au contrat : ${errors.slice(0, 3).join(' ; ')}`;
      // A preset phase (pending) has nothing to fail: the caller's transaction rolls back.
      if (row.status !== 'pending')
        this.repo.updatePhase(row.id, {
          status: 'failed',
          result: result as never,
          error,
          finishedAt: Date.now()
        });
      throw new Error(error);
    }
    this.repo.transaction(() => {
      if (row.status === 'pending')
        this.repo.updatePhase(row.id, {
          status: 'running',
          startedAt: Date.now(),
          inputHash: hash
        });
      this.repo.updatePhase(row.id, {
        status: 'done',
        result: result as never,
        finishedAt: Date.now(),
        error: null
      });
      if (outcome.revisionId) this.repo.updateRun(run.id, { revisionId: outcome.revisionId });
    });
  }
}
