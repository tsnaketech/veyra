import { readFileSync } from 'node:fs';
import { error } from '@sveltejs/kit';
import { safePath } from '@veyra/storage';
import { repo, storage } from '#lib/server/jobs/index.ts';
import type { RequestHandler } from './$types';

/** Evidence image of an expert QA pack (exact frame of one of the two renders). */
export const GET: RequestHandler = ({ params }) => {
  if (!/^[A-Za-z0-9_-]+\.png$/.test(params.file)) error(400, 'Nom refusé');
  let evaluation;
  try {
    evaluation = repo.getEvaluation(params.evaluationId);
  } catch {
    error(404, 'Évaluation introuvable');
  }
  let path;
  try {
    path = safePath(
      storage.root,
      evaluation.projectId,
      'revisions',
      evaluation.revisionId,
      'qa-expert',
      evaluation.id,
      params.file
    );
    return new Response(readFileSync(path), {
      headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' }
    });
  } catch {
    error(404, 'Image indisponible');
  }
};
