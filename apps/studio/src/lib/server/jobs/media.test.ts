import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mediaPath, serveMedia } from './media';

let root: string, outside: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'veyra-media-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'veyra-outside-')));
  mkdirSync(join(root, 'r'));
  writeFileSync(join(root, 'r/rnd_a.mp4'), 'video');
  writeFileSync(join(root, 'r/rnd_a.srt'), '1\n00:00:00,000 --> 00:00:01,000\nHi\n');
  writeFileSync(join(outside, 'x.vtt'), 'WEBVTT\n');
});
afterEach(() => [root, outside].forEach((d) => rmSync(d, { recursive: true, force: true })));
const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { status?: number }).status;
  }
  return 200;
};

it('resolves deliverables from the job that produced the main video', () => {
  const revision = { videoPath: join(root, 'r/rnd_a.mp4') };
  const jobs = [
    { outputPath: join(root, 'r/rnd_old.mp4'), resolvedConfig: { delivery: { srt: 'old' } } },
    {
      outputPath: revision.videoPath,
      resolvedConfig: { delivery: { srt: join(root, 'r/rnd_a.srt') } }
    }
  ];
  expect(mediaPath(revision, jobs, 'main')).toBe(revision.videoPath);
  expect(mediaPath(revision, jobs, 'srt')).toBe(join(root, 'r/rnd_a.srt'));
  expect(mediaPath(revision, jobs, 'clean')).toBeNull();
  expect(mediaPath({ videoPath: null }, jobs, 'srt')).toBeNull();
});

it('serves sidecars with their type and attachment, confined to the root', async () => {
  const approved = { id: 'rev_a', status: 'approved' as const };
  const request = new Request('http://x/');
  const srt = serveMedia(root, join(root, 'r/rnd_a.srt'), 'srt', approved, request, true);
  expect(srt.headers.get('content-type')).toBe('application/x-subrip');
  expect(srt.headers.get('content-disposition')).toBe('attachment; filename="veyra-rev_a.srt"');
  expect(await srt.text()).toContain('Hi');
  expect(
    serveMedia(root, join(root, 'r/rnd_a.mp4'), 'clean', approved, request, true).headers.get(
      'content-disposition'
    )
  ).toBe('attachment; filename="veyra-rev_a-sans-sous-titres.mp4"');
  expect(status(() => serveMedia(root, null, 'vtt', approved, request, true))).toBe(404);
  expect(
    status(() => serveMedia(root, join(root, 'r/none.vtt'), 'vtt', approved, request, false))
  ).toBe(404);
  expect(
    status(() => serveMedia(root, join(outside, 'x.vtt'), 'vtt', approved, request, false))
  ).toBe(403);
  expect(
    status(() => serveMedia(root, join(root, 'r/../../x.vtt'), 'vtt', approved, request, false))
  ).not.toBe(200);
  const draft = { id: 'rev_a', status: 'qa' as const };
  expect(
    status(() => serveMedia(root, join(root, 'r/rnd_a.srt'), 'srt', draft, request, true))
  ).toBe(409);
  const vtt = serveMedia(root, join(root, 'r/rnd_a.srt'), 'vtt', draft, request, false);
  expect(vtt.headers.get('content-type')).toBe('text/vtt');
  expect(vtt.headers.get('content-disposition')).toBeNull();
});
