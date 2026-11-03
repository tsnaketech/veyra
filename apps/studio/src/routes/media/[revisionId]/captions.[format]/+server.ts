import { error } from '@sveltejs/kit';
import { repo, storage } from '#lib/server/jobs/index.ts';
import { mediaPath, serveMedia } from '#lib/server/jobs/media.ts';
import type { RequestHandler } from './$types';

/** captions.srt / captions.vtt exported from the measured video (render job delivery). */
export const GET: RequestHandler = ({ params, request, url }) => {
  if (params.format !== 'srt' && params.format !== 'vtt') error(404, 'Format inconnu');
  let revision;
  try {
    revision = repo.getRevision(params.revisionId);
  } catch {
    error(404, 'Révision introuvable');
  }
  const stored = mediaPath(revision, repo.renderJobsFor([revision.id]), params.format);
  return serveMedia(
    storage.root,
    stored,
    params.format,
    revision,
    request,
    url.searchParams.has('download')
  );
};
