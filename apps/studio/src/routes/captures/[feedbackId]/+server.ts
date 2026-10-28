import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { error } from '@sveltejs/kit';
import { safePath } from '@veyra/storage';
import { repo, storage } from '#lib/server/jobs/index.ts';
import type { RequestHandler } from './$types';

/** PNG of the exact frame an annotation points at. */
export const GET: RequestHandler = ({ params }) => {
  const item = repo.getFeedback(params.feedbackId);
  if (!item?.capturePath) error(404, 'Capture indisponible');
  // Re-check containment: the stored path must stay inside the projects root.
  if (!item.capturePath.startsWith(storage.root + '/')) error(403, 'Chemin refusé');
  const path = safePath(storage.root, relative(storage.root, item.capturePath));
  return new Response(readFileSync(path), {
    headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' }
  });
};
