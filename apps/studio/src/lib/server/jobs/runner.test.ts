import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine, type RenderOptions, type RenderProgress } from '@veyra/hyperframes-adapter';
import { ProjectStorage } from '@veyra/storage';
import { createRepository } from '../db/repo';
import * as schema from '../db/schema';
import { loadRenderSettings, RenderJobRunner } from './runner';
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
