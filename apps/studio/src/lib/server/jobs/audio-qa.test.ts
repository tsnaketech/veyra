import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '@veyra/video';
import { audioCompositionSchema, qualityCheckSchema } from '@veyra/schemas';
import type { ResolvedTrack } from '@veyra/audio';
import { loadRenderSettings } from './runner';
import { audioQualityChecks } from './audio-qa';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
let root: string;
const settings = loadRenderSettings().audio;
const composition = audioCompositionSchema.parse({
  schemaVersion: 1,
  tracks: [
    {
      id: 'atr_cue',
      assetId: 'ast_cue',
      category: 'sfx',
      label: 'Effet',
      anchor: { type: 'event', sceneId: 'scn_a', event: 'scene', index: 0, offsetMs: 0 }
    }
  ]
});
const track = (startMs = 0, playMs = 3000): ResolvedTrack => ({
  trackId: 'atr_cue',
  category: 'sfx',
  assetPath: '/unused',
  startMs,
  playMs,
  sourceInMs: 0,
  gainDb: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
  loop: false,
  duck: []
});
async function media(
  name: string,
  filter = 'anull',
  wav = false,
  source = 'sine=frequency=440:sample_rate=48000:duration=3'
) {
  const path = join(root, name);
  await runProcess('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    source,
    ...(wav ? [] : ['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25:d=3']),
    '-af',
    filter,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    wav ? 'pcm_s16le' : 'aac',
    ...(wav ? [] : ['-c:v', 'libx264', '-preset', 'ultrafast']),
    path
  ]);
  return path;
}
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'veyra-audio-qa-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const get = (checks: Awaited<ReturnType<typeof audioQualityChecks>>, name: string) =>
  checks.find((c) => c.name === name)!;

it('measures AAC stream, duration, peaks, loudness and explicitly does not listen', async () => {
  const path = await media('good.mp4');
  const checks = await audioQualityChecks(path, 3000, composition, [track()], settings);
  expect(get(checks, 'Flux audio')).toMatchObject({ passed: true, analysisMode: 'deterministic' });
  expect(get(checks, 'Durée audio').passed).toBe(true);
  expect(get(checks, 'Écrêtage').passed).toBe(true);
  expect(get(checks, 'Niveau sonore').passed).toBe(false);
  expect(get(checks, 'Niveau sonore').evidence).toContain('LUFS');
  expect(get(checks, 'Écoute qualitative')).toMatchObject({
    passed: false,
    analysisMode: 'not-performed'
  });
  const louder = await media('louder.mp4', 'volume=6dB');
  expect(
    get(await audioQualityChecks(louder, 3000, composition, [track()], settings), 'Niveau sonore')
      .passed
  ).toBe(true);
});
it('fails stream format and duration with measured evidence', async () => {
  const path = await media('pcm.wav', 'anull', true);
  const checks = await audioQualityChecks(path, 2000, composition, [track()], settings);
  expect(get(checks, 'Flux audio')).toMatchObject({ passed: false, severity: 'major' });
  expect(get(checks, 'Flux audio').evidence).toContain('pcm_s16le');
  expect(get(checks, 'Durée audio')).toMatchObject({ passed: false, severity: 'major' });
});
it('detects clipping on a saturated sine', async () => {
  const path = await media('clipped.wav', 'pan=stereo|c0=c0|c1=c0,volume=20dB', true);
  const check = get(
    await audioQualityChecks(path, 3000, composition, [track()], settings),
    'Écrêtage'
  );
  expect(check).toMatchObject({ passed: false, severity: 'major', analysisMode: 'deterministic' });
});
it('reports a silence gap only where audio is expected', async () => {
  const path = await media('gap.mp4', "volume=0:enable='between(t,1,2)'");
  const checks = await audioQualityChecks(path, 3000, composition, [track()], settings);
  expect(get(checks, 'Silences inattendus')).toMatchObject({ passed: false, severity: 'minor' });
  const outside = await audioQualityChecks(
    path,
    3000,
    composition,
    [track(0, 900), { ...track(2100, 900), trackId: 'atr_end' }],
    settings
  );
  expect(get(outside, 'Silences inattendus').passed).toBe(true);
  const silent = await media('silence.wav', 'anull', true, 'anullsrc=r=48000:cl=stereo:d=3');
  expect(
    get(
      await audioQualityChecks(silent, 3000, composition, [track()], settings),
      'Silences inattendus'
    ).passed
  ).toBe(false);
});
it('measures isolated event onsets, detects offset and abstains over a music bed', async () => {
  const path = await media(
    'cue.mp4',
    'adelay=1000|1000,apad,atrim=duration=3',
    false,
    'sine=frequency=1200:sample_rate=48000:duration=0.1'
  );
  const onTime = await audioQualityChecks(path, 3000, composition, [track(1000, 100)], settings);
  expect(get(onTime, 'Synchronisation audio — onsets').passed).toBe(true);
  const late = await audioQualityChecks(path, 3000, composition, [track(700, 100)], settings);
  expect(get(late, 'Synchronisation audio — onsets')).toMatchObject({
    passed: false,
    severity: 'minor'
  });
  const masked = await audioQualityChecks(
    path,
    3000,
    composition,
    [track(1000, 100), { ...track(), trackId: 'atr_music', category: 'music' }],
    settings
  );
  expect(get(masked, 'Synchronisation audio — onsets masqués')).toMatchObject({
    passed: false,
    analysisMode: 'not-performed'
  });
  expect(masked.some((c) => c.name === 'Synchronisation audio — onsets')).toBe(false);
});
it('reports unmeasurable media as a failed stream and never as passed checks', async () => {
  const good = await media('whole.mp4');
  const broken = join(root, 'truncated.mp4');
  // Real MP4 cut in half: the moov atom is gone, so FFmpeg cannot read it.
  const bytes = readFileSync(good);
  writeFileSync(broken, bytes.subarray(0, bytes.length >> 1));
  const checks = await audioQualityChecks(broken, 3000, composition, [track()], settings);
  expect(get(checks, 'Flux audio')).toMatchObject({
    passed: false,
    severity: 'major',
    analysisMode: 'deterministic'
  });
  for (const name of ['Durée audio', 'Écrêtage', 'Niveau sonore', 'Écoute qualitative'])
    expect(get(checks, name)).toMatchObject({ passed: false, analysisMode: 'not-performed' });
  for (const c of checks) expect(qualityCheckSchema.safeParse(c).success).toBe(true);
  expect(qualityCheckSchema.safeParse({ ...checks[0], passed: true }).success).toBe(false);
  // Configured wall-clock limit reaches the FFmpeg measurement processes.
  const bounded = await audioQualityChecks(good, 3000, composition, [track()], {
    ...settings,
    timeoutMs: 1
  });
  expect(get(bounded, 'Flux audio')).toMatchObject({ passed: false, severity: 'major' });
});
it('does not add audio checks for an empty composition', async () => {
  expect(
    await audioQualityChecks(
      '/absent',
      3000,
      audioCompositionSchema.parse({ schemaVersion: 1, tracks: [] }),
      [],
      settings
    )
  ).toEqual([]);
});
