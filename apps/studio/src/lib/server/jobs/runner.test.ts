import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine, type RenderOptions, type RenderProgress } from '@veyra/hyperframes-adapter';
import { ProjectStorage } from '@veyra/storage';
import { createRepository } from '../db/repo';
import * as schema from '../db/schema';
import {
  captionTrackSchema,
  groupCaptions,
  quantizeCues,
  sceneFallbackWords,
  toSrt,
  toWebVtt
} from '@veyra/schemas';
import { CAPTION_EXPORT_CHECK_NAME, loadRenderSettings, RenderJobRunner } from './runner';
let client: Database.Database,
  root: string,
  repo: ReturnType<typeof createRepository>,
  db: ReturnType<typeof drizzle<typeof schema>>;
const metadata = {
  durationMs: 1000,
  width: 1920,
  height: 1080,
  fps: 30,
  codec: 'h264',
  audioStreams: [],
  size: 100,
  blackSegments: []
};
const board = {
  width: 1920,
  height: 1080,
  fps: 30,
  scenes: [{ id: 'scn_one', start: 0, duration: 1000, text: 'Test', animation: {} }]
};
function add(id: string) {
  repo.createRevision({
    id: `rev_${id}`,
    projectId: 'prj_one',
    storyboard: board,
    resolvedConfig: {},
    videoPath: null,
    error: null,
    createdAt: 1,
    updatedAt: 1
  });
  repo.createRenderJob({
    id: `rnd_${id}`,
    revisionId: `rev_${id}`,
    outputPath: null,
    error: null,
    createdAt: 1,
    updatedAt: 1
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'veyra-runner-'));
  client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  db = drizzle(client, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  repo = createRepository(db);
  repo.createProject({
    id: 'prj_one',
    name: 'Test',
    resolvedConfig: {},
    createdAt: 1,
    updatedAt: 1
  });
  add('one');
});
afterEach(() => {
  client.close();
  rmSync(root, { recursive: true, force: true });
});
it('serializes jobs, deduplicates enqueue, and persists progress and simulated QA', async () => {
  let active = 0,
    maxActive = 0;
  const stages: string[] = [];
  class ObservedFake extends FakeEngine {
    override async render(
      dir: string,
      options: RenderOptions,
      progress?: (value: RenderProgress) => void
    ) {
      active++;
      maxActive = Math.max(maxActive, active);
      expect(
        repo.getRenderJob(options.outputPath.includes('rnd_one') ? 'rnd_one' : 'rnd_two').status
      ).toBe('running');
      const result = await super.render(dir, options, (value) => {
        progress?.(value);
        stages.push(
          repo.getRenderJob(options.outputPath.includes('rnd_one') ? 'rnd_one' : 'rnd_two').stage
        );
      });
      active--;
      return result;
    }
  }
  add('two');
  const runner = new RenderJobRunner(
    repo,
    new ProjectStorage(root),
    new ObservedFake({ delayMs: 10, probe: metadata }),
    loadRenderSettings()
  );
  const first = runner.enqueue('rnd_one');
  expect(runner.enqueue('rnd_one')).toBe(first);
  const results = await Promise.all([first, runner.enqueue('rnd_two')]);
  expect(maxActive).toBe(1);
  expect(results.every((job) => job.status === 'succeeded' && job.progress === 100)).toBe(true);
  expect(stages).toEqual(['lint', 'encode', 'lint', 'encode']);
  expect(results[0].resolvedConfig).toHaveProperty('engineKind', 'fake-test-only');
  expect(readFileSync(results[0].outputPath!, 'utf8')).toContain('FAKE TEST ONLY');
  const reports = db.select().from(schema.qualityReports).all();
  expect(reports).toHaveLength(2);
  // The fake output is not a video: picture measurements (flashes, contrast) are not performed.
  expect(reports[0].report.analysisModes).toEqual(['not-performed', 'simulated']);
  expect(
    reports[0].report.checks
      .filter((c) => c.analysisMode === 'not-performed')
      .map((c) => c.name)
      .sort()
  ).toEqual(["Contraste mesuré sur l'image rendue", 'Photosensibilité (flashs, mesure technique)']);
  expect(repo.getRevision('rev_one').status).toBe('awaiting_approval');
  await expect(runner.enqueue('rnd_one')).rejects.toThrow('queued');
});
it('persists failure and stderr, and continues with the next queued job', async () => {
  const runner = new RenderJobRunner(
    repo,
    new ProjectStorage(root),
    new FakeEngine({ fail: true }),
    loadRenderSettings()
  );
  const job = await runner.enqueue('rnd_one');
  expect(job).toMatchObject({
    status: 'failed',
    stage: 'lint',
    progress: 9,
    error: 'FakeEngine test failure',
    stderrTail: 'fake-test-only: simulated stderr'
  });
  expect(repo.getRevision('rev_one').error).toBe('FakeEngine test failure');
  expect(repo.getRevision('rev_one').status).toBe('failed');
  add('two');
  expect((await runner.enqueue('rnd_two')).status).toBe('failed');
  expect(db.select().from(schema.qualityReports).all()).toHaveLength(0);
});
it('persists inspection failures instead of marking a job successful', async () => {
  const runner = new RenderJobRunner(
    repo,
    new ProjectStorage(root),
    new FakeEngine(),
    loadRenderSettings()
  );
  expect((await runner.enqueue('rnd_one')).status).toBe('failed');
  expect(repo.getRenderJob('rnd_one').error).toContain('explicit test probe');
});
it('rejects illegal or decreasing progress', () => {
  expect(() => repo.updateRenderProgress('rnd_one', 10, 'render')).toThrow('running');
  repo.transitionRenderJob('rnd_one', 'running');
  repo.updateRenderProgress('rnd_one', 50, 'render');
  expect(() => repo.updateRenderProgress('rnd_one', 49, 'render')).toThrow('decrease');
  expect(() => repo.updateRenderProgress('rnd_one', 101, 'render')).toThrow();
  expect(repo.getRenderJob('rnd_one').progress).toBe(50);
});
it('keeps failed QA findings visible for human review', async () => {
  const runner = new RenderJobRunner(
    repo,
    new ProjectStorage(root),
    new FakeEngine({ probe: { ...metadata, durationMs: 500 } }),
    loadRenderSettings()
  );
  expect((await runner.enqueue('rnd_one')).status).toBe('succeeded');
  expect(
    db
      .select()
      .from(schema.qualityReports)
      .get()
      ?.report.checks.some((check) => !check.passed)
  ).toBe(true);
  expect(repo.getRevision('rev_one').status).toBe('awaiting_approval');
});

// T114: caption delivery modes and sidecars quantized on the exported video.
const narrated = {
  ...board,
  scenes: [{ ...board.scenes[0], narration: { text: 'Bonjour à tous. Deux mots ici.' } }]
};
const track = captionTrackSchema.parse({
  schemaVersion: 1,
  id: 'cap_test',
  words: sceneFallbackWords(narrated.scenes),
  cues: groupCaptions(
    sceneFallbackWords(narrated.scenes),
    { maxLines: 2, maxCharsPerLine: 42 },
    { minDurationMs: 100, maxDurationMs: 7000, minGapMs: 0 }
  ),
  provenance: { provider: 'script' }
});
const measured = {
  ...metadata,
  frameRate: { num: 30, den: 1 },
  frameCount: 30,
  constantFrameRate: true
};
function addCaptioned(id: string, delivery?: string, parentRevisionId?: string) {
  repo.createRevision({
    id: `rev_${id}`,
    projectId: 'prj_one',
    parentRevisionId,
    storyboard: narrated,
    captions: track,
    resolvedConfig: delivery ? { captionDelivery: delivery } : {},
    videoPath: null,
    error: null,
    createdAt: 1,
    updatedAt: 1
  });
  repo.createRenderJob({
    id: `rnd_${id}`,
    revisionId: `rev_${id}`,
    outputPath: null,
    error: null,
    createdAt: 1,
    updatedAt: 1
  });
}
async function run(id: string, probe: object = measured) {
  const stages: string[] = [];
  const update = repo.updateRenderProgress;
  repo.updateRenderProgress = (job, progress, stage) => {
    stages.push(stage);
    update(job, progress, stage);
  };
  const composed: string[] = [];
  class Spy extends FakeEngine {
    override async render(
      dir: string,
      options: RenderOptions,
      progress?: (value: RenderProgress) => void
    ) {
      composed.push(readFileSync(join(dir, 'index.html'), 'utf8'));
      return super.render(dir, options, progress);
    }
  }
  const runner = new RenderJobRunner(
    repo,
    new ProjectStorage(root),
    new Spy({ probe: probe as typeof metadata }),
    loadRenderSettings()
  );
  const job = await runner.enqueue(`rnd_${id}`);
  repo.updateRenderProgress = update;
  const report = db
    .select()
    .from(schema.qualityReports)
    .all()
    .find((r) => r.report.revisionId === `rev_${id}`)!.report;
  const calage = report.checks.filter((c) => c.name === CAPTION_EXPORT_CHECK_NAME);
  return { job, stages, composed, calage, revision: repo.getRevision(`rev_${id}`) };
}
const renders = (id: string) =>
  readdirSync(join(root, 'prj_one/revisions', `rev_${id}`, 'renders')).sort();

it('keeps a revision without captions unchanged (no delivery, no sidecars)', async () => {
  repo.updateRevision('rev_one', { resolvedConfig: { captionDelivery: 'both' } });
  const { job, stages, composed, calage } = await run('one', metadata);
  expect(job.status).toBe('succeeded');
  expect(job.resolvedConfig).not.toHaveProperty('delivery');
  expect(stages).toEqual(['compose', 'check', 'lint', 'encode', 'qa']);
  expect(composed).toHaveLength(1);
  expect(composed[0]).not.toContain('class="clip cue');
  expect(calage).toEqual([]);
  expect(renders('one')).toEqual(['rnd_one.mp4', 'rnd_one.video.mp4']);
});

it.each([
  [undefined, ['rnd_cap.mp4', 'rnd_cap.srt', 'rnd_cap.video.mp4', 'rnd_cap.vtt'], [true]],
  [
    'clean',
    ['rnd_cap.clean.mp4', 'rnd_cap.clean.video.mp4', 'rnd_cap.srt', 'rnd_cap.vtt'],
    [false]
  ],
  [
    'both',
    [
      'rnd_cap.clean.mp4',
      'rnd_cap.clean.video.mp4',
      'rnd_cap.mp4',
      'rnd_cap.srt',
      'rnd_cap.video.mp4',
      'rnd_cap.vtt'
    ],
    [true, false]
  ]
])('delivers captions %s: files, steps, sidecars and calage check', async (mode, files, burned) => {
  addCaptioned('cap', mode);
  const { job, stages, composed, calage, revision } = await run('cap');
  expect(job.status).toBe('succeeded');
  expect(renders('cap')).toEqual(files);
  expect(composed.map((html) => html.includes('class="clip cue'))).toEqual(burned);
  const dir = join(root, 'prj_one/revisions/rev_cap/renders');
  const delivery = job.resolvedConfig.delivery as Record<string, string>;
  expect(delivery).toEqual({
    mode: mode ?? 'burned',
    ...(mode === 'clean' ? {} : { burned: join(dir, 'rnd_cap.mp4') }),
    ...(mode ? { clean: join(dir, 'rnd_cap.clean.mp4') } : {}),
    srt: join(dir, 'rnd_cap.srt'),
    vtt: join(dir, 'rnd_cap.vtt')
  });
  expect(revision.videoPath).toBe(
    join(dir, mode === 'clean' ? 'rnd_cap.clean.mp4' : 'rnd_cap.mp4')
  );
  expect(job.outputPath).toBe(revision.videoPath);
  expect(stages.slice(-2)).toEqual(['qa', 'export-captions']);
  if (mode === 'both') expect(stages).toContain('render-clean');
  const table = quantizeCues(track.cues, { num: 30, den: 1 }, 30);
  expect(readFileSync(delivery.srt, 'utf8')).toBe(toSrt(track, table));
  expect(readFileSync(delivery.vtt, 'utf8')).toBe(toWebVtt(track, table));
  expect(calage).toHaveLength(1);
  expect(calage[0]).toMatchObject({ passed: true, severity: 'info', analysisMode: 'simulated' });
  expect(calage[0].evidence).toContain(`"cues":${table.length}`);
});

it('fails the calage check (major) when the exported rate differs, with evidence', async () => {
  addCaptioned('cap');
  const { job, calage } = await run('cap', {
    ...measured,
    frameRate: { num: 25, den: 1 },
    frameCount: 25
  });
  expect(job.status).toBe('succeeded');
  expect(calage[0]).toMatchObject({ passed: false, severity: 'major' });
  const evidence = JSON.parse(calage[0].evidence.replace(/^FakeEngine test-only: /, ''));
  expect(evidence.cadence).toBe('25/1');
  expect(evidence.ecarts[0]).toMatchObject({ cueId: track.cues[0].id });
  // Sidecars follow the measured video, not the composition.
  const srt = readFileSync((job.resolvedConfig.delivery as Record<string, string>).srt, 'utf8');
  expect(srt).toBe(toSrt(track, quantizeCues(track.cues, { num: 25, den: 1 }, 25)));
});

it('marks the calage not-performed on VFR or unreadable rate', async () => {
  addCaptioned('cap');
  const vfr = await run('cap', { ...measured, constantFrameRate: false });
  expect(vfr.calage[0]).toMatchObject({ passed: false, analysisMode: 'not-performed' });
  expect(vfr.calage[0].evidence).toContain('cadence variable');
  addCaptioned('raw');
  const noRate = { ...measured, frameRate: undefined };
  const raw = await run('raw', noRate);
  expect(raw.calage[0]).toMatchObject({ analysisMode: 'not-performed' });
  expect(raw.job.resolvedConfig.delivery).not.toHaveProperty('srt');
  expect(renders('raw')).not.toContain('rnd_raw.srt');
});

it('reuses parent pictures: clean from a parent without captions, burned only with same captions', async () => {
  repo.updateRevision('rev_one', { storyboard: narrated });
  await run('one');
  addCaptioned('cap', 'both', 'rev_one');
  const child = await run('cap');
  expect(child.stages).toContain('reuse-clean');
  expect(child.composed).toHaveLength(1);
  expect(child.composed[0]).toContain('class="clip cue');
  expect(child.job.resolvedConfig.delivery).toMatchObject({ cleanReusedFrom: 'rev_one' });
  expect(child.job.resolvedConfig).not.toHaveProperty('videoReusedFrom');
  // Grandchild with the same captions: both pictures come from rev_cap.
  addCaptioned('again', 'both', 'rev_cap');
  const again = await run('again');
  expect(again.composed).toHaveLength(0);
  expect(again.job.resolvedConfig).toMatchObject({
    videoReusedFrom: 'rev_cap',
    delivery: { cleanReusedFrom: 'rev_cap' }
  });
  // A revision without captions never reuses a burned picture.
  repo.createRevision({
    id: 'rev_plain',
    projectId: 'prj_one',
    parentRevisionId: 'rev_again',
    storyboard: narrated,
    resolvedConfig: {},
    videoPath: null,
    error: null,
    createdAt: 1,
    updatedAt: 1
  });
  repo.createRenderJob({
    id: 'rnd_plain',
    revisionId: 'rev_plain',
    outputPath: null,
    error: null,
    createdAt: 1,
    updatedAt: 1
  });
  const plain = await run('plain');
  expect(plain.job.resolvedConfig).toMatchObject({ videoReusedFrom: 'rev_again' });
  expect(readFileSync(plain.revision.silentVideoPath!)).toEqual(
    readFileSync(join(root, 'prj_one/revisions/rev_again/renders/rnd_again.clean.video.mp4'))
  );
});
