import { error } from '@sveltejs/kit';
import { repo, storage } from '#lib/server/jobs/index.ts';
import { mediaPath, serveMedia } from '#lib/server/jobs/media.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, request, url }) => {
  let revision;
  try {
    revision = repo.getRevision(params.revisionId);
  } catch {
    error(404, 'Révision introuvable');
  }
  if (!revision.videoPath) error(404, 'Aucune vidéo pour cette révision');
  const variant = url.searchParams.get('variant');
  if (variant !== null && variant !== 'clean') error(400, 'Variante inconnue');
  const file = variant === 'clean' ? 'clean' : 'main';
  const stored =
    file === 'main'
      ? revision.videoPath
      : mediaPath(revision, repo.renderJobsFor([revision.id]), file);
  return serveMedia(
    storage.root,
    stored,
    file,
    revision,
    request,
    url.searchParams.has('download')
  );
};
