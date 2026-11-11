import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { FakeAiProvider } from '@veyra/ai';
import { ProjectStorage } from '@veyra/storage';
import { runProcess } from '@veyra/video';
import { setChildPathPrefixForTests } from '@veyra/video/testing';
import { newId, parseSrt, parseWebVtt, permissionClassSchema, quantizeCues } from '@veyra/schemas';
import { createRepository } from '../db/repo';
import * as schema from '../db/schema';
import { defaultConfigDir, loadRenderSettings, RenderJobRunner } from '../jobs/runner';
import { loadStudioSettings, Studio } from '../studio';
import { colorEngine } from '../test-engines';
import { studioToolRegistry } from './index';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * Tools on a real Studio service. The engine is colorEngine: real H.264 MP4s through real
 * ffmpeg, NOT HyperFrames (composition.check under HyperFrames is in tools.slow.test.ts).
 * ffmpeg/ffprobe run behind the recording shim of jobs/process-env.test.ts: the child's
 * environment is written to disk, then the real binary runs.
 */
const secrets = {
  ANTHROPIC_API_KEY: 'sk-test-should-not-leak',
  CLAUDE_CODE_MESSAGING_TOKEN: 'x-should-not-leak',
  MY_SERVICE_TOKEN: 'y-should-not-leak'
};
const all = permissionClassSchema.options;
const saas =
  'Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.';
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const realBinary = (name: string) =>
  (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => join(dir, name))
    .find((path) => existsSync(path))!;

let root: string, records: string, client: Database.Database;
let repo: ReturnType<typeof createRepository>;
let app: Studio, storage: ProjectStorage, registry: ReturnType<typeof studioToolRegistry>;
let runner: RenderJobRunner;
let projectId: string, v1: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'veyra-tools-'));
  client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  repo = createRepository(db);
  const settings = loadStudioSettings(loadRenderSettings(), defaultConfigDir());
  storage = new ProjectStorage(join(root, 'projects'));
  const engine = colorEngine((id) => repo.getRevision(id).storyboard);
  runner = new RenderJobRunner(repo, storage, engine, settings);
  app = new Studio(repo, runner, new FakeAiProvider(), settings, storage);
  const project = app.createProject('Outils');
  projectId = project.id;
  registry = studioToolRegistry({ repo, storage, settings, engine, studio: app, projectId });
  await app.sendPrompt(project.id, saas);
  v1 = repo.listRevisions(project.id)[0].id;

  const shims = join(root, 'bin');
  records = join(root, 'records');
  mkdirSync(shims);
  mkdirSync(records);
  for (const name of ['ffmpeg', 'ffprobe']) {
    const shim = join(shims, name);
    writeFileSync(
      shim,
      `#!/bin/sh\nenv > ${JSON.stringify(records)}/${name}-$$.env\nexec ${JSON.stringify(realBinary(name))} "$@"\n`
    );
    chmodSync(shim, 0o755);
  }
  Object.assign(process.env, secrets);
  setChildPathPrefixForTests(shims);
});
afterAll(() => {
  setChildPathPrefixForTests(undefined);
  for (const key of Object.keys(secrets)) delete process.env[key];
  client.close();
  rmSync(root, { recursive: true, force: true });
});

const clearRecords = () => {
  for (const file of readdirSync(records)) rmSync(join(records, file));
};
/** (e) Every recorded child environment: present, secret-free, minimal. */
function expectCleanChildren() {
  const files = readdirSync(records);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const text = readFileSync(join(records, file), 'utf8');
    for (const value of Object.values(secrets)) expect(text).not.toContain(value);
    for (const key of text
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('=')[0]))
      expect(['PATH', 'LANG', 'LC_ALL', 'PWD', 'OLDPWD', 'SHLVL', '_']).toContain(key);
  }
}
const okOutput = <T>(result: Awaited<ReturnType<typeof registry.invoke>>) => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  for (const value of Object.values(secrets)) expect(JSON.stringify(result)).not.toContain(value);
  return result.output as T;
};

it('(b, e) media.inspect and media.frame run real ffprobe/ffmpeg and return sha256 artefacts', async () => {
  const revision = repo.getRevision(v1);
  const before = readdirSync(storage.revision(projectId, v1), { recursive: true }).sort();
  clearRecords();
  const probed = okOutput<{ frameCount: number; frameRate: { num: number } }>(
    await registry.invoke(
      'media.inspect',
      { revisionId: v1 },
      { grants: ['read-only', 'local-compute'] }
    )
  );
  expect(probed.frameCount).toBe(revision.media!.frameCount);
  expect(probed.frameRate.num).toBe(revision.media!.fpsNum);
  expectCleanChildren();

  clearRecords();
  const result = await registry.invoke(
    'media.frame',
    { revisionId: v1, frameIndex: 30 },
    { grants: ['local-compute', 'writes-revision-artefacts'] }
  );
  const frame = okOutput<{ path: string }>(result);
  expectCleanChildren();
  expect(result.artefacts).toHaveLength(1);
  const [artefact] = result.artefacts;
  expect(artefact).toMatchObject({ kind: 'png', path: frame.path });
  expect(artefact.path).toMatch(new RegExp(`^${projectId}/tool-calls/tcl_[^/]+/frame-30\\.png$`));
  const file = join(storage.root, artefact.path);
  expect(readFileSync(file).subarray(1, 4).toString()).toBe('PNG');
  expect(sha(file)).toBe(artefact.sha256);
  // Nothing written in the revision's folder.
  expect(readdirSync(storage.revision(projectId, v1), { recursive: true }).sort()).toEqual(before);
});

it('(c) bad input is refused with no process spawned and no file written', async () => {
  clearRecords();
  for (const input of [
    { revisionId: v1, frameIndex: -1 },
    { revisionId: v1, frameIndex: 1.5 },
    { revisionId: '../../etc', frameIndex: 0 },
    { revisionId: v1, frameIndex: 0, argv: ['-i', '/etc/passwd'] }
  ]) {
    const result = await registry.invoke('media.frame', input, { grants: all });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  }
  expect(readdirSync(records)).toEqual([]);
  expect(readdirSync(join(storage.root, projectId, 'tool-calls'))).toHaveLength(1); // (b)'s call only
});

it('(g) scene.patch changes one scene and leaves the others deep-equal, without a revision', async () => {
  const revisions = repo.listRevisions(projectId).length;
  const board = repo.getRevision(v1).storyboard;
  const target = board.scenes[1]; // a component scene: text goes to its primary field
  const out = okOutput<{
    storyboard: typeof board;
    changedSceneIds: string[];
    unchangedSceneIds: string[];
  }>(
    await registry.invoke(
      'scene.patch',
      { revisionId: v1, changes: [{ sceneId: target.id, patch: { text: 'Nouveau titre' } }] },
      { grants: ['read-only'] }
    )
  );
  expect(out.changedSceneIds).toEqual([target.id]);
  expect(out.unchangedSceneIds).toHaveLength(board.scenes.length - 1);
  for (const id of out.unchangedSceneIds)
    expect(out.storyboard.scenes.find((s) => s.id === id)).toStrictEqual(
      board.scenes.find((s) => s.id === id)
    );
  expect(out.storyboard.scenes.find((s) => s.id === target.id)!.text).toContain('Nouveau titre');
  expect(repo.listRevisions(projectId)).toHaveLength(revisions);
  expect(repo.getRevision(v1).storyboard).toStrictEqual(board);
  // An unknown scene is an explicit failure, never a silent no-op.
  expect(
    await registry.invoke(
      'scene.patch',
      { revisionId: v1, changes: [{ sceneId: 'scn_absent', patch: { text: 'x' } }] },
      { grants: ['read-only'] }
    )
  ).toMatchObject({ ok: false, error: { code: 'failed' } });
});

it('(d, g, e) audio.track.update: refused without grant; with it, a child revision and an intact parent', async () => {
  const wav = join(root, 'music.wav');
  await runProcess('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:sample_rate=48000',
    '-t',
    '3',
    '-ac',
    '2',
    wav
  ]);
  const data = new Uint8Array(readFileSync(wav));
  const asset = await app.importAudio(projectId, new File([data], 'music.wav'), data, 'music');
  await app.reviseAudio(v1, {
    schemaVersion: 1,
    tracks: [
      {
        id: 'atr_music',
        assetId: asset.id,
        label: 'Musique',
        category: 'music',
        anchor: { type: 'absolute', atMs: 0 },
        loop: true,
        gainDb: -18
      }
    ]
  });
  const parent = repo.listRevisions(projectId).at(-1)!;
  expect(parent).toMatchObject({ parentRevisionId: v1, status: 'awaiting_approval' });
  const input = { revisionId: parent.id, trackId: 'atr_music', patch: { gainDb: -6 } };

  const counts = () => [repo.listRevisions(projectId).length, repo.listRuns(projectId).length];
  const before = counts();
  expect(
    await registry.invoke('audio.track.update', input, {
      grants: ['read-only', 'local-compute']
    })
  ).toMatchObject({
    ok: false,
    error: { code: 'permission-denied', details: { missing: ['writes-revision-artefacts'] } }
  });
  expect(counts()).toEqual(before);
  expect(repo.getRevision(parent.id).status).toBe('awaiting_approval');

  const mp4 = sha(parent.videoPath!);
  clearRecords();
  const out = okOutput<{ revisionId: string; parentRevisionId: string; runId: string }>(
    await registry.invoke('audio.track.update', input, { grants: ['writes-revision-artefacts'] })
  );
  expectCleanChildren(); // the mix and mux of the child render
  const child = repo.getRevision(out.revisionId);
  expect(child).toMatchObject({ parentRevisionId: parent.id, status: 'awaiting_approval' });
  expect(child.audio!.tracks[0]).toMatchObject({ id: 'atr_music', gainDb: -6, loop: true });
  expect(child.storyboard).toStrictEqual(parent.storyboard);
  // The parent keeps its content and file; only its review status moves (existing flow).
  const after = repo.getRevision(parent.id);
  const { status, updatedAt, ...kept } = after;
  const { status: s0, updatedAt: u0, ...was } = parent;
  expect([s0, status, updatedAt >= u0]).toEqual(['awaiting_approval', 'changes_requested', true]);
  expect(kept).toStrictEqual(was);
  expect(sha(parent.videoPath!)).toBe(mp4);
  expect(child.videoPath).not.toBe(parent.videoPath);
});

it('captions.build gives approximate scene times; captions.export snaps them to the measured frames', async () => {
  const source = repo.listRevisions(projectId).at(-1)!;
  // A revision without captions cannot be exported.
  expect(
    await registry.invoke(
      'captions.export',
      { revisionId: source.id, format: 'srt' },
      { grants: all }
    )
  ).toMatchObject({ ok: false, error: { code: 'failed', message: /sans sous-titres/ } });
  const scene = source.storyboard.scenes[0];
  await app.setNarration(source.id, scene.id, 'Bienvenue dans Pilot, votre outil d’équipe');
  const narrated = repo.listRevisions(projectId).at(-1)!;
  expect(narrated.captions).not.toBeNull();

  const built = okOutput<{
    captions: { words: { timing: string; sceneId?: string }[] };
    approximate: boolean;
    precision: { approximateShare: number };
    note: string;
  }>(
    await registry.invoke('captions.build', { revisionId: narrated.id }, { grants: ['read-only'] })
  );
  expect(built.approximate).toBe(true);
  expect(built.precision.approximateShare).toBe(1);
  expect(built.note).toMatch(/approximatifs/);
  expect(built.captions.words.every((w) => w.timing === 'scene' && w.sceneId === scene.id)).toBe(
    true
  );

  const media = narrated.media!;
  const expected = quantizeCues(
    narrated.captions!.cues,
    { num: media.fpsNum, den: media.fpsDen },
    media.frameCount
  );
  for (const [format, parse] of [
    ['srt', parseSrt],
    ['vtt', parseWebVtt]
  ] as const) {
    clearRecords();
    const out = okOutput<{ text: string; cues: number; frameCount: number }>(
      await registry.invoke(
        'captions.export',
        { revisionId: narrated.id, format },
        { grants: ['read-only'] }
      )
    );
    expect(readdirSync(records)).toEqual([]); // pure: measured media from the revision row
    expect(out).toMatchObject({ cues: expected.length, frameCount: media.frameCount });
    expect(parse(out.text).map((c) => [c.startMs, c.endMs])).toEqual(
      expected.map((q) => [q.startMs, q.endMs])
    );
  }
});

it('review D5: a revision of another project is refused (permission-denied)', async () => {
  const other = app.createProject('Autre');
  await app.sendPrompt(other.id, saas);
  const foreignRevision = repo.listRevisions(other.id)[0];
  const foreign = foreignRevision.id;
  const sceneId = foreignRevision.storyboard.scenes[0].id;
  for (const [id, input] of [
    ['media.inspect', { revisionId: foreign }],
    [
      'scene.patch',
      { revisionId: foreign, changes: [{ sceneId, patch: { text: 'Autre texte' } }] }
    ],
    ['captions.build', { revisionId: foreign }],
    [
      'revision.apply',
      { revisionId: foreign, operations: [{ op: 'scene.transition', sceneId, enter: 'scale' }] }
    ]
  ] as const)
    expect(
      await registry.invoke(id, input, { grants: [...permissionClassSchema.options] })
    ).toMatchObject({
      ok: false,
      error: { code: 'permission-denied' }
    });
});

/** sha256 of every file under a folder (relative path → hash). */
function tree(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const path = join(e.parentPath, e.name);
        return [path.slice(dir.length), sha(path)];
      })
  );
}

it('revision.apply: typed refusals, atomic child revision, byte-identical parent, no render', async () => {
  const parent = repo.listRevisions(projectId).at(-1)!;
  // Rendered, reviewed, with music and burned captions (earlier tests of this file).
  expect(parent.status).toBe('awaiting_approval');
  expect(parent.audio?.tracks.map((t) => t.id)).toContain('atr_music');
  expect(parent.captions).not.toBeNull();
  const [first, second] = parent.storyboard.scenes;
  const row = () => [
    client.prepare('select * from video_revisions where id = ?').get(parent.id),
    client.prepare('select * from scenes where revision_id = ? order by start').all(parent.id)
  ];
  const parentDir = storage.revision(projectId, parent.id);
  const rowBefore = row(),
    filesBefore = tree(parentDir);
  expect(Object.keys(filesBefore).length).toBeGreaterThan(0);
  const counts = () => [
    repo.listRevisions(projectId).length,
    repo.listRuns(projectId).length,
    repo.renderJobsFor(repo.listRevisions(projectId).map((r) => r.id)).length
  ];
  const before = counts();
  const music = { op: 'audio.track', trackId: 'atr_music', patch: { gainDb: -6 } };
  const call = (operations: unknown[], grants = ['writes-revision-artefacts'] as const) =>
    registry.invoke('revision.apply', { revisionId: parent.id, operations }, { grants });

  expect(await call([music], ['read-only'] as never)).toMatchObject({
    ok: false,
    error: { code: 'permission-denied' }
  });
  expect(await call([{ op: 'scene.delete', sceneId: first.id }])).toMatchObject({
    ok: false,
    error: { code: 'invalid-input' }
  });
  // Valid then invalid (params on a scene without component): nothing is written.
  expect(
    await call([
      music,
      { op: 'scene.update', sceneId: first.id, patch: { text: 'Valide' } },
      { op: 'scene.update', sceneId: second.id, patch: { params: { value: 1 } } }
    ])
  ).toMatchObject({ ok: false, error: { code: 'invalid-input', message: /composant/ } });
  expect(
    await call([{ op: 'scene.duration', sceneId: 'scn_absent', durationMs: 2000 }])
  ).toMatchObject({
    ok: false,
    error: { code: 'conflict', message: /Scène introuvable/ }
  });
  expect(await call([music, { ...music, patch: { gainDb: -3 } }])).toMatchObject({
    ok: false,
    error: { code: 'conflict', message: /même cible/ }
  });
  // Audit: more than 50 operations, and a valid replacement asset of another project.
  expect(
    await call(
      Array.from({ length: 51 }, (_, i) => ({
        op: 'scene.update',
        sceneId: first.id,
        patch: { text: `Texte ${i}` }
      }))
    )
  ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  const musicAsset = parent.audio!.tracks.find((t) => t.id === 'atr_music')!.assetId;
  const foreignAsset = { ...repo.getAsset(musicAsset)!, id: newId('ast') };
  foreignAsset.projectId = app.createProject('Média étranger').id;
  repo.createAsset(foreignAsset);
  expect(foreignAsset.audio?.status).toBe('valid');
  expect(
    await call([{ op: 'media.replace', assetId: musicAsset, withAssetId: foreignAsset.id }])
  ).toMatchObject({ ok: false, error: { code: 'conflict', message: /remplacement/ } });
  expect(counts()).toEqual(before);

  const out = okOutput<{
    revisionId: string;
    parentRevisionId: string;
    invalidation: { artefacts: { artefact: string; status: string; cause: string | null }[] };
    warnings: string[];
  }>(await call([music]));
  const child = repo.getRevision(out.revisionId);
  expect(child).toMatchObject({ parentRevisionId: parent.id, status: 'draft', videoPath: null });
  expect(child.audio!.tracks.find((t) => t.id === 'atr_music')!.gainDb).toBe(-6);
  expect(child.storyboard).toStrictEqual(parent.storyboard);
  expect(child.captions).toStrictEqual(parent.captions);
  // Traced: tool, parent, operations and plan in the child's origin.
  expect(child.resolvedConfig.origin).toStrictEqual({
    tool: 'revision.apply',
    parentRevisionId: parent.id,
    operations: [music],
    invalidation: out.invalidation
  });
  const picture = out.invalidation.artefacts.find((a) => a.artefact === 'picture')!;
  expect(picture).toMatchObject({ status: 'reused' });
  // A child revision and nothing else: no run, no render job, no file.
  expect(counts()).toEqual([before[0] + 1, before[1], before[2]]);
  expect(tree(storage.revision(projectId, child.id))).toEqual({});

  // The parent now has a child: a second edit from it is stale.
  expect(await call([music])).toMatchObject({
    ok: false,
    error: { code: 'conflict', message: /non à jour/ }
  });
  // Immutability: same row bytes (status, updatedAt included) and same files.
  expect(row()).toStrictEqual(rowBefore);
  expect(tree(parentDir)).toStrictEqual(filesBefore);

  // The orchestrator's render (not the tool) reuses the parent picture, as the plan said.
  const now = Date.now();
  const job = repo.createRenderJob({
    id: newId('rnd'),
    revisionId: child.id,
    outputPath: null,
    error: null,
    createdAt: now,
    updatedAt: now
  });
  const done = await runner.enqueue(job.id);
  expect(done.status).toBe('succeeded');
  expect(done.resolvedConfig).toMatchObject({ videoReusedFrom: parent.id });
  expect(row()[1]).toStrictEqual(rowBefore[1]);
  expect(tree(parentDir)).toStrictEqual(filesBefore);
});

it('revision.apply: a scene edit is planned as a new picture for that scene only', async () => {
  const parent = repo.listRevisions(projectId).at(-1)!;
  expect(parent.status).toBe('awaiting_approval');
  const [first, ...others] = parent.storyboard.scenes;
  const out = okOutput<{
    revisionId: string;
    invalidation: {
      scenes: { sceneId: string; change: string }[];
      artefacts: { artefact: string; status: string; targets: string[] }[];
    };
  }>(
    await registry.invoke(
      'revision.apply',
      {
        revisionId: parent.id,
        operations: [{ op: 'scene.transition', sceneId: first.id, enter: 'scale' }]
      },
      { grants: ['writes-revision-artefacts'] }
    )
  );
  expect(out.invalidation.scenes).toEqual([
    { sceneId: first.id, change: 'content' },
    ...others.map((s) => ({ sceneId: s.id, change: 'unchanged' }))
  ]);
  expect(out.invalidation.artefacts.find((a) => a.artefact === 'picture')).toMatchObject({
    status: 'invalidated',
    targets: [first.id]
  });
  const child = repo.getRevision(out.revisionId);
  expect(child.storyboard.scenes[0].animation).toMatchObject({ enter: 'scale' });
  expect(child.storyboard.scenes.slice(1)).toStrictEqual(parent.storyboard.scenes.slice(1));
});
