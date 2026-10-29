<script lang="ts">
  import { dateTime } from '#lib/ui.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<svelte:head><title>Composants — Veyra Studio</title></svelte:head>

<div class="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-8">
  <h1 class="text-2xl font-semibold">Composants animés</h1>
  <p class="text-sm text-muted">
    Registre v{data.registryVersion}. L'IA ne peut composer qu'avec ces composants et leurs
    paramètres validés ; aucun code n'est accepté.
    {#if data.manifest}
      Aperçus : rendus réels {data.manifest.engine}, générés le {dateTime(
        Date.parse(data.manifest.generatedAt)
      )}.
    {:else}
      Aucun aperçu généré : lancer <code>pnpm motion:previews</code>.
    {/if}
  </p>

  <ul class="grid gap-4 md:grid-cols-2">
    {#each data.components as component (component.id)}
      <li class="panel space-y-3 p-4" data-testid="motion-component" data-id={component.id}>
        <div class="flex flex-wrap items-baseline gap-2">
          <h2 class="text-lg font-semibold">{component.name}</h2>
          <code class="text-xs text-muted">{component.id} · v{component.version}</code>
        </div>
        {#if component.preview}
          <figure>
            <img
              src="/motion-previews/{component.preview.image}"
              alt="Aperçu rendu de {component.name} à {component.preview.frameAtSeconds} s"
              class="aspect-video w-full rounded-lg border border-line object-cover"
              loading="lazy"
            />
            <figcaption class="mt-1 text-xs text-muted">
              Rendu en {component.preview.renderSeconds} s ·
              <span data-testid="preview-check"
                >check {component.preview.check.ok ? 'sans erreur' : 'en erreur'}</span
              >{#if component.preview.check.errors.length}
                ({component.preview.check.errors.join(', ')}){/if}
              {#if component.preview.check.warnings.length}
                · avertissements : {component.preview.check.warnings.join(', ')}{/if}
            </figcaption>
          </figure>
        {/if}
        <p class="text-sm">{component.description}</p>
        <p class="text-xs text-muted">
          Durée {component.timing.minMs / 1000}–{component.timing.maxMs / 1000} s (défaut {component
            .timing.defaultMs / 1000} s) · capacités : {component.capabilities.join(', ')} · texte principal
          : <code>{component.primaryField}</code>
        </p>
        <div class="grid gap-3 text-xs sm:grid-cols-2">
          <div>
            <h3 class="mb-1 font-medium">Paramètres</h3>
            <ul class="space-y-0.5">
              {#each component.params as field (field.name)}
                <li>
                  <code>{field.name}</code>{field.required ? '' : ' (facultatif)'} ·
                  <span class="text-muted">{field.type} {field.detail}</span>
                </li>
              {/each}
            </ul>
          </div>
          <div>
            <h3 class="mb-1 font-medium">Style</h3>
            <ul class="space-y-0.5">
              {#each component.style as field (field.name)}
                <li><code>{field.name}</code> · <span class="text-muted">{field.detail}</span></li>
              {/each}
            </ul>
          </div>
        </div>
        <details class="text-xs">
          <summary class="cursor-pointer">Exemple de paramètres</summary>
          <pre class="mt-1 overflow-x-auto text-muted">{component.example}</pre>
        </details>
      </li>
    {/each}
  </ul>
</div>
