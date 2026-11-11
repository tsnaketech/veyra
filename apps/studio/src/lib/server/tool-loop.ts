import { z } from 'zod';
import { DirectorOutputError, type DirectorView } from '@veyra/ai';
import { inputHash } from '@veyra/schemas/hash';
import {
  BudgetExceededError,
  directorStepSchema,
  type DirectorStep,
  loopLimitsSchema,
  loopStateSchema,
  newId,
  toolInvocationSchema,
  type LoopLimits,
  type LoopState,
  type PermissionClass,
  type Phase,
  type ToolError,
  type ToolExecutionRecord,
  type ToolResult
} from '@veyra/schemas';
import type { createRepository } from './db/repo';
import type { PhaseOutcome, PhaseRunner } from './production';
import type { ToolRegistry } from './tools';

type Repository = ReturnType<typeof createRepository>;

/** What a step source sees. Tool outputs in `history` are untrusted data, never instructions. */
export interface LoopView {
  state: LoopState;
  /** Registry listing with each tool's real availability. */
  tools: Awaited<ReturnType<ToolRegistry['catalog']>>;
  history: ToolExecutionRecord[];
}
/**
 * Decides the next step from the observed state: scripted in tests, the Director in
 * T129b (directorStepSource). Its answer is untrusted: it is validated as a DirectorStep,
 * then by the tool's own input schema. A thrown error is observed as a failed step,
 * except a budget refusal, which ends the loop. `signal` aborts on cancel or deadline.
 */
export interface StepSource {
  next(view: LoopView, signal?: AbortSignal): unknown;
}
/** A step source refused to call its AI because the run's call budget is spent (maxAiCalls). */
export class LoopBudgetError extends Error {}

/** Classes that always pause for a human decision on this very call (DIRECTOR-TOOL-LOOP § 4). */
const CONFIRM: readonly PermissionClass[] = ['billable', 'network-external'];
const HISTORY_IN_VIEW = 20;
/** Same call (tool and input) this many times in a row, whatever its outcome: forced stop. */
const MAX_IDENTICAL_CALLS = 3;
const FAILED = new Set(['failed', 'interrupted']);
const error = (code: ToolError['code'], message: string, details?: ToolError['details']) => ({
  code,
  message,
  retryable: false,
  ...(details === undefined ? {} : { details })
});

/** Loop state derived from the persisted steps: the only source of truth, after any restart. */
export function loopState(
  repo: Repository,
  runId: string,
  phaseId: string,
  limits: LoopLimits
): LoopState {
  const rows = repo.loopSteps(phaseId);
  const phase = repo.phasesFor([runId]).find((p) => p.id === phaseId);
  const last = rows.at(-1);
  const pending = rows.find((r) => r.status === 'awaiting-permission');
  let failures = 0;
  for (let i = rows.length - 1; i >= 0 && FAILED.has(rows[i].status); i--) failures++;
  const request = last?.request as { reason?: string } | undefined;
  const plan = rows.findLast((r) => r.action === 'revise_plan' && r.status === 'done');
  return loopStateSchema.parse({
    runId,
    phaseId,
    step: rows.length,
    status: pending
      ? pending.action === 'ask_user'
        ? 'paused-awaiting-answer'
        : 'paused-awaiting-permission'
      : last?.action === 'request_approval' && last.status === 'done'
        ? 'completed'
        : last?.action === 'stop'
          ? 'stopped'
          : phase?.status === 'failed'
            ? 'failed'
            : 'running',
    counters: {
      steps: rows.length,
      toolCalls: rows.filter((r) => r.startedAt !== null).length,
      consecutiveFailures: failures
    },
    limits,
    costMicroUsd: rows.reduce((sum, r) => sum + r.costMicroUsd, 0),
    plan: (plan?.request as { plan?: unknown } | undefined)?.plan ?? null,
    pendingStepId: pending?.id ?? null,
    error: last?.action === 'stop' ? (request?.reason ?? null) : (phase?.error ?? null)
  });
}

/** Keeps one persisted result under `max` bytes: output or error details are replaced by a preview. */
export function bounded(result: ToolResult, max: number): ToolResult {
  const size = (r: ToolResult) => Buffer.byteLength(JSON.stringify(r));
  const bytes = size(result);
  if (bytes <= max) return result;
  const raw = String(JSON.stringify(result.ok ? result.output : (result.error.details ?? null)));
  // Characters are not bytes (multi-byte UTF-8, escaping): halve the cut until it fits.
  for (let n = Math.floor(max / 4); ; n = Math.floor(n / 2)) {
    const cut: ToolResult = result.ok
      ? { ...result, output: { truncated: true, bytes, preview: raw.slice(0, n) } }
      : {
          ...result,
          error: {
            ...result.error,
            message: result.error.message.slice(0, Math.max(n, 80)),
            details: { truncated: true, bytes }
          }
        };
    if (n === 0 || size(cut) <= max) return cut;
  }
}

/** Records a human decision on a paused call; the caller then wakes the phase (Orchestrator.wake). */
export function decidePermission(
  repo: Repository,
  phaseId: string,
  stepId: string,
  granted: boolean
) {
  const row = repo.loopSteps(phaseId).find((r) => r.id === stepId);
  if (row?.status !== 'awaiting-permission' || row.action === 'ask_user')
    throw new Error('Aucune autorisation en attente pour ce pas');
  return granted
    ? repo.updateLoopStep(stepId, { status: 'authorized' })
    : repo.updateLoopStep(stepId, {
        status: 'denied',
        error: error('permission-denied', 'Action refusée par l’utilisateur'),
        finishedAt: Date.now()
      });
}

/**
 * Records the user's answer to an `ask_user` step (a pause distinct from a permission:
 * an answer grants nothing); the caller then wakes the phase (Orchestrator.wake).
 */
export function answerQuestion(repo: Repository, phaseId: string, stepId: string, text: string) {
  const row = repo.loopSteps(phaseId).find((r) => r.id === stepId);
  if (row?.status !== 'awaiting-permission' || row.action !== 'ask_user')
    throw new Error('Aucune question en attente pour ce pas');
  const answer = text.trim().slice(0, 2000);
  if (!answer) throw new Error('Réponse vide');
  return repo.updateLoopStep(stepId, {
    status: 'done',
    request: { ...(row.request as object), answer: { text: answer, answeredAt: Date.now() } },
    finishedAt: Date.now()
  });
}

/** The Director's view of a loop step (DirectorView): Veyra's data plus untrusted observations. */
export function directorView(
  view: LoopView,
  context: { goal: string; project: DirectorView['project']; aiCallsLeft: number | null }
): DirectorView {
  const { counters, limits, plan } = view.state;
  return {
    goal: context.goal,
    project: context.project,
    plan,
    tools: view.tools.map((t) => ({
      id: t.meta.id,
      version: t.meta.version,
      description: t.meta.description,
      permissions: t.meta.permissions,
      available: t.available.ok,
      ...(t.available.ok ? {} : { reason: t.available.reason ?? 'raison inconnue' }),
      input: t.input
    })),
    history: view.history.map((r) => ({
      step: r.step,
      action: r.action,
      status: r.status,
      request: r.request,
      output: r.result?.ok ? r.result.output : null,
      error: r.error
        ? {
            code: r.error.code,
            message: r.error.message,
            ...(r.error.installHint ? { installHint: r.error.installHint } : {})
          }
        : null
    })),
    budget: {
      stepsLeft: Math.max(0, limits.maxSteps - counters.steps),
      toolCallsLeft: Math.max(0, limits.maxToolCalls - counters.toolCalls),
      aiCallsLeft: context.aiCallsLeft,
      consecutiveFailures: counters.consecutiveFailures,
      maxConsecutiveFailures: limits.maxConsecutiveFailures
    }
  };
}
/** Step source backed by a Director (AI provider or simulated), through `decide`. */
export function directorStepSource(options: {
  goal: string;
  project(): DirectorView['project'];
  aiCallsLeft(): number | null;
  decide(view: DirectorView, signal?: AbortSignal): Promise<DirectorStep>;
}): StepSource {
  return {
    next: (view, signal) =>
      options.decide(
        directorView(view, {
          goal: options.goal,
          project: options.project(),
          aiCallsLeft: options.aiCallsLeft()
        }),
        signal
      )
  };
}

/**
 * Controlled tool loop (T129a), run as the runner of one phase of an existing run
 * (D019/D021): every step comes from `source`, is validated, checked against the
 * phase grants, paused for a human decision when billable or network-bound, executed
 * through the registry only, and persisted in loop_steps before and after the call.
 */
export function toolLoopRunner(options: {
  repo: Repository;
  registry: ToolRegistry;
  source: StepSource;
  runId: string;
  phase?: Phase;
  /** Classes granted to every call of this phase; billable and network calls pause anyway. */
  grants: readonly PermissionClass[];
  limits?: Partial<LoopLimits>;
  /** Aborting cancels the call in progress (its processes are killed) and ends the loop. */
  signal?: AbortSignal;
  provider?: (PhaseOutcome & { kind: 'done' })['provider'];
}): PhaseRunner {
  const { repo, registry, source, runId } = options;
  const name = options.phase ?? 'plan';
  const limits = loopLimitsSchema.parse(options.limits ?? {});
  // Generated code is never grantable (D021, D026), even when the phase lists it.
  const grants = options.grants.filter((p) => p !== 'generated-code-execution');

  return {
    async run() {
      const phase = repo.phasesFor([runId]).find((p) => p.phase === name);
      if (!phase) throw new Error(`Phase ${name} absente de la production`);
      const phaseId = phase.id;
      // Active wall time of this drive: cancels the call or the decision in progress.
      const wall = AbortSignal.timeout(limits.maxWallMs);
      const signal = options.signal ? AbortSignal.any([options.signal, wall]) : wall;
      const record = (
        input: Pick<ToolExecutionRecord, 'action' | 'request' | 'status'> &
          Partial<Pick<ToolExecutionRecord, 'origin' | 'invocation' | 'error' | 'finishedAt'>>,
        id = newId('stp')
      ) => {
        const now = Date.now();
        return repo.createLoopStep({
          id,
          runId,
          phaseId,
          step: repo.loopSteps(phaseId).length,
          origin: 'source',
          createdAt: now,
          updatedAt: now,
          ...input
        });
      };
      const execute = async (row: ToolExecutionRecord) => {
        const call = row.invocation!;
        repo.updateLoopStep(row.id, { status: 'running', startedAt: Date.now() });
        const result = await registry.invoke(call.toolId, call.input, {
          grants: call.grants,
          signal
        });
        const cancelled = !result.ok && result.error.code === 'cancelled';
        const stored = bounded(result, limits.maxObservationBytes);
        // The call ended but the tool did not return yet (it ignores the signal): say so.
        if (!stored.ok && registry.busy(call.toolId))
          stored.error = {
            ...stored.error,
            message: `${stored.error.message} ; effet possiblement en cours (l’outil n’a pas rendu la main)`
          };
        repo.updateLoopStep(row.id, {
          status: result.ok ? 'done' : cancelled ? 'cancelled' : 'failed',
          result: stored,
          error: stored.ok ? null : stored.error,
          costMicroUsd: result.cost.microUsd,
          durationMs: result.durationMs,
          finishedAt: Date.now()
        });
        if (cancelled) ended();
      };
      const forcedStop = (reason: string): never => {
        record({
          origin: 'engine',
          action: 'stop',
          request: { action: 'stop', reason },
          status: 'done',
          finishedAt: Date.now()
        });
        throw new Error(`Boucle d’outils arrêtée : ${reason}`);
      };
      // Cancelled by the caller, or the loop's own wall deadline.
      const ended = (): never => {
        if (wall.aborted && !options.signal?.aborted)
          forcedStop(`délai global de ${Math.round(limits.maxWallMs / 1000)} s dépassé`);
        throw new Error('Boucle d’outils annulée');
      };

      // This runner only starts when no step of its phase executes in this process: a
      // 'running' step was cut by a crash. Only a deterministic, side-effect-free, free and
      // offline call is replayed; any other is reported 'interrupted' and the source decides.
      for (const row of repo.loopSteps(phaseId).filter((r) => r.status === 'running')) {
        const meta = registry.meta(row.invocation!.toolId);
        const confirm = meta?.permissions.some((p) => CONFIRM.includes(p));
        repo.updateLoopStep(
          row.id,
          meta?.deterministic && meta.sideEffects === 'none' && !confirm
            ? { status: 'authorized', startedAt: null }
            : {
                status: 'interrupted',
                error: error(
                  'interrupted',
                  confirm
                    ? 'Appel payant ou réseau interrompu par un arrêt du Studio : non rejoué, nouvelle autorisation requise'
                    : 'Appel interrompu par un arrêt du Studio : effet inconnu, non rejoué'
                ),
                finishedAt: Date.now()
              }
        );
      }

      for (;;) {
        if (signal.aborted) ended();
        if (repo.getRun(runId).status !== 'running')
          throw new Error('Production arrêtée : boucle d’outils interrompue');
        const rows = repo.loopSteps(phaseId);
        if (rows.some((r) => r.status === 'awaiting-permission')) return { kind: 'waiting' };
        const authorized = rows.find((r) => r.status === 'authorized');
        if (authorized) {
          await execute(authorized);
          continue;
        }
        const last = rows.at(-1);
        const state = loopState(repo, runId, phaseId, limits);
        if (last?.action === 'stop') throw new Error(`Boucle d’outils arrêtée : ${state.error}`);
        if (last?.action === 'request_approval' && last.status === 'done') {
          const step = last.request as { revisionId: string | null; summary: string };
          return {
            kind: 'done',
            payload: { loop: state, revisionId: step.revisionId, summary: step.summary },
            provider: options.provider ?? 'rules',
            revisionId: step.revisionId
          };
        }
        const [a, b] = rows.slice(-2);
        const recent = rows.slice(-MAX_IDENTICAL_CALLS);
        const repeated =
          recent.length === MAX_IDENTICAL_CALLS &&
          recent.every(
            (r) =>
              r.invocation &&
              r.invocation.toolId === recent[0].invocation?.toolId &&
              r.invocation.inputHash === recent[0].invocation.inputHash
          );
        const limit =
          state.counters.steps >= limits.maxSteps - 1
            ? `limite de ${limits.maxSteps} pas atteinte`
            : state.counters.toolCalls >= limits.maxToolCalls
              ? `limite de ${limits.maxToolCalls} appels d’outils atteinte`
              : state.counters.consecutiveFailures >= limits.maxConsecutiveFailures
                ? `${state.counters.consecutiveFailures} échecs consécutifs`
                : a?.status === 'failed' &&
                    b?.status === 'failed' &&
                    a.invocation &&
                    a.invocation.toolId === b.invocation?.toolId &&
                    a.invocation.inputHash === b.invocation.inputHash
                  ? `appel identique en échec répété (${a.invocation.toolId})`
                  : repeated
                    ? `appel identique répété ${MAX_IDENTICAL_CALLS} fois (${recent[0].invocation!.toolId})`
                    : null;
        if (limit) {
          // The last step slot is kept for this forced stop: the state stays inspectable.
          record({
            origin: 'engine',
            action: 'stop',
            request: { action: 'stop', reason: limit },
            status: 'done'
          });
          continue;
        }

        let raw: unknown;
        try {
          raw = await source.next(
            { state, tools: await registry.catalog(), history: rows.slice(-HISTORY_IN_VIEW) },
            signal
          );
        } catch (failure) {
          // Cancelled while deciding: nothing is written, so no 'authorized' step survives.
          if (signal.aborted) ended();
          const text = (failure instanceof Error ? failure.message : String(failure)).slice(0, 300);
          if (failure instanceof LoopBudgetError || failure instanceof BudgetExceededError)
            forcedStop(text);
          // An unusable answer or a failed AI call is observed, never executed, and counted.
          record({
            action: 'invalid',
            request: { preview: 'aucune décision' },
            status: 'failed',
            error: error(
              failure instanceof DirectorOutputError ? 'invalid-output' : 'failed',
              `Décision du Director non obtenue : ${text}`
            ),
            finishedAt: Date.now()
          });
          continue;
        }
        if (signal.aborted) ended();
        const parsed = directorStepSchema.safeParse(raw);
        if (!parsed.success) {
          let preview: string;
          try {
            preview = String(JSON.stringify(raw)).slice(0, 2000);
          } catch {
            preview = 'non sérialisable';
          }
          record({
            action: 'invalid',
            request: { preview },
            status: 'failed',
            error: error(
              'invalid-input',
              'Pas refusé : action non conforme au contrat DirectorStep',
              z.treeifyError(parsed.error) as never
            ),
            finishedAt: Date.now()
          });
          continue;
        }
        const step = parsed.data;
        if (step.action === 'request_approval' && step.revisionId) {
          // The source is untrusted: only the run's source revision or one produced by this
          // loop (hence of its project) may become the run's revision.
          const id = step.revisionId;
          const run = repo.getRun(runId);
          const produced = rows.some(
            (r) =>
              r.status === 'done' &&
              r.result?.ok &&
              (r.result.output as { revisionId?: unknown } | null)?.revisionId === id
          );
          const own = id === run.sourceRevisionId || produced;
          if (!own || repo.getRevision(id).projectId !== run.projectId) {
            record({
              action: step.action,
              request: step,
              status: 'failed',
              error: error(
                'permission-denied',
                'Révision refusée : ni la révision source ni une révision produite par cette boucle'
              ),
              finishedAt: Date.now()
            });
            continue;
          }
        }
        if (
          step.action === 'request_approval' ||
          step.action === 'stop' ||
          step.action === 'revise_plan'
        ) {
          record({ action: step.action, request: step, status: 'done' });
          continue;
        }
        // A question pauses the loop like a permission, but its answer grants nothing.
        if (step.action === 'ask_user') {
          record({ action: step.action, request: step, status: 'awaiting-permission' });
          continue;
        }
        const meta = registry.meta(step.toolId);
        const refuse = (
          code: ToolError['code'],
          message: string,
          invocation = null as ToolExecutionRecord['invocation']
        ) =>
          record({
            action: step.action,
            request: step,
            invocation,
            status: 'failed',
            error: error(code, message),
            finishedAt: Date.now()
          });
        if (meta && meta.version !== step.toolVersion) {
          refuse(
            'invalid-input',
            `Version ${step.toolVersion} demandée, ${meta.version} inscrite au registre`
          );
          continue;
        }
        let hash: string;
        try {
          hash = inputHash(step.input);
        } catch {
          refuse('invalid-input', 'Entrée refusée : JSON simple et peu profond attendu');
          continue;
        }
        // Generated code stays refused (D021): no human authorization can grant it here.
        const extra = (meta?.permissions ?? []).filter((p) => p !== 'generated-code-execution');
        const confirm =
          !!meta &&
          (step.action === 'request_permission' ||
            meta.permissions.some((p) => CONFIRM.includes(p)));
        const id = newId('stp');
        const invocation = toolInvocationSchema.parse({
          stepId: id,
          runId,
          phaseId,
          agent: 'director',
          phase: name,
          toolId: step.toolId,
          toolVersion: step.toolVersion,
          input: step.input,
          inputHash: hash,
          grants: [...new Set([...grants, ...(confirm ? extra : [])])]
        });
        if (registry.busy(step.toolId)) {
          refuse(
            'conflict',
            `Appel précédent de ${step.toolId} non terminé (annulation ou délai demandé, effet possiblement en cours) : non exécuté`,
            invocation
          );
          continue;
        }
        // A refused action is never run again, whatever the source asks.
        if (
          rows.some(
            (r) =>
              r.status === 'denied' &&
              r.invocation?.toolId === step.toolId &&
              r.invocation.inputHash === hash
          )
        ) {
          refuse(
            'permission-denied',
            'Action déjà refusée par l’utilisateur : non exécutée',
            invocation
          );
          continue;
        }
        record(
          {
            action: step.action,
            request: step,
            invocation,
            status: confirm ? 'awaiting-permission' : 'authorized'
          },
          id
        );
      }
    }
  };
}
