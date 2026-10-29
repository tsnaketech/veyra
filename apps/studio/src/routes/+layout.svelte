<script lang="ts">
  import './layout.css';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();
  const nav = [
    { href: resolve('/'), label: 'Projets' },
    { href: resolve('/components'), label: 'Composants' },
    { href: resolve('/settings'), label: 'Paramètres' }
  ];
</script>

<svelte:head>
  <link rel="icon" href="/brand/veyra-icone-couleur.svg" />
  <title>Veyra Studio</title>
</svelte:head>

<a href="#main" class="sr-only focus:not-sr-only focus:absolute focus:p-2">Aller au contenu</a>
<div class="flex min-h-dvh flex-col">
  <header class="flex items-center gap-6 border-b border-line px-4 py-2">
    <a href={resolve('/')} aria-label="Veyra — accueil">
      <img src="/brand/veyra-horizontal-couleur-fond-sombre.svg" alt="Veyra" class="h-8 w-auto" />
    </a>
    <nav aria-label="Navigation principale" class="flex gap-1 text-sm">
      {#each nav as item (item.href)}
        <a
          href={item.href}
          class="rounded-md px-3 py-1.5 text-muted hover:text-ink aria-[current=page]:bg-raised aria-[current=page]:text-ink"
          aria-current={page.url.pathname === item.href ? 'page' : undefined}>{item.label}</a
        >
      {/each}
    </nav>
  </header>
  <main id="main" class="flex min-h-0 flex-1 flex-col">
    {@render children()}
  </main>
</div>
