import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStorage } from '@veyra/storage';
import { runProcess } from '@veyra/video';
import { AssistedProvider, FakeAiProvider, planProduction } from '@veyra/ai';
import { newId, type Phase, type ProductionPlan } from '@veyra/schemas';
import { createRepository } from './db/repo';
import * as schema from './db/schema';
import { defaultConfigDir, loadRenderSettings, RenderJobRunner } from './jobs/runner';
import { loadStudioSettings, Studio } from './studio';
import { colorEngine } from './test-engines';
import { Orchestrator, type Runners } from './production';

vi.setConfig({ testTimeout: 180_000 });
const prompt =
  'Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.';
let client: Database.Database;
let root: string;
let repo: ReturnType<typeof createRepository>;
let app: Studio;
let orchestrator: Orchestrator;
let projectId: string;
let renders: number;
let failRender: boolean;
let onRender: (() => void) | null;

function studio(ai = new FakeAiProvider() as FakeAiProvider | AssistedProvider, review = false) {
  const settings = loadStudioSettings(loadRenderSettings(), defaultConfigDir());
  const storage = new ProjectStorage(root);
  const engine = colorEngine((id) => repo.getRevision(id).storyboard);
  const runner = new RenderJobRunner(
    repo,
    storage,
    {
      ...engine,
      render: async (...args: Parameters<typeof engine.render>) => {
        renders++;
        onRender?.();
        if (failRender) throw new Error('Rendu indisponible');
        return engine.render(...args);
      }
    },
    settings,
    review ? (revision, path) => app.review(revision, path) : undefined
  );
  return new Studio(repo, runner, ai, settings, storage);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'veyra-production-'));
  client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  repo = createRepository(db);
  renders = 0;
  failRender = false;
  onRender = null;
  app = studio();
  projectId = app.createProject('Production').id;
  orchestrator = new Orchestrator(repo, () => {});
});
afterEach(() => {
  client.close();
  rmSync(root, { recursive: true, force: true });
});

const done = (payload: unknown = {}) => ({
  kind: 'done' as const,
  payload,
  provider: 'rules' as const
});
// Minimal payloads satisfying each phase contract.
const draft = {
  title: 'draft',
  scenes: [{ text: 'Bonjour', durationMs: 2000, enter: 'fade', animationMs: 500 }]
};
const motionPayload = {
  storyboard: { scenes: [], width: 1920, height: 1080, fps: 30 },
  registryVersion: 1
};
const audioPayload = { schemaVersion: 1, tracks: [] };
function plan(names: Phase[], attempts = 1, maxAiCalls = 3): ProductionPlan {
  const full = planProduction(
    { audio: { wanted: true, assetIds: ['ast_music'] } },
    { maxAiCalls, maxRenders: 3 }
  );
  return {
    ...full,
    phases: names.map((name, i) => ({
      ...full.phases.find((p) => p.phase === name)!,
      dependsOn: i ? [names[i - 1]] : [],
      maxAttempts: attempts
    }))
  };
}
function create(spec: ProductionPlan) {
  return orchestrator.create({ projectId, kind: 'production', plan: spec });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 1500 && !condition(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(condition()).toBe(true);
};

it('respects dependencies and starts motion and audio before either finishes', async () => {
  const spec = plan(['script', 'motion', 'audio', 'composition']);
  spec.phases[2].dependsOn = ['script'];
  spec.phases[3].dependsOn = ['motion', 'audio'];
  const run = create(spec);
  const gate = deferred();
  const started: string[] = [];
  const work = orchestrator.drive(run.id, {
    script: {
      run: async () => {
        started.push('script');
        return done(draft);
      }
    },
    motion: {
      run: async (inputs) => {
        expect(inputs.script).toEqual(draft);
        started.push('motion');
        await gate.promise;
        return done(motionPayload);
      }
    },
    audio: {
      run: async () => {
        started.push('audio');
        await gate.promise;
        return done(audioPayload);
      }
    },
    composition: {
      run: async () => {
        started.push('composition');
        return done();
      }
    }
  });
  await until(() => started.length === 3);
  expect(started).toEqual(['script', 'motion', 'audio']);
  gate.resolve();
  expect((await work).status).toBe('completed');
  expect(started.at(-1)).toBe('composition');
  expect(orchestrator.phases(run.id).every((p) => p.result?.provenance)).toBe(true);
});

it('retries up to maxAttempts and resumes only the failed phase', async () => {
  const run = create(plan(['script', 'motion'], 2));
  const script = vi.fn(async () => done(draft));
  const motion = vi.fn(async () => {
    throw new Error('échec');
  });
  expect(
    (await orchestrator.drive(run.id, { script: { run: script }, motion: { run: motion } })).status
  ).toBe('failed');
  expect(script).toHaveBeenCalledTimes(1);
  expect(motion).toHaveBeenCalledTimes(2);
  const repaired = vi.fn(async () => done(motionPayload));
  expect(
    (await orchestrator.resume(run.id, { script: { run: script }, motion: { run: repaired } }))
      .status
  ).toBe('completed');
  expect(script).toHaveBeenCalledTimes(1);
  expect(repaired).toHaveBeenCalledTimes(1);
});

it('stops between phases and resumes without recomputing completed work', async () => {
  const run = create(plan(['script', 'motion']));
  const motion = vi.fn(async () => done(motionPayload));
  const runners: Runners = {
    script: {
      run: async () => {
        orchestrator.stop(run.id);
        return done(draft);
      }
    },
    motion: { run: motion }
  };
  expect((await orchestrator.drive(run.id, runners)).status).toBe('stopped');
  expect(motion).not.toHaveBeenCalled();
  expect((await orchestrator.resume(run.id, runners)).status).toBe('completed');
  expect(motion).toHaveBeenCalledTimes(1);
});

it('fails the phase when the AI budget is exhausted', async () => {
  const run = create(plan(['script', 'motion'], 2, 1));
  const motion = vi.fn(async () => done(motionPayload));
  expect(
    (
      await orchestrator.drive(run.id, {
        script: { usesAi: true, run: async () => done(draft) },
        motion: { usesAi: true, run: motion }
      })
    ).status
  ).toBe('failed');
  expect(motion).not.toHaveBeenCalled();
  expect(repo.getRun(run.id).aiCalls).toBe(1);
  expect(orchestrator.phases(run.id).at(-1)?.error).toMatch(/Budget/);
});

it('waits without a runner and finishes after an external result', async () => {
  const run = create(plan(['script']));
  expect((await orchestrator.drive(run.id, {})).status).toBe('waiting');
  orchestrator.complete(run.id, 'script', done(draft));
  expect((await orchestrator.drive(run.id, {})).status).toBe('completed');
});

it('does not execute duplicate drives concurrently', async () => {
  const run = create(plan(['script']));
  const gate = deferred();
  const script = vi.fn(async () => {
    await gate.promise;
    return done(draft);
  });
  const first = orchestrator.drive(run.id, { script: { run: script } });
  const second = orchestrator.drive(run.id, { script: { run: script } });
  gate.resolve();
  await Promise.all([first, second]);
  expect(script).toHaveBeenCalledTimes(1);
});

it('persists phase results until human approval and exposes them in the snapshot', async () => {
  await app.sendPrompt(projectId, prompt);
  const [run] = repo.listRuns(projectId);
  expect(run.status).toBe('waiting');
  const phases = repo.phasesFor([run.id]);
  expect(phases.at(-1)).toMatchObject({ phase: 'human-approval', status: 'waiting' });
  expect(phases.slice(0, -1).every((p) => p.status === 'done' && p.result)).toBe(true);
  expect(phases.find((p) => p.phase === 'qa')?.result?.validation).toBe('needs-human');
  const composition = phases.find((p) => p.phase === 'composition')?.result;
  expect(composition?.agent).toBe('engine');
  expect(composition).not.toHaveProperty('owner');
  expect(app.snapshot(projectId)).toMatchObject({ runs: [run], phases });
  app.approve(run.revisionId!);
  expect(repo.getRun(run.id).status).toBe('completed');
});

it('keeps an approval given while QA still runs, before the human-approval phase', async () => {
  // The approve button is shown as soon as the revision awaits approval, before QA ends.
  const reportsFor = repo.reportsFor.bind(repo);
  let approved = false;
  const spy = vi.spyOn(repo, 'reportsFor').mockImplementation((ids) => {
    const run = repo.listRuns(projectId)[0];
    const qaRunning =
      run && repo.phasesFor([run.id]).some((p) => p.phase === 'qa' && p.status === 'running');
    if (!approved && qaRunning) {
      approved = true;
      app.approve(ids[0]);
    }
    return reportsFor(ids);
  });
  await app.sendPrompt(projectId, prompt);
  spy.mockRestore();
  const [run] = repo.listRuns(projectId);
  expect(approved).toBe(true);
  expect(repo.getRun(run.id).status).toBe('completed');
  expect(repo.phasesFor([run.id]).at(-1)).toMatchObject({
    phase: 'human-approval',
    status: 'done'
  });
});

async function importWav(name: string, category: 'music' | 'sfx', duration: number) {
  const path = join(root, name);
  await runProcess('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    String(duration),
    '-ar',
    '48000',
    '-ac',
    '2',
    path
  ]);
  const bytes = readFileSync(path);
  return app.importAudio(
    projectId,
    new File([bytes], name, { type: 'audio/wav' }),
    new Uint8Array(bytes),
    category
  );
}

it('plans music and effects, then applies an audio range correction without rendering the picture again', async () => {
  app = studio(new FakeAiProvider(), true);
  await importWav('music.wav', 'music', 3);
  await importWav('pop.wav', 'sfx', 0.08);
  await app.sendPrompt(projectId, prompt);
  const [parent] = repo.listRevisions(projectId);
  const [production] = repo.listRuns(projectId);
  expect(repo.phasesFor([production.id]).find((p) => p.phase === 'audio')?.status).toBe('done');
  expect(parent.audio?.tracks.some((t) => t.category === 'music')).toBe(true);
  expect(parent.audio?.tracks.some((t) => t.category === 'sfx')).toBe(true);
  for (const track of parent.audio!.tracks)
    if (track.anchor.type === 'event') {
      const sceneId = track.anchor.sceneId;
      expect(parent.storyboard.scenes.some((s) => s.id === sceneId)).toBe(true);
    }
  const music = parent.audio!.tracks.find((t) => t.category === 'music')!;
  const invalid = { revisionId: parent.id, timestampMs: 8000, text: 'Musique', author: 'u' };
  await expect(app.addAnnotation({ ...invalid, rangeEndMs: 7000 })).rejects.toThrow(/Fin de plage/);
  await expect(app.addAnnotation({ ...invalid, audioTrackId: 'atr_unknown' })).rejects.toThrow(
    /Piste audio/
  );
  const comment = await app.addAnnotation({
    ...invalid,
    rangeEndMs: 12000,
    audioTrackId: music.id,
    text: 'Entre 00:08 et 00:12, diminue la musique pour mieux entendre la voix off.'
  });
  expect(comment).toMatchObject({ timestampMs: 8000, rangeEndMs: 12000, audioTrackId: music.id });
  const batch = app.submitBatch({
    revisionId: parent.id,
    feedbackIds: [comment.id],
    submissionKey: 'audio-range'
  });
  await until(() => repo.getBatch(batch.id).status === 'planned' && !app.activityFor(projectId));
  const correction = repo.getPlan(repo.getBatch(batch.id).planId!)!;
  expect(correction.audioChanges).toHaveLength(1);
  expect(correction.changes).toHaveLength(0);
  const count = renders;
  await app.applyPlan(correction.id);
  const child = repo.listRevisions(projectId).at(-1)!;
  const run = repo.listRuns(projectId).at(-1)!;
  expect(run).toMatchObject({ kind: 'revision', status: 'waiting', revisionId: child.id });
  expect(repo.phasesFor([run.id]).map((p) => p.phase)).toEqual([
    'plan',
    'audio',
    'composition',
    'render',
    'qa',
    'human-approval'
  ]);
  expect(renders).toBe(count);
  expect(child.audio!.tracks.find((t) => t.id === music.id)?.duck).toContainEqual({
    startMs: 8000,
    endMs: 12000,
    gainDb: -12
  });
  expect(repo.getRevision(parent.id)).toMatchObject({
    storyboard: parent.storyboard,
    audio: parent.audio,
    videoPath: parent.videoPath
  });
  expect(repo.getRun(production.id).status).toBe('completed');
  expect(repo.getBatch(batch.id).verification).toContainEqual(
    expect.objectContaining({
      feedbackId: comment.id,
      verdict: 'applied',
      evidence: expect.stringContaining('Mesuré sur le mix')
    })
  );
  expect(repo.reportsFor([child.id]).at(-1)?.checks).toContainEqual(
    expect.objectContaining({
      name: 'Écoute qualitative',
      passed: false,
      analysisMode: 'not-performed'
    })
  );
  expect(
    repo
      .evaluationsFor([child.id])
      .at(-1)
      ?.findings.some((f) => f.justification.includes('Audio non écouté'))
  ).toBe(true);
  const snapshot = app.snapshot(projectId)!;
  expect(JSON.stringify(snapshot.jobs.map((j) => j.resolvedConfig.audio))).not.toContain(
    'assetPath'
  );
  expect(
    snapshot.visualEvents.find((e) => e.revisionId === child.id)?.events.length
  ).toBeGreaterThan(0);
});

it('imports assisted scripts into their run', async () => {
  app = studio(new AssistedProvider());
  await app.sendPrompt(projectId, prompt);
  expect(app.activityFor(projectId)).toBeNull();
  const [task] = repo.listTasks(projectId);
  const [run] = repo.listRuns(projectId);
  expect(run.status).toBe('waiting');
  const draft = await new FakeAiProvider().generateStoryboard(prompt, {
    targetDurationMs: 20000,
    styleInstructions: ''
  });
  writeFileSync(join(task.dir, 'result.json'), JSON.stringify(draft));
  await app.importTask(task.id);
  expect(repo.getRun(run.id)).toMatchObject({ status: 'waiting', revisionId: expect.any(String) });
  expect(repo.phasesFor([run.id]).find((p) => p.phase === 'script')?.result?.provider).toBe(
    'claude-subscribe'
  );
});

it('rebuilds production runners from persisted script results after stopping', async () => {
  const ai = new FakeAiProvider();
  app = studio(ai);
  const original = ai.generateStoryboard.bind(ai);
  const generate = vi.spyOn(ai, 'generateStoryboard').mockImplementation(async (...args) => {
    const draft = await original(...args);
    app.stopProduction(repo.listRuns(projectId)[0].id);
    return draft;
  });
  await app.sendPrompt(projectId, prompt);
  const [run] = repo.listRuns(projectId);
  expect(run.status).toBe('stopped');
  expect(repo.listRevisions(projectId)).toHaveLength(0);
  app = studio(ai);
  await app.resumeProduction(run.id);
  expect(repo.getRun(run.id).status).toBe('waiting');
  expect(generate).toHaveBeenCalledTimes(1);
});

it('rebuilds manual revision runners from the database after stopping at composition', async () => {
  await app.sendPrompt(projectId, prompt);
  const parent = repo.listRevisions(projectId)[0];
  const original = repo.createRevision.bind(repo);
  const createRevision = vi.spyOn(repo, 'createRevision').mockImplementation((input) => {
    const revision = original(input);
    const run = repo.listRuns(projectId).at(-1)!;
    if (run.kind === 'revision') app.stopProduction(run.id);
    return revision;
  });
  await app.reviseAudio(parent.id, { schemaVersion: 1, tracks: [] });
  const run = repo.listRuns(projectId).at(-1)!;
  expect(run.status).toBe('stopped');
  expect(repo.listRevisions(projectId)).toHaveLength(2);
  createRevision.mockRestore();
  app = studio();
  await app.resumeProduction(run.id);
  expect(repo.getRun(run.id).status).toBe('waiting');
  expect(repo.listRevisions(projectId)).toHaveLength(2);
  expect(renders).toBe(1);
});

it('creates a production run when importing a legacy storyboard task', async () => {
  const storage = new ProjectStorage(root);
  const task = repo.createTask({
    id: 'tsk_legacy',
    projectId,
    kind: 'storyboard',
    provider: 'claude-subscribe',
    input: { prompt, parentRevisionId: null },
    dir: storage.taskDir(projectId, 'tsk_legacy'),
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  const draft = await new FakeAiProvider().generateStoryboard(prompt, {
    targetDurationMs: 20000,
    styleInstructions: ''
  });
  writeFileSync(join(task.dir, 'result.json'), JSON.stringify(draft));
  await app.importTask(task.id);
  const [run] = repo.listRuns(projectId);
  expect(run.status).toBe('waiting');
  expect(
    repo
      .phasesFor([run.id])
      .slice(0, 2)
      .map((p) => p.status)
  ).toEqual(['done', 'done']);
});

it('rolls back creation when a preset result is invalid', () => {
  expect(() =>
    orchestrator.create({
      projectId,
      kind: 'production',
      plan: plan(['script']),
      done: { script: done(1n) }
    })
  ).toThrow();
  expect(repo.listRuns(projectId)).toEqual([]);
});

it('resumes a failed render in a child without rerunning completed phases', async () => {
  failRender = true;
  await app.sendPrompt(projectId, prompt);
  const [run] = repo.listRuns(projectId);
  const [failed] = repo.listRevisions(projectId);
  expect(run.status).toBe('failed');
  expect(failed.status).toBe('failed');
  const script = repo.phasesFor([run.id]).find((p) => p.phase === 'script');
  failRender = false;
  app = studio();
  await app.resumeProduction(run.id);
  const child = repo.listRevisions(projectId).at(-1)!;
  expect(child).toMatchObject({
    parentRevisionId: failed.id,
    status: 'awaiting_approval',
    storyboard: failed.storyboard
  });
  expect(repo.getRevision(failed.id)).toEqual(failed);
  expect(repo.phasesFor([run.id]).find((p) => p.phase === 'script')).toEqual(script);
  expect(repo.getRun(run.id)).toMatchObject({ status: 'waiting', revisionId: child.id });
});

it('resumes a run orphaned by a crash, from a new orchestrator over the same database', async () => {
  const run = create(plan(['script', 'motion']));
  // The process died while the script phase was running.
  repo.updatePhase(orchestrator.phases(run.id)[0].id, { status: 'running', attempts: 1 });
  const fresh = new Orchestrator(repo, () => {});
  const script = vi.fn(async () => done(draft));
  const result = await fresh.resume(run.id, {
    script: { run: script },
    motion: { run: async () => done(motionPayload) }
  });
  expect(result.status).toBe('completed');
  expect(script).toHaveBeenCalledTimes(1);
});

it('resumes a crashed run that the UI stopped before resuming it', async () => {
  const run = create(plan(['script', 'motion']));
  repo.updatePhase(orchestrator.phases(run.id)[0].id, { status: 'running', attempts: 1 });
  const fresh = new Orchestrator(repo, () => {});
  // After a restart the panel only offers « Arrêter » on a 'running' run.
  fresh.stop(run.id);
  const result = await fresh.resume(run.id, {
    script: { run: async () => done(draft) },
    motion: { run: async () => done(motionPayload) }
  });
  expect(result.status).toBe('completed');
});

it('keeps an approval given while the production is stopped', async () => {
  await app.sendPrompt(projectId, prompt);
  const [run] = repo.listRuns(projectId);
  app.stopProduction(run.id);
  app.approve(run.revisionId!);
  await app.resumeProduction(run.id);
  expect(repo.getRun(run.id).status).toBe('completed');
});

it('fails a phase whose payload breaks its contract, keeping the invalid envelope', async () => {
  const run = create(plan(['script', 'motion']));
  const result = await orchestrator.drive(run.id, {
    script: { run: async () => done(draft) },
    motion: { run: async () => done({ storyboard: 'x' }) }
  });
  expect(result.status).toBe('failed');
  const motion = orchestrator.phases(run.id).find((p) => p.phase === 'motion')!;
  expect(motion.status).toBe('failed');
  expect(motion.error).toMatch(/phase motion non conforme au contrat/);
  expect(motion.result).toMatchObject({ validation: 'invalid', agent: 'motion' });
  expect((motion.result!.errors as string[]).length).toBeGreaterThan(0);
});

it('records the revision rendered from its own target when another revision appears', async () => {
  onRender = () => {
    onRender = null;
    const now = Date.now() + 1000;
    repo.createRevision({
      id: newId('rev'),
      projectId,
      parentRevisionId: null,
      storyboard: { scenes: [], width: 1920, height: 1080, fps: 30 },
      audio: null,
      resolvedConfig: { origin: {}, aiProvider: 'none' },
      videoPath: null,
      error: null,
      createdAt: now,
      updatedAt: now
    });
  };
  await app.sendPrompt(projectId, prompt);
  const [run] = repo.listRuns(projectId);
  const [rendered, other] = repo.listRevisions(projectId);
  expect(other).toBeDefined();
  expect(run).toMatchObject({ status: 'waiting', revisionId: rendered.id });
  expect(rendered.status).toBe('awaiting_approval');
});

it('enforces the render budget across resumes', async () => {
  failRender = true;
  await app.sendPrompt(projectId, prompt);
  const [run] = repo.listRuns(projectId);
  for (let i = 1; i < run.plan.budget.maxRenders; i++) await app.resumeProduction(run.id);
  expect(renders).toBe(run.plan.budget.maxRenders);
  await app.resumeProduction(run.id);
  expect(renders).toBe(run.plan.budget.maxRenders);
  expect(repo.getRun(run.id)).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/Budget de rendus épuisé/)
  });
});

it('reports audio anchors that no longer resolve before rendering', async () => {
  const asset = await importWav('music.wav', 'music', 3);
  await app.sendPrompt(projectId, prompt);
  const [parent] = repo.listRevisions(projectId);
  await app.reviseAudio(parent.id, {
    schemaVersion: 1,
    tracks: [
      {
        id: newId('atr'),
        assetId: asset.id,
        category: 'music',
        label: 'Musique',
        anchor: {
          type: 'event',
          sceneId: parent.storyboard.scenes[0].id,
          event: 'absent',
          offsetMs: 0
        }
      }
    ]
  });
  const run = repo.listRuns(projectId).at(-1)!;
  const composition = repo.phasesFor([run.id]).find((p) => p.phase === 'composition')!;
  expect(composition.status).toBe('done');
  expect(composition.result).toMatchObject({
    validation: 'needs-human',
    warnings: [expect.stringMatching(/Événement absent/)]
  });
});
