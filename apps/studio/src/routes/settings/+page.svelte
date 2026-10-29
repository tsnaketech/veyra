<script lang="ts">
  import { enhance } from '$app/forms';
  import { providerLabels } from '#lib/ui.ts';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const claude = $derived(data.ai.claude);
  const availability = $derived({
    fake: { ok: true, text: 'Toujours disponible. Résultats simulés, étiquetés comme tels.' },
    'anthropic-api': {
      ok: data.ai.apiKeyConfigured,
      text: data.ai.apiKeyConfigured
        ? `${data.ai.apiKeyEnv} définie (valeur masquée). Appels facturés sur la clé ; non vérifiée par un appel.`
        : `${data.ai.apiKeyEnv} non définie.`
    },
    'claude-subscribe': {
      ok: claude.available,
      text:
        `${claude.reason}` +
        (claude.subscriptionType ? ` Offre : ${claude.subscriptionType}.` : '') +
        ' Mode assisté : Veyra exporte la demande, vous la traitez dans Claude Code, Veyra importe le résultat.'
    }
  } as Record<string, { ok: boolean; text: string }>);
  const ids = ['fake', 'anthropic-api', 'claude-subscribe'] as const;
</script>

<svelte:head><title>Paramètres — Veyra Studio</title></svelte:head>

<div class="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-8">
  <h1 class="text-2xl font-semibold">Paramètres</h1>

  {#if form?.error}
    <p role="alert" class="rounded-lg border border-bad/50 bg-bad/10 px-3 py-2 text-sm text-bad">
      {form.error}
    </p>
  {/if}

  <section class="panel space-y-3 p-4 text-sm" aria-labelledby="ai-title">
    <h2 id="ai-title" class="font-medium">Fournisseur IA</h2>
    <p data-testid="ai-provider">
      Actif : {data.ai.active ? providerLabels[data.ai.active] : 'Non configurée'}
    </p>
    {#if data.ai.error}<p class="text-bad" role="alert">{data.ai.error}</p>{/if}
    <p class="text-xs text-muted">
      Aucun basculement automatique : si le fournisseur choisi est indisponible, l'IA est
      indisponible.
      {#if data.ai.locked}Choix imposé par <code>VEYRA_AI_PROVIDER</code>.{/if}
    </p>
    <form method="POST" action="?/provider" use:enhance class="space-y-2">
      <fieldset class="space-y-2" disabled={data.ai.locked}>
        <legend class="sr-only">Choisir le fournisseur</legend>
        {#each ids as id (id)}
          <label class="flex gap-3 rounded-lg border border-line p-3" data-testid="provider-{id}">
            <input
              type="radio"
              name="provider"
              value={id}
              checked={data.ai.selected === id}
              class="size-6 shrink-0 accent-cyan"
            />
            <span>
              <span class="font-medium">{id}</span> — {providerLabels[id]}
              <span
                class="block text-xs {availability[id].ok ? 'text-ok' : 'text-warn'}"
                data-testid="availability-{id}"
                >{availability[id].ok ? 'Disponible' : 'Indisponible'} · {availability[id]
                  .text}</span
              >
            </span>
          </label>
        {/each}
      </fieldset>
      <div class="flex gap-2">
        <button class="btn btn-primary" disabled={data.ai.locked}>Utiliser ce fournisseur</button>
        <button class="btn" formaction="?/check">Vérifier la disponibilité</button>
      </div>
    </form>
    {#if claude.apiKeyInEnvironment}
      <p class="text-xs text-warn">
        Une clé API Anthropic est définie dans l'environnement de Veyra. Si elle l'est aussi dans le
        terminal où vous lancez Claude Code, Claude Code l'utilisera au lieu de votre abonnement
        (facturation API) : vérifiez avec <code>/status</code>.
      </p>
    {/if}
  </section>

  <dl class="panel grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-[12rem_1fr]">
    <dt class="text-muted">Moteur vidéo</dt>
    <dd>
      {data.engine.kind}
      {data.engine.cliVersion} · qualité {data.engine.quality} · {data.engine.fps} i/s
    </dd>
    <dt class="text-muted">Modèles (anthropic-api)</dt>
    <dd>{data.ai.models.join(', ')}</dd>
    <dt class="text-muted">Clé API</dt>
    <dd>
      {data.ai.apiKeyEnv} : {data.ai.apiKeyConfigured ? 'définie (valeur masquée)' : 'non définie'}
    </dd>
    <dt class="text-muted">Formats</dt>
    <dd>
      {#each Object.entries(data.formats) as [name, format] (name)}
        <span class="mr-3">{name} {format.width}×{format.height}</span>
      {/each}
      · max {data.maxDurationSeconds} s
    </dd>
    <dt class="text-muted">Stockage des projets</dt>
    <dd><code>{data.storageRoot}</code></dd>
  </dl>

  <details class="panel p-4 text-sm">
    <summary class="cursor-pointer font-medium">Configuration active (secrets masqués)</summary>
    <pre class="mt-3 overflow-x-auto text-xs text-muted">{JSON.stringify(
        data.snapshot,
        null,
        2
      )}</pre>
  </details>
</div>
