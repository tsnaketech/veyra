import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAiProvider } from '@veyra/ai';
import type { VideoEngine } from '@veyra/hyperframes-adapter';
import { runProcess } from '@veyra/video';
import { newId } from '@veyra/schemas';
import { ProjectStorage } from '@veyra/storage';
import { createRepository } from './db/repo';
import * as schema from './db/schema';
import { defaultConfigDir, loadRenderSettings, RenderJobRunner } from './jobs/runner';
import { loadStudioSettings, Studio } from './studio';
import { startsVideo, videoOf } from './videos';
import { colorEngine } from './test-engines';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * Approval and video identity (audit T129b, blocker 1). A project holds independent videos;
 * a new prompt (or « nouvelle vidéo indépendante ») starts a video even though its revision
 * records the previous head as technical parent. Approving a version closes the other
 * pending versions of the same video only. "[simulé]" = FakeAiProvider (labelled simulated
 * storyboard and Director); "[réel]" = ffmpeg/colorEngine renders (not HyperFrames).
 */
const first =
  'Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.';
const second = 'Crée une vidéo de 15 secondes présentant une boulangerie de quartier.';

/** Called once at the start of the next render (an action taken while it renders). */
let beforeRender: ((revisionId: string) => void) | null = null;
/** The next render produces an undersized video (technical QA failure). */
let undersized = false;
const renderHook = (engine: VideoEngine): VideoEngine => ({
  ...engine,
  render: (dir, opts, onProgress) => {
    const hook = beforeRender;
    beforeRender = null;
    hook?.(/revisions\/(rev_[^/]+)\//.exec(opts.outputPath)![1]);
    if (!undersized) return engine.render(dir, opts, onProgress);
    undersized = false;
    // A real H.264 file at the wrong size: the deterministic `resolution` check fails, which
    // would trigger an automatic fix.
    return runProcess(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x9a9a9a:s=320x180:r=30:d=20',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        opts.outputPath
      ],
      { timeoutMs: 60_000 }
    ).then(() => ({ path: opts.outputPath, engine: 'hyperframes' as const, stderrTail: '' }));
  }
});
let root: string, client: Database.Database;
let repo: ReturnType<typeof createRepository>;
let app: Studio;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'veyra-approval-'));
  client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  repo = createRepository(db);
  const settings = loadStudioSettings(loadRenderSettings(), defaultConfigDir());
  const storage = new ProjectStorage(join(root, 'projects'));
  app = new Studio(
    repo,
    new RenderJobRunner(
      repo,
      storage,
      renderHook(colorEngine((id) => repo.getRevision(id).storyboard)),
      settings
    ),
    new FakeAiProvider(),
    settings,
    storage
  );
});
afterAll(() => {
  client.close();
  rmSync(root, { recursive: true, force: true });
});

const status = (id: string) => repo.getRevision(id).status;
const phaseOf = (runId: string, name: string) =>
  repo.phasesFor([runId]).find((p) => p.phase === name)!;
const settled = (projectId: string) =>
  vi.waitFor(
    () => {
      if (
        app.activityFor(projectId) ||
        repo.listRuns(projectId).some((r) => r.status === 'running')
      )
        throw new Error('en cours');
    },
    { timeout: 120_000, interval: 50 }
  );
/** A new video in the project; `fresh` is the « nouvelle vidéo indépendante » box. */
async function video(projectId: string, text: string, fresh = true) {
  await app.sendPrompt(projectId, text, 0, { fresh });
  await settled(projectId);
  const revision = repo.listRevisions(projectId).at(-1)!;
  expect(revision.status).toBe('awaiting_approval');
  return revision;
}
/** A Director edit of the pending head (simulated Director, real tools and render). */
async function directorChild(projectId: string) {
  await app.sendPrompt(projectId, 'Rends la scène 2 plus dynamique');
  await settled(projectId);
  const run = repo.listRuns(projectId).at(-1)!;
  const child = repo.getRevision(repo.getRun(run.id).revisionId!);
  expect(child.status).toBe('awaiting_approval');
  return { child, run };
}
/** A pending child written directly (same shape as revision.apply), pushed to approval. */
function pendingChild(parentId: string) {
  const parent = repo.getRevision(parentId);
  const id = newId('rev');
  const now = Date.now();
  repo.createRevision({
    id,
    projectId: parent.projectId,
    parentRevisionId: parent.id,
    storyboard: parent.storyboard,
    audio: parent.audio,
    captions: parent.captions,
    resolvedConfig: {
      origin: { tool: 'revision.apply', parentRevisionId: parent.id, operations: [] },
      aiProvider: 'fake'
    },
    videoPath: null,
    error: null,
    createdAt: now,
    updatedAt: now
  });
  for (const to of ['rendering', 'qa', 'awaiting_approval'] as const)
    repo.transitionRevision(id, to);
  return id;
}

it('[simulé, réel ffmpeg] independent videos: approving one never closes the other, in both orders', async () => {
  const projectId = app.createProject('Vidéos indépendantes').id;
  const v1 = await video(projectId, first, false);
  const v2 = await video(projectId, second);
  // The technical parent link exists: the bug walked it.
  expect(v2.parentRevisionId).toBe(v1.id);

  app.approve(v2.id);
  expect(status(v2.id)).toBe('approved');
  expect(status(v1.id)).toBe('awaiting_approval');
  app.approve(v1.id);
  expect(status(v1.id)).toBe('approved');
  expect(status(v2.id)).toBe('approved');

  // Reverse order: the older video first.
  const v3 = await video(projectId, first);
  const v4 = await video(projectId, second);
  app.approve(v3.id);
  expect(status(v4.id)).toBe('awaiting_approval');
  app.approve(v4.id);
  expect([status(v3.id), status(v4.id)]).toEqual(['approved', 'approved']);
});

it('[simulé, réel ffmpeg] Director run: approving its source or its child closes only that video', async () => {
  const projectId = app.createProject('Director et vidéo indépendante').id;
  const other = await video(projectId, second, false);
  // The source is a new video whose technical parent is the other one.
  const source = await video(projectId, first);
  const a = await directorChild(projectId);
  expect(a.child.parentRevisionId).toBe(source.id);

  // Validating the source: its Director child is closed, the independent video is not.
  app.approve(source.id);
  expect(status(a.child.id)).toBe('changes_requested');
  expect(status(other.id)).toBe('awaiting_approval');
  await vi.waitFor(() => expect(repo.getRun(a.run.id).status).toBe('completed'));

  // Validating a descendant (child of a child): its ancestors close, not the other video.
  const s2 = await video(projectId, first);
  const b = await directorChild(projectId);
  const c = await directorChild(projectId);
  expect(c.child.parentRevisionId).toBe(b.child.id);
  app.approve(c.child.id);
  expect(status(s2.id)).toBe('changes_requested');
  expect(status(b.child.id)).toBe('changes_requested');
  expect(status(other.id)).toBe('awaiting_approval');
  await vi.waitFor(() => expect(repo.getRun(c.run.id).status).toBe('completed'));
  app.approve(other.id);
  expect(status(other.id)).toBe('approved');
});

it('[simulé, réel ffmpeg] concurrent versions of one video: one approved, the others closed; repeated approvals refused', async () => {
  const projectId = app.createProject('Versions concurrentes').id;
  const source = await video(projectId, first, false);
  const a = pendingChild(source.id);
  const b = pendingChild(source.id);
  const deep = pendingChild(a);

  app.approve(b);
  expect(status(b)).toBe('approved');
  for (const id of [source.id, a, deep]) expect(status(id)).toBe('changes_requested');

  // Repeated or late approvals of the same video change nothing.
  expect(() => app.approve(b)).toThrow();
  expect(() => app.approve(a)).toThrow();
  expect([status(b), status(a), status(source.id)]).toEqual([
    'approved',
    'changes_requested',
    'changes_requested'
  ]);
  // A version finished after another one was approved (an edit in flight) is refused.
  const late = pendingChild(b);
  expect(() => app.approve(late)).toThrow(/déjà validée/);
  expect(status(late)).toBe('awaiting_approval');
});

it('[simulé Director, réel ffmpeg] source approved while its Director child renders: the child is closed, nothing stays stuck', async () => {
  const projectId = app.createProject('Validation pendant le rendu').id;
  const source = await video(projectId, first, false);
  let rendering: string | null = null;
  beforeRender = (id) => {
    rendering = id;
    // The user picks the original and approves it while the child renders (UI allows it).
    app.approve(source.id, projectId);
  };
  await app.sendPrompt(projectId, 'Rends la scène 2 plus dynamique');
  await settled(projectId);
  const run = repo.listRuns(projectId).at(-1)!;
  const child = repo.getRevision(repo.getRun(run.id).revisionId!);
  expect(child.id).toBe(rendering);
  expect(status(source.id)).toBe('approved');
  // Rendered and checked, then closed: one approved version per video.
  expect(child.videoPath).toBeTruthy();
  expect(child.status).toBe('changes_requested');
  await vi.waitFor(() => expect(repo.getRun(run.id).status).toBe('completed'));
  expect(phaseOf(run.id, 'human-approval')).toMatchObject({ status: 'done' });
  // The next message is no edit of a closed version: nothing awaits approval, a new video.
  expect(repo.listRevisions(projectId).some((r) => r.status === 'awaiting_approval')).toBe(false);
});

it('[simulé Director, réel ffmpeg] same, with a technical QA failure: no automatic fix of the closed child, run completed', async () => {
  const projectId = app.createProject('Validation pendant le rendu, QA technique en échec').id;
  const source = await video(projectId, first, false);
  beforeRender = () => app.approve(source.id, projectId);
  undersized = true;
  await app.sendPrompt(projectId, 'Rends la scène 2 plus dynamique');
  await settled(projectId);
  const run = repo.listRuns(projectId).at(-1)!;
  const child = repo.getRevision(repo.getRun(run.id).revisionId!);
  expect(repo.reportsFor([child.id]).at(-1)!.checks).toContainEqual(
    expect.objectContaining({ name: 'resolution', passed: false })
  );
  expect([status(source.id), child.status]).toEqual(['approved', 'changes_requested']);
  // No automatic-fix child of a closed version, and the run ends cleanly.
  expect(repo.listRevisions(projectId).filter((r) => r.parentRevisionId === child.id)).toEqual([]);
  await vi.waitFor(() => expect(repo.getRun(run.id).status).toBe('completed'));
  expect(repo.getRun(run.id).error).toBeNull();
  const texts = app.snapshot(projectId)!.messages.map((m) => m.text);
  expect(texts).toContainEqual(
    expect.stringMatching(/validée entre-temps : cette version est close/)
  );
  expect(texts.at(-1)).not.toMatch(/En attente de votre validation/);
});

it('video identity: every origin written by the Studio is classified', () => {
  const rev = (id: string, parent: string | null, origin: Record<string, unknown>) => ({
    id,
    parentRevisionId: parent,
    resolvedConfig: { origin }
  });
  const all = [
    rev('a', null, { prompt: 'p', runId: 'run_1' }), // first video
    rev('b', 'a', { prompt: 'p', runId: 'run_1', renderRetry: 'run_1' }), // re-render
    rev('c', 'b', { prompt: 'p', runId: 'run_1', autoFix: 1 }), // automatic fix
    rev('d', 'c', { planId: 'pln_1', batchId: 'bat_1', runId: 'run_2' }), // correction plan
    rev('e', 'd', { edit: 'narration', runId: 'run_3' }), // narration or voice edit
    rev('f', 'e', { audioRevision: 'manual', runId: 'run_4' }), // soundtrack revision
    rev('g', 'f', { tool: 'revision.apply', parentRevisionId: 'f' }), // Director
    rev('h', 'g', { prompt: 'q', runId: 'run_5' }), // new prompt: another video
    rev('i', 'h', { prompt: 'q', runId: 'run_5', autoFix: 1 }),
    rev('j', 'i', {}) // legacy row without origin: stays in its parent's video
  ];
  expect(all.map((r) => videoOf(all, r.id))).toEqual([
    'a',
    'a',
    'a',
    'a',
    'a',
    'a',
    'a',
    'h',
    'h',
    'h'
  ]);
  expect(all.filter(startsVideo).map((r) => r.id)).toEqual(['a', 'h']);
  // A cycle or a missing parent ends the walk instead of looping.
  expect(videoOf([rev('x', 'y', {}), rev('y', 'x', {})], 'x')).toBeTypeOf('string');
  expect(videoOf([rev('x', 'gone', {})], 'x')).toBe('x');
});

it('[simulé, réel ffmpeg] another project is never touched', async () => {
  const p = app.createProject('Projet A').id;
  const q = app.createProject('Projet B').id;
  const inP = await video(p, first, false);
  const inQ = await video(q, first, false);
  const qChild = pendingChild(inQ.id);
  const before = repo.listRevisions(q).map((r) => [r.id, r.status, r.updatedAt]);
  // The page of project A cannot approve a revision of project B.
  expect(() => app.approve(qChild, p)).toThrow(/étrangère au projet/);
  app.approve(inP.id, p);
  expect(repo.listRevisions(q).map((r) => [r.id, r.status, r.updatedAt])).toEqual(before);
  expect(status(qChild)).toBe('awaiting_approval');
});
