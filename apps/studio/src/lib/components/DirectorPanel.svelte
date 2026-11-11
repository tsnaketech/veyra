<script lang="ts">
  import { enhance } from '$app/forms';
  import type { ProductionPhase, ProductionRun } from '@veyra/schemas';
  import { providerLabels } from '#lib/ui.ts';
  import StatusBadge from './StatusBadge.svelte';

  type Step = {
    id: string;
    step: number;
    origin: 'source' | 'engine';
    action: string;
    status: string;
    justification: string;
    toolId: string | null;
    permissions: string[];
    cost: string | null;
    detail: string;
    answer: string | null;
    output: string | null;
    error: string | null;
    simulated: boolean;
    durationMs: number | null;
  };
  let {
    history,
    runs,
    phases
  }: {
    history: { runId: string; goal: string; provider: string; steps: Step[] }[];
    runs: ProductionRun[];
    phases: ProductionPhase[];
  } = $props();

  const actions: Record<string, string> = {
    tool_call: 'Appel d’outil',
    request_permission: 'Demande d’autorisation',
    request_approval: 'Proposition à la validation',
    revise_plan: 'Plan',
    ask_user: 'Question',
    stop: 'Arrêt',
    invalid: 'Décision refusée'
  };
  const statuses: Record<string, string> = {
    'awaiting-permission': 'En attente de votre décision',
    authorized: 'Autorisé',
    denied: 'Refusé',
    running: 'En cours',
    done: 'Terminé',
    failed: 'Échec',
    interrupted: 'Interrompu',
    cancelled: 'Annulé'
  };
  const fixed: Record<string, string> = {
    render: 'Rendu',
    qa: 'Contrôle qualité',
    'human-approval': 'Validation humaine'
  };
  const runOf = (id: string) => runs.find((r) => r.id === id);
  const fixedPhases = (id: string) => phases.filter((p) => p.runId === id && p.phase in fixed);
  const ordered = $derived([...history].reverse());
  const payload = (p: ProductionPhase) =>
    (p.result as { payload?: Record<string, unknown> } | null)?.payload ?? null;
</script>

{#if history.length}
  <section aria-label="Director" data-testid="director-panel" class="space-y-2">
    <h2 class="font-medium">Montage par le Director</h2>
    {#each ordered as entry, index (entry.runId)}
      {@const run = runOf(entry.runId)}
      {@const open = run?.status === 'running' || run?.status === 'waiting'}
      <details open={index === 0} class="rounded border border-line p-2 text-xs">
        <summary class="cursor-pointer">
          {entry.provider === 'fake' ? '[Simulé] ' : ''}Director — {providerLabels[
            entry.provider
          ] ?? entry.provider}
          {#if run}· <StatusBadge status={run.status} />{/if}
        </summary>
        <p class="mt-1 text-muted">Demande : {entry.goal}</p>
        <h3 class="mt-2 font-medium">Décisions du modèle et outils exécutés</h3>
        <ol class="space-y-1" data-testid="director-steps">
          {#each entry.steps as step (step.id)}
            <li
              class="rounded border-l-4 p-1.5 {step.origin === 'source'
                ? 'border-violet bg-violet/10'
                : 'border-line bg-raised'}"
              data-testid="director-step"
              data-action={step.action}
              data-status={step.status}
            >
              <p>
                <span class="badge {step.origin === 'source' ? 'bg-violet/30' : 'bg-raised'}"
                  >{step.origin === 'source'
                    ? 'Décision du modèle'
                    : 'Arrêt imposé par la boucle'}</span
                >
                #{step.step + 1} · {actions[step.action] ?? step.action}{#if step.toolId}
                  · <code>{step.toolId}</code>{/if} · {statuses[step.status] ?? step.status}
                {#if step.durationMs !== null}· {Math.round(step.durationMs)} ms{/if}
                {#if step.simulated}· [Simulé]{/if}
              </p>
              {#if step.justification}<p class="[overflow-wrap:anywhere]">
                  {step.justification}
                </p>{/if}
              {#if step.detail}<p class="[overflow-wrap:anywhere] text-muted">
                  {step.action === 'ask_user' ? 'Question' : 'Arguments'} : {step.detail}
                </p>{/if}
              {#if step.answer}<p>Votre réponse : {step.answer}</p>{/if}
              {#if step.output}<p class="[overflow-wrap:anywhere] text-muted">
                  Résultat : {step.output}
                </p>{/if}
              {#if step.error}<p class="[overflow-wrap:anywhere] text-bad">{step.error}</p>{/if}
              {#if open && step.status === 'awaiting-permission' && step.action === 'ask_user'}
                <form method="POST" action="?/answerDirector" use:enhance class="mt-1 space-y-1">
                  <input type="hidden" name="runId" value={entry.runId} />
                  <input type="hidden" name="stepId" value={step.id} />
                  <label for="answer-{step.id}" class="block">Votre réponse au Director</label>
                  <textarea
                    id="answer-{step.id}"
                    name="answer"
                    rows="2"
                    maxlength="2000"
                    class="field resize-none"
                    required></textarea>
                  <button class="btn">Répondre</button>
                </form>
              {:else if open && step.status === 'awaiting-permission'}
                <form
                  method="POST"
                  action="?/decideDirector"
                  use:enhance
                  class="mt-1 flex flex-wrap items-center gap-2"
                >
                  <input type="hidden" name="runId" value={entry.runId} />
                  <input type="hidden" name="stepId" value={step.id} />
                  <span class="text-warn"
                    >Autoriser cette action seulement ({step.permissions.join(', ') ||
                      'classe inconnue'}{step.cost ? ` · coût : ${step.cost}` : ''}) ?</span
                  >
                  <button class="btn btn-primary" name="decision" value="grant">Autoriser</button>
                  <button class="btn" name="decision" value="deny">Refuser</button>
                </form>
              {/if}
            </li>
          {:else}
            <li class="text-muted">Aucune décision pour l’instant.</li>
          {/each}
        </ol>
        <h3 class="mt-2 font-medium">Étapes fixes de l’orchestrateur</h3>
        <ul class="space-y-1" data-testid="director-fixed">
          {#each fixedPhases(entry.runId) as phase (phase.id)}
            {@const out = payload(phase)}
            <li class="rounded border border-line p-1.5">
              <span class="badge bg-raised">Étape fixe</span>
              {fixed[phase.phase]} · <StatusBadge status={phase.status} />
              {#if phase.phase === 'render' && out?.revisionId}· révision
                <code>{String(out.revisionId)}</code>{out.status === 'reused'
                  ? ' (rendu existant réutilisé)'
                  : ''}{/if}
              {#if phase.phase === 'qa' && out}· {Number(out.failedCount)} contrôle(s) en échec sur
                {Number(out.total)}{/if}
              {#if phase.error}<span class="text-bad"> · {phase.error}</span>{/if}
            </li>
          {/each}
        </ul>
      </details>
    {/each}
  </section>
{/if}
