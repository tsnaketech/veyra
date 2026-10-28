import { fail, redirect } from '@sveltejs/kit';
import { repo, studio } from '#lib/server/jobs/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
  const projects = repo.listProjects().map((project) => {
    const revisions = repo.listRevisions(project.id);
    const latest = revisions.at(-1);
    return {
      id: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
      revisions: revisions.length,
      status: latest?.status ?? null,
      busy: studio.activityFor(project.id)?.stage ?? null
    };
  });
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const activity = repo.recentJobs(8).map(({ job, projectId }) => ({
    id: job.id,
    projectId,
    project: names.get(projectId) ?? projectId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    updatedAt: job.updatedAt
  }));
  return { projects, activity };
};

export const actions: Actions = {
  create: async ({ request }) => {
    const name = String((await request.formData()).get('name') ?? '');
    if (!name.trim()) return fail(400, { error: 'Donnez un nom au projet.' });
    const project = studio.createProject(name);
    redirect(303, `/projects/${project.id}`);
  }
};
