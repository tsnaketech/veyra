import { z } from 'zod';
import { inputHash } from '@veyra/schemas/hash';
import {
  directorStepSchema,
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
  tools: ReturnType<ToolRegistry['list']>;
  history: ToolExecutionRecord[];
}
/**
 * Decides the next step from the observed state. Scripted in T129a; the Director
 * (fake, then anthropic-api) implements the same interface in T129b. Its answer is
 * untrusted: it is validated as a DirectorStep, then by the tool's own input schema.
 */
export interface StepSource {
  next(view: LoopView): unknown;
}

/** Classes that always pause for a human decision on this very call (DIRECTOR-TOOL-LOOP § 4). */
const CONFIRM: readonly PermissionClass[] = ['billable', 'network-external'];
const HISTORY_IN_VIEW = 20;
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
  return loopStateSchema.parse({
    runId,
    phaseId,
    step: rows.length,
    status: pending
      ? 'paused-awaiting-permission'
      : last?.action === 'request_approval'
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
    pendingStepId: pending?.id ?? null,
    error: last?.action === 'stop' ? (request?.reason ?? null) : (phase?.error ?? null)
  });
}

/** Keeps one persisted result under `max` bytes: output or error details are replaced by a preview. */
function bounded(result: ToolResult, max: number): ToolResult {
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes <= max) return result;
  const preview = String(
    JSON.stringify(result.ok ? result.output : (result.error.details ?? null))
  ).slice(0, Math.floor(max / 4));
  return result.ok
    ? { ...result, output: { truncated: true, bytes, preview } }
    : { ...result, error: { ...result.error, details: { truncated: true, bytes } } };
}

/** Records a human decision on a paused call; the caller then wakes the phase (Orchestrator.wake). */
export function decidePermission(
  repo: Repository,
  phaseId: string,
  stepId: string,
  granted: boolean
) {
  const row = repo.loopSteps(phaseId).find((r) => r.id === stepId);
  if (row?.status !== 'awaiting-permission')
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
  const { repo, registry, source, runId, signal } = options;
  const name = options.phase ?? 'plan';
  const limits = loopLimitsSchema.parse(options.limits ?? {});

  return {
    async run() {
      const phase = repo.phasesFor([runId]).find((p) => p.phase === name);
      if (!phase) throw new Error(`Phase ${name} absente de la production`);
      const phaseId = phase.id;
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
        repo.updateLoopStep(row.id, {
          status: result.ok ? 'done' : cancelled ? 'cancelled' : 'failed',
          result: bounded(result, limits.maxObservationBytes),
          error: result.ok ? null : result.error,
          costMicroUsd: result.cost.microUsd,
          durationMs: result.durationMs,
          finishedAt: Date.now()
        });
        if (cancelled) throw new Error('Boucle d’outils annulée');
      };

      // This runner only starts when no step of its phase executes in this process: a
      // 'running' step was cut by a crash. Only a deterministic, side-effect-free call is
      // replayed; any other is reported 'interrupted' and the source decides.
      for (const row of repo.loopSteps(phaseId).filter((r) => r.status === 'running')) {
        const meta = registry.meta(row.invocation!.toolId);
        repo.updateLoopStep(
          row.id,
          meta?.deterministic && meta.sideEffects === 'none'
            ? { status: 'authorized', startedAt: null }
            : {
                status: 'interrupted',
                error: error(
                  'interrupted',
                  'Appel interrompu par un arrêt du Studio : effet inconnu, non rejoué'
                ),
                finishedAt: Date.now()
              }
        );
      }

      for (;;) {
        if (signal?.aborted) throw new Error('Boucle d’outils annulée');
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
        if (last?.action === 'request_approval') {
          const step = last.request as { revisionId: string | null; summary: string };
          return {
            kind: 'done',
            payload: { loop: state, revisionId: step.revisionId, summary: step.summary },
            provider: options.provider ?? 'rules',
            revisionId: step.revisionId
          };
        }
        const [a, b] = rows.slice(-2);
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

        const raw = await source.next({
          state,
          tools: registry.list(),
          history: rows.slice(-HISTORY_IN_VIEW)
        });
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
        if (step.action === 'request_approval' || step.action === 'stop') {
          record({ action: step.action, request: step, status: 'done' });
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
          grants: confirm ? [...new Set([...options.grants, ...extra])] : options.grants
        });
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
