<script lang="ts">
  import { enhance } from '$app/forms';
  import { resolve } from '$app/paths';
  import StatusBadge from '#lib/components/StatusBadge.svelte';
  import { dateTime } from '#lib/ui.ts';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const jobLabels: Record<string, string> = {
    queued: 'En file',
    running: 'En cours',
    succeeded: 'Terminé',
    failed: 'Échec',
    cancelled: 'Annulé'
  };
</script>

<div class="mx-auto grid w-full max-w-6xl gap-6 p-4 md:grid-cols-[2fr_1fr] md:p-8">
  <section aria-labelledby="projects-title" class="space-y-4">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <h1 id="projects-title" class="text-2xl font-semibold">Projets</h1>
      <form method="POST" action="?/create" use:enhance class="flex gap-2">
        <label class="sr-only" for="project-name">Nom du projet</label>
        <input
          id="project-name"
          name="name"
          class="field w-56"
          placeholder="Nom du projet"
          required
        />
        <button class="btn btn-primary">Nouveau projet</button>
      </form>
    </div>
    {#if form?.error}<p role="alert" class="text-sm text-bad">{form.error}</p>{/if}

    {#if data.projects.length === 0}
      <div class="panel p-8 text-center text-muted" data-testid="empty-projects">
        <p class="text-ink">Aucun projet pour l’instant.</p>
        <p class="mt-1 text-sm">Créez un projet, puis décrivez la vidéo souhaitée à Veyra.</p>
      </div>
    {:else}
      <ul class="grid gap-3 sm:grid-cols-2">
        {#each data.projects as project (project.id)}
          <li>
            <a
              href={resolve('/projects/[id]', { id: project.id })}
              class="panel block space-y-2 p-4 transition-colors hover:border-violet/60"
            >
              <span class="block font-medium">{project.name}</span>
              <span class="flex flex-wrap items-center gap-2 text-xs text-muted">
                <StatusBadge status={project.status} />
                {#if project.busy}<span class="badge border-cyan/50 text-cyan"
                    >Génération en cours</span
                  >{/if}
                <span>{project.revisions} révision(s)</span>
                <span>· {dateTime(project.updatedAt)}</span>
              </span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section aria-labelledby="activity-title" class="panel h-fit p-4">
    <h2 id="activity-title" class="mb-3 font-medium">Dernières activités</h2>
    {#if data.activity.length === 0}
      <p class="text-sm text-muted">Aucun rendu lancé.</p>
    {:else}
      <ul class="space-y-3 text-sm">
        {#each data.activity as job (job.id)}
          <li>
            <a href={resolve('/projects/[id]', { id: job.projectId })} class="hover:text-cyan"
              >{job.project}</a
            >
            <span class="block text-xs text-muted">
              Rendu {jobLabels[job.status]} · {job.stage} · {job.progress} % · {dateTime(
                job.updatedAt
              )}
            </span>
            {#if job.error}<span class="block text-xs text-bad">{job.error}</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>
