import { afterAll, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStorage } from '@veyra/storage';
import { runProcess } from '@veyra/video';
import { captionBandRect, HyperFramesEngine } from '@veyra/hyperframes-adapter';
import { FakeAiProvider } from '@veyra/ai';
import {
  captionPrecisionSummary,
  firstFrameAtOrAfter,
  parseSrt,
  parseWebVtt,
  quantizeCues
} from '@veyra/schemas';
import { createRepository } from './db/repo';
import * as schema from './db/schema';
import {
  CAPTION_EXPORT_CHECK_NAME,
  CAPTION_PRECISION_CHECK_NAME,
  defaultConfigDir,
  loadRenderSettings,
  RenderJobRunner
} from './jobs/runner';
import { loadStudioSettings, Studio } from './studio';

// CA-2, CA-4, CA-6 end to end: real Studio service, real HyperFramesEngine (bwrap, Chrome
// headless), fake AI storyboard, no TTS/ASR engine. Revision dirs are bound into the sandbox,
// so a tmpdir storage root works as in the adapter slow tests and the E2E.
const root = mkdtempSync(join(tmpdir(), 'veyra-voice-slow-'));
const client = new Database(':memory:');
client.pragma('foreign_keys = ON');
const db = drizzle(client, { schema });
migrate(db, { migrationsFolder: './drizzle' });
const repo = createRepository(db);
afterAll(() => {
  client.close();
  rmSync(root, { recursive: true, force: true });
});

const settings = loadStudioSettings(loadRenderSettings(), defaultConfigDir());
const storage = new ProjectStorage(root);
const engine = new HyperFramesEngine(settings.engine);
const app = new Studio(
  repo,
  new RenderJobRunner(repo, storage, engine, settings),
  new FakeAiProvider(),
  settings,
  storage
);
const latest = (projectId: string) => repo.listRevisions(projectId).at(-1)!;
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const jobOf = (revisionId: string) => repo.renderJobsFor([revisionId]).at(-1)!;
type Delivery = { mode: string; burned?: string; clean?: string; srt?: string; vtt?: string };
const deliveryOf = (revisionId: string) =>
  (jobOf(revisionId).resolvedConfig as { delivery?: Delivery }).delivery;

/** A 440 Hz tone: a valid WAV, NOT French speech (no TTS/ASR engine is installed). */
async function tone(seconds: number) {
  const path = join(root, `tone-${seconds}.wav`);
  await runProcess('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    String(seconds),
    '-ac',
    '2',
    path
  ]);
  const data = new Uint8Array(readFileSync(path));
  return { file: new File([data], 'voix.wav', { type: 'audio/wav' }), data };
}

/** Caption region of every frame (sequential decode, half size), RGB. */
function decodeRegion(
  input: string,
  rect: { x: number; y: number; width: number; height: number }
) {
  const w = Math.floor(rect.width / 2),
    h = Math.floor(rect.height / 2);
  const { stdout, status, stderr } = spawnSync(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      input,
      '-vf',
      `crop=${rect.width}:${rect.height}:${rect.x}:${rect.y},scale=${w}:${h}`,
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-'
    ],
    { maxBuffer: 1024 * 1024 * 1024 }
  );
  if (status !== 0) throw new Error(stderr.toString());
  const size = w * h * 3;
  return Array.from({ length: stdout.length / size }, (_, i) =>
    stdout.subarray(i * size, (i + 1) * size)
  );
}
const meanDiff = (a: Buffer, b: Buffer) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};
async function audioStream(path: string) {
  const { stdout } = await runProcess('ffprobe', [
    '-v',
    'error',
    '-protocol_whitelist',
    'file',
    '-select_streams',
    'a',
    '-show_entries',
    'stream=codec_name,duration',
    '-of',
    'json',
    path
  ]);
  return (JSON.parse(stdout) as { streams: { codec_name: string; duration: string }[] }).streams;
}

it('voice + narration with delivery "both": burned/clean MP4s, frame-exact SRT/VTT, parents intact', async () => {
  const started = Date.now();
  const project = app.createProject('Voix réelle');
  await app.sendPrompt(
    project.id,
    'Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.'
  );
  const v1 = latest(project.id);
  expect(v1).toMatchObject({ status: 'awaiting_approval', error: null });
  const [s0, s1] = v1.storyboard.scenes;

  // Every finished revision is snapshotted (row minus review status, MP4 hash) for CA-4.
  const snapshots = new Map<string, { row: unknown; mp4: string }>();
  // Review status and its timestamp legitimately change when a child is created.
  const stable = (id: string) => ({ ...repo.getRevision(id), status: null, updatedAt: null });
  const snap = (id: string) => {
    const row = structuredClone(stable(id));
    snapshots.set(id, { row, mp4: sha(row.videoPath!) });
  };
  snap(v1.id);
  await app.setNarration(v1.id, s0.id, "L'équipe gagne 3 heures par semaine !");
  const v2 = latest(project.id);
  snap(v2.id);
  await app.setNarration(v2.id, s1.id, 'Pilot, c’est 2 fois moins de réunions : essayez-le.');
  const v3 = latest(project.id);
  snap(v3.id);
  const recorded = await tone(1.5);
  await app.importVoice(v3.id, s0.id, recorded.file, recorded.data);
  const v4 = latest(project.id);
  snap(v4.id);
  await app.generateVoice(v4.id, s1.id, 'fake');
  const v5 = latest(project.id);
  snap(v5.id);
  await app.setCaptionDelivery(v5.id, 'both');
  const v6 = latest(project.id);
  expect(v6).toMatchObject({ parentRevisionId: v5.id, status: 'awaiting_approval' });
  expect(v6.storyboard).toEqual(v3.storyboard);
  snap(v6.id);

  // CA-2: both MP4s and both sidecars exist.
  const delivery = deliveryOf(v6.id)!;
  expect(delivery).toMatchObject({ mode: 'both' });
  for (const key of ['burned', 'clean', 'srt', 'vtt'] as const)
    expect(existsSync(delivery[key]!)).toBe(true);
  expect(v6.videoPath).toBe(delivery.burned);
  const track = v6.captions!;
  expect(track.provenance.provider).toBe('script');
  expect(track.cues.length).toBeGreaterThanOrEqual(2);
  // Precision: every word is "scene" (approximate); surfaced in the conversation messages.
  expect(new Set(track.words.map((w) => w.timing))).toEqual(new Set(['scene']));
  expect(captionPrecisionSummary(track).approximateShare).toBe(1);
  expect(new Set(track.words.map((w) => w.sceneId))).toEqual(new Set([s0.id, s1.id]));
  expect(track.words.map((w) => w.text).join(' ')).toContain("L'équipe gagne 3 heures");
  const messages = repo.listMessages(repo.conversationFor(project.id)!.id).map((m) => m.text);
  expect(messages.filter((t) => /temps approximatifs/.test(t)).length).toBeGreaterThanOrEqual(4);

  // SRT/VTT parse back to the revision's cues quantized on the probed rate.
  const burned = await engine.inspect(delivery.burned!);
  const clean = await engine.inspect(delivery.clean!);
  expect(burned.constantFrameRate).toBe(true);
  expect(clean.frameRate).toEqual(burned.frameRate);
  expect(clean.frameCount).toBe(burned.frameCount);
  const rate = burned.frameRate!;
  const measured = quantizeCues(track.cues, rate, burned.frameCount!);
  const fromSrt = parseSrt(readFileSync(delivery.srt!, 'utf8'));
  expect(parseWebVtt(readFileSync(delivery.vtt!, 'utf8'))).toEqual(fromSrt);
  expect(fromSrt.map((c) => c.lines)).toEqual(
    measured.map((q) => track.cues.find((c) => c.id === q.cueId)!.lines)
  );
  // `+ 0` folds the -0 that Math.ceil returns for a cue at 0 ms (toEqual tells -0 from 0).
  const spans = fromSrt.map((c) => [
    firstFrameAtOrAfter(c.startMs, rate) + 0,
    firstFrameAtOrAfter(c.endMs, rate) + 0
  ]);
  expect(spans).toEqual(measured.map((q) => [q.startFrame, q.endFrame]));

  // Burned vs clean on the caption region: different exactly on the cue frames.
  const rect = captionBandRect(track.style, v6.storyboard, track.style.maxLines);
  const a = decodeRegion(delivery.burned!, rect),
    b = decodeRegion(delivery.clean!, rect);
  expect(a).toHaveLength(burned.frameCount!);
  expect(b).toHaveLength(burned.frameCount!);
  const shown = (f: number) => spans.some(([start, end]) => f >= start && f < end);
  const diffs = a.map((frame, f) => meanDiff(frame, b[f]));
  const inside = diffs.filter((_, f) => shown(f)),
    outside = diffs.filter((_, f) => !shown(f));
  console.info(
    `caption region ${JSON.stringify(rect)} @ ${rate.num}/${rate.den}, ${burned.frameCount} frames, cues ${JSON.stringify(spans)}: diff on cues min ${Math.min(...inside).toFixed(2)}, off cues max ${Math.max(...outside).toFixed(2)}`
  );
  // Thresholds: a box + white text vs encoder noise between two renders of the same scene.
  const PRESENT = 4,
    ABSENT = 1;
  expect(
    diffs.flatMap((d, f) => (shown(f) ? (d > PRESENT ? [] : [[f, d]]) : d < ABSENT ? [] : [[f, d]]))
  ).toEqual([]);
  for (const [start, end] of spans) {
    expect(diffs[start]).toBeGreaterThan(PRESENT);
    expect(diffs[end - 1]).toBeGreaterThan(PRESENT);
    if (start > 0 && !shown(start - 1)) expect(diffs[start - 1]).toBeLessThan(ABSENT);
    if (end < diffs.length && !shown(end)) expect(diffs[end]).toBeLessThan(ABSENT);
  }

  // AAC audio on both MP4s, as long as the video.
  for (const [path, probe] of [
    [delivery.burned!, burned],
    [delivery.clean!, clean]
  ] as const) {
    const streams = await audioStream(path);
    expect(streams.map((s) => s.codec_name)).toEqual(['aac']);
    console.info(
      `audio ${path.split('/').at(-1)}: ${streams[0].duration} s, video ${probe.durationMs / 1000} s`
    );
    expect(Math.abs(Number(streams[0].duration) * 1000 - probe.durationMs)).toBeLessThan(100);
  }

  // QA: export alignment check passed and deterministic.
  const report = repo.reportsFor([v6.id]).at(-1)!;
  const exportCheck = report.checks.find((c) => c.name === CAPTION_EXPORT_CHECK_NAME)!;
  expect(exportCheck).toMatchObject({ passed: true, analysisMode: 'deterministic' });
  expect(JSON.parse(exportCheck.evidence)).toMatchObject({
    cadence: `${rate.num}/${rate.den}`,
    frames: burned.frameCount,
    cues: track.cues.length
  });
  // CA-2: the QA report says the times are approximate (scene spread), as a minor finding.
  expect(report.checks.find((c) => c.name === CAPTION_PRECISION_CHECK_NAME)).toMatchObject({
    passed: false,
    severity: 'minor',
    analysisMode: 'deterministic'
  });

  // CA-6: replace the fake voice of scene 2 by an imported one.
  const comment = await app.addAnnotation({
    revisionId: v6.id,
    frameIndex: 30,
    text: 'Voix simulée à remplacer',
    author: 'u'
  });
  snap(v6.id);
  const exports = (['burned', 'clean', 'srt', 'vtt'] as const).map((key) => sha(delivery[key]!));
  const voice2 = await tone(1.2);
  await app.importVoice(v6.id, s1.id, voice2.file, voice2.data);
  const v7 = latest(project.id);
  expect(v7).toMatchObject({ parentRevisionId: v6.id, status: 'awaiting_approval' });
  expect(v7.storyboard).toEqual(v6.storyboard);
  expect(repo.getFeedback(comment.id)).toEqual(comment);
  const voices = v7.audio!.tracks.filter((t) => t.category === 'voiceover');
  expect(voices.map((t) => t.label).sort()).toEqual(['Voix scène 1', 'Voix scène 2']);
  expect(voices.find((t) => t.label === 'Voix scène 2')!.anchor).toMatchObject({
    type: 'event',
    sceneId: s1.id
  });
  const of = (t: typeof track, id: string) => t.words.filter((w) => w.sceneId === id);
  expect(of(v7.captions!, s0.id)).toEqual(of(track, s0.id));
  expect(of(v7.captions!, s1.id).map((w) => w.text)).toEqual(of(track, s1.id).map((w) => w.text));
  expect(of(v7.captions!, s1.id).every((w) => w.timing === 'scene')).toBe(true);
  expect(captionPrecisionSummary(v7.captions!).approximateShare).toBe(1);
  expect(deliveryOf(v7.id)).toMatchObject({ mode: 'both' });
  expect(
    repo
      .reportsFor([v7.id])
      .at(-1)!
      .checks.find((c) => c.name === CAPTION_EXPORT_CHECK_NAME)
  ).toMatchObject({ passed: true });

  // CA-4: every parent row (minus review status) and MP4 is unchanged.
  for (const [id, before] of snapshots) {
    const row = stable(id);
    expect(row).toEqual(before.row);
    expect(sha(row.videoPath!)).toBe(before.mp4);
  }
  expect((['burned', 'clean', 'srt', 'vtt'] as const).map((key) => sha(delivery[key]!))).toEqual(
    exports
  );
  console.info(`voice-captions slow test: ${((Date.now() - started) / 1000).toFixed(1)} s`);
}, 900_000);
