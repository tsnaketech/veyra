<script lang="ts">
  import { enhance } from '$app/forms';
  import { providerLabels } from '#lib/ui.ts';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const claude = $derived(data.ai.claude);
  const ids = [
    'fake',
    'anthropic-api',
    'claude-subscribe',
    'openai-api',
    'codex-chatgpt',
    'local'
  ] as const;
  const statusText = {
    operational: 'Opérationnel',
    prepared: 'Préparé (désactivé par défaut)',
    unavailable: 'Indisponible',
    simulated: 'Simulé'
  } as const;
  const costText = {
    'metered-api': 'Facturé à l’usage sur votre clé (enveloppe D022)',
    subscription: 'Inclus dans votre abonnement, dans ses limites',
    none: 'Aucun',
    local: 'Local (votre machine)'
  } as const;
  const yes = (value: boolean) => (value ? 'oui' : 'non');
  const models = $derived({
    'anthropic-api': data.ai.models.join(', '),
    'openai-api': data.ai.openaiModel ?? 'aucun configuré',
    'claude-subscribe': 'celui de votre session Claude Code',
    'codex-chatgpt': 'celui de Codex (plan ChatGPT)'
  } as Record<string, string>);
  // What the user must do for an unavailable provider; never done by Veyra itself.
  const action = $derived({
    'anthropic-api': `Définir ${data.ai.apiKeyEnv} et un tarif local du modèle (config/models.json).`,
    'openai-api':
      'Définir OPENAI_API_KEY, openai.model et un tarif sourcé du modèle (config/models.json).',
    'claude-subscribe': 'Installer Claude Code puis `claude auth login`.',
    'codex-chatgpt':
      'Installer Codex, `codex login` avec votre compte ChatGPT, renseigner codexChatgpt.command (chemin absolu), puis activer ci-dessous.',
    local: 'Aucune : non implémenté (T142).'
  } as Record<string, string>);
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
      <fieldset class="grid gap-2 md:grid-cols-2" disabled={data.ai.locked}>
        <legend class="sr-only">Choisir le fournisseur</legend>
        {#each ids as id (id)}
          {@const caps = data.ai.capabilities[id]}
          {@const avail = data.ai.availability[id]}
          <label class="flex gap-3 rounded-lg border border-line p-3" data-testid="provider-{id}">
            <input
              type="radio"
              name="provider"
              value={id}
              checked={data.ai.selected === id}
              disabled={!avail.ok}
              class="size-6 shrink-0 accent-cyan"
            />
            <span class="min-w-0 space-y-1">
              <span class="block"><span class="font-medium">{id}</span> — {providerLabels[id]}</span
              >
              <span class="block text-xs" data-testid="status-{id}"
                >Statut : {statusText[caps.status]} · {caps.reason}</span
              >
              <span
                class="block text-xs {avail.ok ? 'text-ok' : 'text-warn'}"
                data-testid="availability-{id}"
                >{avail.ok ? 'Disponible' : 'Indisponible'} · {avail.reason}</span
              >
              <span class="block text-xs text-muted">
                Authentification : {caps.auth}{#if models[id]}
                  · Modèles : {models[id]}{/if}
              </span>
              <span class="block text-xs text-muted">
                Capacités : sortie structurée {yes(caps.structured)}, images {yes(caps.images)},
                outils {caps.tools === 'later' ? 'plus tard' : 'non'}, streaming {yes(
                  caps.streaming
                )}, annulation {yes(caps.cancel)}, reprise {yes(caps.resume)}
              </span>
              <span class="block text-xs text-muted">Coût : {costText[caps.cost]}</span>
              <span class="block text-xs text-muted">Limites : {caps.limits}</span>
              {#if !avail.ok && action[id]}
                <span class="block text-xs">Action nécessaire : {action[id]}</span>
              {/if}
            </span>
          </label>
        {/each}
      </fieldset>
      <div class="flex gap-2">
        <button class="btn btn-primary" disabled={data.ai.locked}>Utiliser ce fournisseur</button>
        <button class="btn" formaction="?/check">Vérifier la disponibilité</button>
      </div>
    </form>
    <form
      method="POST"
      action="?/codex"
      use:enhance
      class="space-y-2 rounded-lg border border-line p-3 text-xs"
      data-testid="codex-activation"
    >
      <p>
        <span class="font-medium">codex-chatgpt</span> :
        {data.ai.codex.enabled ? 'activé par vous' : 'désactivé'}. Statut contractuel ambigu accepté
        par l’utilisateur (D023). Veyra ne lance Codex qu’après cette activation, et seulement
        <code>codex --version</code>
        et <code>codex login status</code> pour la disponibilité ; binaire :
        <code>{data.ai.codex.command ?? 'non configuré'}</code>.
      </p>
      <input type="hidden" name="enabled" value={data.ai.codex.enabled ? '0' : '1'} />
      <button class="btn">{data.ai.codex.enabled ? 'Désactiver Codex' : 'Activer Codex'}</button>
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
    <dt class="text-muted">Modèles et tarifs (D022)</dt>
    <dd>
      <p>Modèle utilisé : {data.ai.models[0]} (configurés : {data.ai.models.join(', ')})</p>
      {#each [...data.ai.models, ...(data.ai.openaiModel ? [data.ai.openaiModel] : [])] as model (model)}
        {@const price = data.ai.pricing[model]}
        <p class="text-xs text-muted">
          {model} :
          {#if price}{price.inputUsdPerMTok} $ / Mjetons en entrée, {price.outputUsdPerMTok} $ / Mjetons
            en sortie — source : {price.source}, vérifié le {price.checkedAt}
          {:else}<span class="text-bad">aucun tarif local : appels refusés</span>{/if}
        </p>
      {/each}
    </dd>
    <dt class="text-muted">Clé API</dt>
    <dd>
      {data.ai.apiKeyEnv} : {data.ai.apiKeyConfigured ? 'définie (valeur masquée)' : 'non définie'}
      · OPENAI_API_KEY : {data.ai.openaiKeyConfigured ? 'définie (valeur masquée)' : 'non définie'}
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
