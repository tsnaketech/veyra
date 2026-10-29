import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStorage } from '@veyra/storage';
import { runProcess } from '@veyra/video';
import { detectOnsets } from '@veyra/audio';
import {
  FakeAiProvider,
  revisionProposalSchema,
  type AiProvider,
  type RevisionProposalInput
} from '@veyra/ai';
import type { Storyboard } from '@veyra/schemas';
import { createRepository } from './db/repo';
import * as schema from './db/schema';
import { defaultConfigDir, loadRenderSettings, RenderJobRunner } from './jobs/runner';
import { loadStudioSettings, Studio } from './studio';
import { colorEngine } from './test-engines';

vi.setConfig({ testTimeout: 180_000 });
const saas =
  'Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.';
let client: Database.Database, root: string, fixtures: string;
let repo: ReturnType<typeof createRepository>;
let renders = 0;

/** Generates a short WAV with ffmpeg's lavfi sources (no third-party media). */
async function wav(name: string, source: string, seconds: number) {
  const path = join(fixtures, name);
  await runProcess('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    source,
    '-t',
    String(seconds),
    '-ar',
    '48000',
    '-ac',
    '2',
    path
  ]);
  return { path, file: new File([readFileSync(path)], name, { type: 'audio/wav' }) };
}
function scripted(plan: (board: Storyboard, ids: string[]) => RevisionProposalInput): AiProvider {
  const base = new FakeAiProvider();
  return {
    kind: 'fake',
    mode: 'direct',
    generateStoryboard: (...args) => base.generateStoryboard(...args),
    reviewFrames: (...args) => base.reviewFrames(...args),
    planRevision: async (board, feedback) =>
      revisionProposalSchema.parse(
        plan(
          board,
          feedback.map((f) => f.id)
        )
      ),
    qualityEvaluator: () => base.qualityEvaluator()
  };
}
function studio(ai: AiProvider = new FakeAiProvider()): Studio {
  const settings = loadStudioSettings(loadRenderSettings(), defaultConfigDir());
  const storage = new ProjectStorage(root);
  const engine = colorEngine((id) => repo.getRevision(id).storyboard);
  const counted = {
    ...engine,
    render: (...args: Parameters<typeof engine.render>) => (renders++, engine.render(...args))
  };
  const runner: RenderJobRunner = new RenderJobRunner(repo, storage, counted, settings);
  return new Studio(repo, runner, ai, settings, storage);
}
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 900 && !condition(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(condition()).toBe(true);
};
const streams = async (path: string) =>
  JSON.parse(
    (
      await runProcess('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name,sample_rate,channels:format=duration',
        '-of',
        'json',
        path
      ])
    ).stdout
  ) as {
    streams: { codec_type: string; codec_name: string; sample_rate?: string; channels?: number }[];
    format: { duration: string };
  };
const track = (id: string, assetId: string, extra: Record<string, unknown>) => ({
  id,
  assetId,
  label: id,
  ...extra
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'veyra-audio-'));
  fixtures = mkdtempSync(join(tmpdir(), 'veyra-audio-fx-'));
  client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  repo = createRepository(db);
  renders = 0;
});
afterEach(() => {
  client.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(fixtures, { recursive: true, force: true });
});

it('adds a synchronised soundtrack to an existing video without re-rendering the picture', async () => {
  const app = studio();
  const project = app.createProject('Son');
  await app.sendPrompt(project.id, saas);
  const [v1] = repo.listRevisions(project.id);
  const before = structuredClone(v1);
  expect(renders).toBe(1);

  const music = await wav('music.wav', 'sine=frequency=220:sample_rate=48000', 3);
  const pop = await wav('pop.wav', 'sine=frequency=1200:sample_rate=48000', 0.08);
  const musicAsset = await app.importAudio(
    project.id,
    music.file,
    new Uint8Array(readFileSync(music.path)),
    'music'
  );
  const popAsset = await app.importAudio(
    project.id,
    pop.file,
    new Uint8Array(readFileSync(pop.path)),
    'sfx'
  );
  expect(musicAsset.audio).toMatchObject({ status: 'valid', metadata: { sampleRate: 48000 } });
  const cards = v1.storyboard.scenes.find((s) => s.component?.id === 'feature-cards')!;
  await app.reviseAudio(v1.id, {
    schemaVersion: 1,
    tracks: [
      track('atr_music', musicAsset.id, {
        category: 'music',
        anchor: { type: 'absolute', atMs: 0 },
        loop: true,
        gainDb: -18,
        fadeInMs: 500,
        fadeOutMs: 1000
      }),
      ...[0, 2].map((index) =>
        track(`atr_pop-${index}`, popAsset.id, {
          category: 'sfx',
          anchor: { type: 'event', sceneId: cards.id, event: 'card-appear', index, offsetMs: 0 }
        })
      )
    ]
  });
  const v2 = repo.listRevisions(project.id).at(-1)!;
  expect(v2).toMatchObject({ parentRevisionId: v1.id, status: 'awaiting_approval' });
  expect(renders).toBe(1); // picture reused, only the sound was mixed
  const probe = await streams(v2.videoPath!);
  expect(probe.streams.map((s) => s.codec_type).sort()).toEqual(['audio', 'video']);
  expect(probe.streams.find((s) => s.codec_type === 'audio')).toMatchObject({
    codec_name: 'aac',
    sample_rate: '48000',
    channels: 2
  });
  expect(Math.abs(Number(probe.format.duration) - 20)).toBeLessThan(0.1);
  const job = repo.renderJobsFor([v2.id]).at(-1)!;
  expect(job.resolvedConfig).toMatchObject({ videoReusedFrom: v1.id });
  const resolved = (job.resolvedConfig as { audio: { tracks: unknown[]; issues: unknown[] } })
    .audio;
  expect(resolved.tracks).toHaveLength(3);
  expect(resolved.issues).toEqual([]);
  const checks = repo.reportsFor([v2.id]).at(-1)!.checks;
  expect(checks.find((c) => c.name === 'Pistes audio attendues')?.passed).toBe(true);
  expect(checks.find((c) => c.name === 'Synchronisation audio')?.passed).toBe(true);
  // The original revision is untouched apart from its review status.
  const after = repo.getRevision(v1.id);
  expect(after).toMatchObject({
    status: 'changes_requested',
    storyboard: before.storyboard,
    videoPath: before.videoPath,
    audio: null
  });
});

it('moves an event-anchored sound with its scene after a motion correction', async () => {
  const app = studio(
    scripted((board, [id]) => ({
      summary: 'longer title',
      changes: [
        {
          feedbackId: id,
          sceneId: board.scenes[0].id,
          instruction: 'x',
          patch: { durationMs: 5000 }
        }
      ],
      conflicts: []
    }))
  );
  const project = app.createProject('Sync');
  await app.sendPrompt(project.id, saas);
  const [v1] = repo.listRevisions(project.id);
  const pop = await wav('pop.wav', 'sine=frequency=1200:sample_rate=48000', 0.08);
  const asset = await app.importAudio(
    project.id,
    pop.file,
    new Uint8Array(readFileSync(pop.path)),
    'sfx'
  );
  const cards = v1.storyboard.scenes.find((s) => s.component?.id === 'feature-cards')!;
  await app.reviseAudio(v1.id, {
    schemaVersion: 1,
    tracks: [
      track('atr_pop', asset.id, {
        category: 'sfx',
        anchor: { type: 'event', sceneId: cards.id, event: 'card-appear', index: 1, offsetMs: 0 }
      })
    ]
  });
  const v2 = repo.listRevisions(project.id).at(-1)!;
  const [first] = await detectOnsets(v2.videoPath!, { noiseDb: -40, minSilenceMs: 200 });

  const comment = await app.addAnnotation({
    revisionId: v2.id,
    frameIndex: 30,
    text: 'Titre plus long',
    author: 'u'
  });
  const batch = app.submitBatch({
    revisionId: v2.id,
    feedbackIds: [comment.id],
    submissionKey: `key-${crypto.randomUUID()}`
  });
  await until(() => repo.getBatch(batch.id).status === 'planned');
  await app.applyPlan(repo.getBatch(batch.id).planId!);
  const v3 = repo.listRevisions(project.id).at(-1)!;
  expect(v3.audio).toEqual(v2.audio); // soundtrack carried by the correction
  const [moved] = await detectOnsets(v3.videoPath!, { noiseDb: -40, minSilenceMs: 200 });
  expect(Math.abs(moved - first - 1000)).toBeLessThanOrEqual(40);
});

it('refuses invalid audio, and reports a missing file without failing the render', async () => {
  const app = studio();
  const project = app.createProject('Erreurs');
  await app.sendPrompt(project.id, saas);
  const [v1] = repo.listRevisions(project.id);
  const bad = new TextEncoder().encode('ceci n’est pas un fichier audio');
  const invalid = await app.importAudio(project.id, new File([bad], 'faux.wav'), bad, 'sfx');
  expect(invalid.audio).toMatchObject({ status: 'invalid', metadata: null });
  expect(invalid.audio!.error).toMatch(/[éa-z]/);
  const composition = (assetId: string) => ({
    schemaVersion: 1,
    tracks: [track('atr_x', assetId, { category: 'sfx', anchor: { type: 'absolute', atMs: 1000 } })]
  });
  expect(() => app.reviseAudio(v1.id, composition(invalid.id))).toThrow(/absent ou refusé/);

  const pop = await wav('pop.wav', 'sine=frequency=1200:sample_rate=48000', 0.08);
  const asset = await app.importAudio(
    project.id,
    pop.file,
    new Uint8Array(readFileSync(pop.path)),
    'sfx'
  );
  const done = app.reviseAudio(v1.id, composition(asset.id));
  rmSync(asset.path); // disappears before the queued render runs
  await done;
  const v2 = repo.listRevisions(project.id).at(-1)!;
  expect(v2.status).toBe('awaiting_approval');
  const placed = repo
    .reportsFor([v2.id])
    .at(-1)!
    .checks.find((c) => c.name === 'Pistes audio attendues')!;
  expect(placed).toMatchObject({ passed: false, severity: 'major' });
  expect(placed.evidence).toMatch(/asset-missing/);
});

it('stores comments on a time range and an audio track, rejecting inverted ranges', async () => {
  const app = studio();
  const project = app.createProject('Plages');
  await app.sendPrompt(project.id, saas);
  const [v1] = repo.listRevisions(project.id);
  const base = {
    projectId: project.id,
    revisionId: v1.id,
    sceneId: null,
    text: 'Entre 00:08 et 00:12, diminue la musique',
    author: 'u',
    createdAt: 1,
    updatedAt: 1
  };
  expect(() =>
    repo.createFeedback({ ...base, id: 'fdb_bad', timestampMs: 12000, rangeEndMs: 8000 })
  ).toThrow(/Fin de plage/);
  const row = repo.createFeedback({
    ...base,
    id: 'fdb_range',
    timestampMs: 8000,
    rangeEndMs: 12000,
    audioTrackId: 'atr_music'
  });
  expect(repo.getFeedback(row.id)).toMatchObject({ rangeEndMs: 12000, audioTrackId: 'atr_music' });
});
