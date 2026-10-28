import { createReadStream, statSync } from 'node:fs';
import { relative } from 'node:path';
import { Readable } from 'node:stream';
import { error } from '@sveltejs/kit';
import { safePath } from '@veyra/storage';
import { repo, storage } from '#lib/server/jobs/index.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, request, url }) => {
  let revision;
  try {
    revision = repo.getRevision(params.revisionId);
  } catch {
    error(404, 'Révision introuvable');
  }
  if (!revision.videoPath) error(404, 'Aucune vidéo pour cette révision');
  const download = url.searchParams.has('download');
  if (download && revision.status !== 'approved')
    error(409, 'Export réservé aux révisions validées');
  // Re-check containment: the stored path must stay inside the projects root.
  if (!revision.videoPath.startsWith(storage.root + '/')) error(403, 'Chemin refusé');
  const path = safePath(storage.root, relative(storage.root, revision.videoPath));
  const size = statSync(path).size;
  const headers = new Headers({
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600'
  });
  if (download)
    headers.set('content-disposition', `attachment; filename="veyra-${revision.id}.mp4"`);
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      headers.set('content-range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('content-range', `bytes ${start}-${end}/${size}`);
    headers.set('content-length', String(end - start + 1));
    const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return new Response(body, { status: 206, headers });
  }
  headers.set('content-length', String(size));
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers });
};
