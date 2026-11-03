import { createReadStream, existsSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { Readable } from 'node:stream';
import { error } from '@sveltejs/kit';
import { safePath } from '@veyra/storage';
import type { VideoRevision } from '@veyra/schemas';

export type MediaFile = 'main' | 'clean' | 'srt' | 'vtt';
const types: Record<MediaFile, { contentType: string; ext: string; suffix: string }> = {
  main: { contentType: 'video/mp4', ext: 'mp4', suffix: '' },
  clean: { contentType: 'video/mp4', ext: 'mp4', suffix: '-sans-sous-titres' },
  srt: { contentType: 'application/x-subrip', ext: 'srt', suffix: '' },
  vtt: { contentType: 'text/vtt', ext: 'vtt', suffix: '' }
};

/**
 * Stored path of one deliverable: the main video, or a path from the delivery recorded
 * by the render job that produced revision.videoPath. Null when absent.
 */
export function mediaPath(
  revision: Pick<VideoRevision, 'videoPath'>,
  jobs: { outputPath: string | null; resolvedConfig: Record<string, unknown> }[],
  file: MediaFile
): string | null {
  if (!revision.videoPath) return null;
  if (file === 'main') return revision.videoPath;
  const job = jobs.find((j) => j.outputPath === revision.videoPath);
  const delivery = job?.resolvedConfig.delivery as Record<string, unknown> | undefined;
  const path = delivery?.[file];
  return typeof path === 'string' ? path : null;
}

/** Streams a stored file confined to the projects root, with byte ranges. */
export function serveMedia(
  root: string,
  stored: string | null,
  file: MediaFile,
  revision: Pick<VideoRevision, 'id' | 'status'>,
  request: Request,
  download: boolean
): Response {
  if (!stored) error(404, 'Fichier absent pour cette révision');
  if (download && revision.status !== 'approved')
    error(409, 'Export réservé aux révisions validées');
  // Re-check containment: the stored path must stay inside the projects root.
  if (!stored.startsWith(root + '/')) error(403, 'Chemin refusé');
  const path = safePath(root, relative(root, stored));
  if (!existsSync(path)) error(404, 'Fichier absent pour cette révision');
  const size = statSync(path).size;
  const type = types[file];
  const headers = new Headers({
    'content-type': type.contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600'
  });
  if (download)
    headers.set(
      'content-disposition',
      `attachment; filename="veyra-${revision.id}${type.suffix}.${type.ext}"`
    );
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
}
