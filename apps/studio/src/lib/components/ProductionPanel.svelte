<script lang="ts">
  import { enhance } from '$app/forms';
  import { formatUsd, type ProductionRun, type ProductionPhase } from '@veyra/schemas';
  import StatusBadge from './StatusBadge.svelte';
  let {
    run,
    phases,
    billable = false
  }: { run: ProductionRun | null; phases: ProductionPhase[]; billable?: boolean } = $props();
  const agents: Record<string, string> = {
    director: 'Director',
    motion: 'Motion',
    audio: 'Audio',
    review: 'Review',
    'qa-expert': 'QA Expert',
    engine: 'Moteur',
    human: 'Humain'
  };
  const labels: Record<string, string> = {
    brief: 'Brief',
    plan: 'Plan',
    script: 'Scénario',
    motion: 'Animation',
    audio: 'Audio',
    composition: 'Composition',
    render: 'Rendu',
    qa: 'Contrôle qualité',
    'human-approval': 'Validation humaine'
  };
  const runPhases = $derived(run ? phases.filter((p) => p.runId === run.id) : []);
  const current = $derived(
    runPhases.find((p) => ['running', 'waiting', 'failed'].includes(p.status)) ??
      runPhases.find((p) => p.status === 'pending') ??
      null
  );
  const canStop = $derived(run?.status === 'running' || run?.status === 'waiting');
</script>

{#if run}
  <section aria-label="Production" data-testid="production-panel" class="space-y-2">
    <h2 class="font-medium">Production</h2>
    <div aria-live="polite" class="space-y-1">
      <p><StatusBadge status={run.status} /></p>
      {#if current}<p>
          Phase en cours : <strong>{labels[current.phase]}</strong> · agent responsable :
          <strong>{agents[current.agent]}</strong>
        </p>{/if}
      {#if run.error}<p class="text-bad">{run.error}</p>{/if}
      {#if billable || run.budgetMicroUsd > 0}<p class="text-xs" data-testid="run-budget">
          Enveloppe : {formatUsd(run.budgetMicroUsd)} $ autorisés · {formatUsd(run.spentMicroUsd)} $ dépensés
          · {formatUsd(run.reservedMicroUsd)} $ réservés
          <span class="text-muted">(calculé depuis la grille tarifaire locale)</span>
        </p>{/if}
    </div>
    {#if billable}<form
        method="POST"
        action="?/raiseBudget"
        use:enhance
        class="flex items-end gap-2 text-xs"
      >
        <input type="hidden" name="runId" value={run.id} />
        <label class="flex-1"
          >Nouvelle enveloppe (USD)
          <input
            name="budgetUsd"
            type="number"
            min={run.budgetMicroUsd / 1e6}
            step="0.01"
            value={run.budgetMicroUsd / 1e6}
            class="field"
            required
          />
        </label>
        <button class="btn">Augmenter</button>
      </form>{/if}
    {#if canStop || run.status === 'failed' || run.status === 'stopped'}
      <!-- One form whose action flips, so the button keeps keyboard focus across stop/resume. -->
      <form method="POST" action={canStop ? '?/stopProduction' : '?/resumeProduction'} use:enhance>
        <input type="hidden" name="runId" value={run.id} />
        <button class="btn">{canStop ? 'Arrêter' : 'Reprendre'}</button>
      </form>
    {/if}
    <ol class="space-y-2">
      {#each runPhases as phase (phase.id)}
        <li class="rounded border border-line p-2 text-xs">
          <p>
            {labels[phase.phase]} · {agents[phase.agent]} · <StatusBadge status={phase.status} />
          </p>
          <p>Tentatives : {phase.attempts}</p>
          {#if phase.error}<p role="alert" class="text-bad">{phase.error}</p>{/if}
          {#if phase.result}
            <details>
              <summary class="cursor-pointer">Résultat de {labels[phase.phase]}</summary>
              <p>
                Fournisseur : {String(phase.result.provider)} · Validation : {phase.result
                  .validation === 'needs-human'
                  ? 'Validation humaine requise'
                  : phase.result.validation === 'valid'
                    ? 'Conforme'
                    : String(phase.result.validation)}
              </p>
              {#if Array.isArray(phase.result.warnings)}
                {#each phase.result.warnings as warning, i (i)}<p class="text-warn">
                    {String(warning)}
                  </p>{/each}
              {/if}
              <pre class="max-h-64 overflow-auto break-all whitespace-pre-wrap">{JSON.stringify(
                  phase.result.payload,
                  null,
                  2
                )}</pre>
            </details>
          {/if}
        </li>
      {/each}
    </ol>
  </section>
{/if}
