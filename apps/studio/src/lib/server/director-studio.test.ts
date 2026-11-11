import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistedProvider, FakeAiProvider, type CallOptions, type DirectorView } from '@veyra/ai';
import type { DirectorStep } from '@veyra/schemas';
import { ProjectStorage } from '@veyra/storage';
import { createRepository } from './db/repo';
import * as schema from './db/schema';
import { defaultConfigDir, loadRenderSettings, RenderJobRunner } from './jobs/runner';
import { loadStudioSettings, Studio } from './studio';
import { colorEngine } from './test-engines';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * T129b-2: the Director in the Studio. "[simulé]" = the labelled simulated Director
 * (provider fake) or a scripted stub of decideStep (no model, no network, no Codex).
 * "[réel]" = real processes behind the tools and the render: ffprobe, ffmpeg and
 * colorEngine (real H.264, NOT HyperFrames). Route actions are called as SvelteKit would.
 */
const state = vi.hoisted(() => ({ app: null as unknown }));
vi.mock('#lib/server/jobs/index.ts', () => ({
  get studio() {
    return state.app;
  },
  settings: {},
  providerLocked: true,
  providerError: null,
  knownAvailability: null,
  providerAvailability: async () => ({}),
  chooseProjectProvider: async () => {}
}));
const { actions } = await import('../../routes/projects/[id]/+page.server');

const saas =
  'Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.';
const goal =
  'Rends la scène 2 plus dynamique, conserve les autres scènes ainsi que la voix off, puis vérifie le résultat';

let root: string, client: Database.Database;
let repo: ReturnType<typeof createRepository>;
let app: Studio;
let projectId: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'veyra-director-studio-'));
  client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  repo = createRepository(db);
  const settings = loadStudioSettings(loadRenderSettings(), defaultConfigDir());
  const storage = new ProjectStorage(join(root, 'projects'));
  const engine = colorEngine((id) => repo.getRevision(id).storyboard);
  app = new Studio(
    repo,
    new RenderJobRunner(repo, storage, engine, settings),
    new FakeAiProvider(),
    settings,
    storage
  );
  state.app = app;
  projectId = app.createProject('Director dans le Studio').id;
  await app.sendPrompt(projectId, saas);
  // A voice-off on the first scene: narration, then a simulated voice track (real mix).
  const v1 = repo.listRevisions(projectId)[0];
  await app.setNarration(
    v1.id,
    v1.storyboard.scenes[0].id,
    'Voici Pilot, pour les petites équipes.'
  );
  const v2 = repo.listRevisions(projectId).at(-1)!;
  await app.generateVoice(v2.id, v2.storyboard.scenes[0].id, 'fake');
});
afterAll(() => {
  client.close();
  rmSync(root, { recursive: true, force: true });
});

const head = () => repo.listRevisions(projectId).at(-1)!;
const planPhase = (runId: string) => repo.phasesFor([runId]).find((p) => p.phase === 'plan')!;
const phase = (runId: string, name: string) =>
  repo.phasesFor([runId]).find((p) => p.phase === name)!;
/** Background work started by an action has settled (the page would poll until then). */
const settled = (runId: string) =>
  vi.waitFor(
    () => {
      if (app.activityFor(projectId) || repo.getRun(runId).status === 'running')
        throw new Error('en cours');
    },
    { timeout: 120_000, interval: 50 }
  );
const post = (action: keyof typeof actions, fields: Record<string, string>) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request(`http://127.0.0.1/projects/${projectId}?/${action}`, {
    method: 'POST',
    body
  });
  return (actions[action] as (e: unknown) => Promise<unknown>)({
    params: { id: projectId },
    request
  });
};

it('[simulé Director, réel ffmpeg] edit request in the chat: real tools, rendered child, QA, human approval pending', async () => {
  const parent = head();
  expect(parent.status).toBe('awaiting_approval');
  const voice = parent.audio?.tracks.find((t) => t.category === 'voiceover');
  expect(voice).toBeTruthy();
  const runsBefore = repo.listRuns(projectId).length;

  await post('prompt', { prompt: goal });
  const run = repo.listRuns(projectId).at(-1)!;
  expect(repo.listRuns(projectId)).toHaveLength(runsBefore + 1);
  await settled(run.id);

  // One revision run through the single orchestrator; the plan phase is the tool loop.
  expect(run.kind).toBe('revision');
  expect(run.sourceRevisionId).toBe(parent.id);
  expect(run.plan.phases.map((p) => `${p.phase}:${p.agent}`)).toEqual([
    'plan:director',
    'render:engine',
    'qa:qa-expert',
    'human-approval:human'
  ]);
  const steps = repo.loopSteps(planPhase(run.id).id);
  const executed = steps.filter((s) => s.status === 'done' && s.invocation);
  expect(executed.map((s) => s.invocation!.toolId)).toEqual(['media.inspect', 'revision.apply']);
  // Grants from the validated plan: local classes only.
  expect(executed[1].invocation!.grants).toEqual([
    'read-only',
    'local-compute',
    'writes-revision-artefacts'
  ]);
  expect(steps.every((s) => s.origin === 'source')).toBe(true);
  expect(String((steps[0].request as { justification: string }).justification)).toMatch(
    /^\[Simulé\] Director/
  );

  // The child: rendered by the real test engine, QA run, awaiting the human decision.
  const childId = repo.getRun(run.id).revisionId!;
  const child = repo.getRevision(childId);
  expect(child.parentRevisionId).toBe(parent.id);
  expect(child.status).toBe('awaiting_approval');
  expect(child.videoPath && existsSync(child.videoPath)).toBeTruthy();
  expect(repo.renderJobsFor([childId]).map((j) => j.status)).toEqual(['succeeded']);
  expect(repo.reportsFor([childId]).at(-1)!.checks.length).toBeGreaterThan(0);
  expect(phase(run.id, 'qa').status).toBe('done');
  expect(phase(run.id, 'human-approval').status).toBe('waiting');
  expect(repo.getRun(run.id).status).toBe('waiting');
  // T129b-3 (I2): the parent stays validable until the child is approved.
  expect(repo.getRevision(parent.id).status).toBe('awaiting_approval');
  // M3: the child records the provider that decided it; the run froze it at its start.
  expect(child.resolvedConfig.aiProvider).toBe('fake');
  expect(repo.getRun(run.id).brief?.provider).toEqual({ kind: 'fake', model: null });

  // Scene 2 changed; every other scene, every narration and the voice-off are identical.
  const before = parent.storyboard.scenes;
  const after = child.storyboard.scenes;
  expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
  before.forEach((scene, i) => {
    if (i === 1) {
      expect(after[i].animation).not.toEqual(scene.animation);
      expect({ ...after[i], animation: null }).toEqual({ ...scene, animation: null });
    } else expect(after[i]).toEqual(scene);
  });
  expect(after.map((s) => s.narration ?? null)).toEqual(before.map((s) => s.narration ?? null));
  expect(child.audio).toEqual(parent.audio);
  expect(child.captions).toEqual(parent.captions);

  // Page data: model decisions, labelled, apart from the fixed steps.
  const history = app.snapshot(projectId)!.director.at(-1)!;
  expect(history.provider).toBe('fake');
  expect(history.steps.every((s) => s.provider === 'fake')).toBe(true);
  expect(history.steps.map((s) => s.toolId ?? s.action)).toEqual([
    'revise_plan',
    'media.inspect',
    'revision.apply',
    'request_approval'
  ]);
  const messages = app.snapshot(projectId)!.messages.map((m) => m.text);
  expect(
    messages.some((t) => t.startsWith('[Simulé] Demande de montage confiée au Director'))
  ).toBe(true);
});

/** Scripted decideStep: reacts to the observed history (stub, no model). */
class Scripted extends FakeAiProvider {
  blockOnce = true;
  override async decideStep(view: DirectorView, call?: CallOptions): Promise<DirectorStep> {
    const last = view.history.at(-1);
    const rev = view.project.revisionId;
    if (!last)
      return {
        action: 'request_permission',
        toolId: 'media.inspect',
        toolVersion: 1,
        input: { revisionId: rev },
        justification: 'Mesurer la vidéo avant de décider'
      };
    if (last.status === 'denied')
      return { action: 'ask_user', question: 'Mesure refusée : que faire ?', justification: 'x' };
    if (last.action === 'ask_user') {
      // Blocks once until « Arrêter » aborts this decision.
      if (this.blockOnce) {
        this.blockOnce = false;
        await new Promise((_, reject) =>
          call?.signal?.addEventListener('abort', () => reject(new Error('annulé')), {
            once: true
          })
        );
      }
      return {
        action: 'request_permission',
        toolId: 'media.frame',
        toolVersion: 1,
        input: { revisionId: rev, frameIndex: 0 },
        justification: 'Extraire une image'
      };
    }
    return { action: 'request_approval', revisionId: rev, summary: 'Vérifié' };
  }
}

it('[simulé stub, réel ffmpeg] permission denied and granted, question answered, stop and resume through the actions', async () => {
  const scripted = new Scripted();
  app.setProvider(scripted);
  const source = head();
  expect(source.status).toBe('awaiting_approval');
  await post('prompt', { prompt: 'Vérifie la vidéo' });
  const run = repo.listRuns(projectId).at(-1)!;
  await settled(run.id);
  const loop = () => repo.loopSteps(planPhase(run.id).id);

  // 1. Permission requested: the run waits; refusing it never runs the tool.
  expect(repo.getRun(run.id).status).toBe('waiting');
  const asked = loop().at(-1)!;
  expect(asked).toMatchObject({ action: 'request_permission', status: 'awaiting-permission' });
  // A paused Director blocks a second request (no second loop on the same project).
  expect(await post('prompt', { prompt: 'Autre chose' })).toMatchObject({ status: 400 });
  expect(
    await post('decideDirector', { runId: run.id, stepId: asked.id, decision: 'maybe' })
  ).toMatchObject({ status: 400 });
  await post('decideDirector', { runId: run.id, stepId: asked.id, decision: 'deny' });
  await settled(run.id);
  expect(loop().find((s) => s.id === asked.id)).toMatchObject({
    status: 'denied',
    startedAt: null
  });

  // 2. Question: answered in the page; the answer grants nothing.
  const question = loop().at(-1)!;
  expect(question).toMatchObject({ action: 'ask_user', status: 'awaiting-permission' });
  expect(app.snapshot(projectId)!.messages.at(-1)!.text).toMatch(/Question du Director/);
  // Wrong run id (not this project's) is refused.
  expect(
    await post('answerDirector', { runId: 'run_autre', stepId: question.id, answer: 'x' })
  ).toMatchObject({ status: 400 });
  await post('answerDirector', { runId: run.id, stepId: question.id, answer: 'Extrais une image' });

  // 3. « Arrêter » during the next decision: really aborted, then resumed.
  await vi.waitFor(() => expect(scripted.blockOnce).toBe(false));
  await post('stopProduction', { runId: run.id });
  await settled(run.id);
  expect(repo.getRun(run.id).status).toBe('stopped');
  expect(planPhase(run.id).status).toBe('failed');
  await post('resumeProduction', { runId: run.id });
  await settled(run.id);
  const frame = loop().at(-1)!;
  expect(frame).toMatchObject({ action: 'request_permission', status: 'awaiting-permission' });
  expect(frame.invocation!.toolId).toBe('media.frame');

  // 4. Granted: only this call runs (real ffmpeg), then the source is proposed again.
  await post('decideDirector', { runId: run.id, stepId: frame.id, decision: 'grant' });
  await settled(run.id);
  expect(loop().find((s) => s.id === frame.id)).toMatchObject({ status: 'done' });
  expect(repo.getRun(run.id).revisionId).toBe(source.id);
  expect(phase(run.id, 'render').result).toMatchObject({ payload: { status: 'reused' } });
  expect(phase(run.id, 'human-approval').status).toBe('waiting');
  // Human approval stays the final step.
  await post('approve', { revisionId: source.id });
  await vi.waitFor(() => expect(repo.getRun(run.id).status).toBe('completed'));
  app.setProvider(new FakeAiProvider());
});

it('[simulé] provider without the director capability: current behaviour (new video), said in the chat', async () => {
  class NoDirector extends FakeAiProvider {
    override decideStep = undefined as never;
  }
  app.setProvider(new NoDirector());
  const project = app.createProject('Sans Director').id;
  await app.sendPrompt(project, saas);
  expect(repo.listRevisions(project).at(-1)!.status).toBe('awaiting_approval');
  await app.sendPrompt(project, goal);
  const runs = repo.listRuns(project);
  expect(runs.map((r) => r.kind)).toEqual(['production', 'production']);
  expect(app.snapshot(project)!.messages.map((m) => m.text)).toContainEqual(
    expect.stringMatching(/Montage par le Director indisponible pour fake/)
  );
  app.setProvider(new FakeAiProvider());
});

it('[simulé stub] decideDirector/answerDirector: a paused run of another project is refused, its step untouched', async () => {
  app.setProvider(new Scripted());
  const other = app.createProject('Projet étranger').id;
  await app.sendPrompt(other, saas);
  await app.sendPrompt(other, 'Vérifie la vidéo');
  const foreign = repo.listRuns(other).at(-1)!;
  await vi.waitFor(() => expect(repo.getRun(foreign.id).status).toBe('waiting'), {
    timeout: 120_000
  });
  const step = repo.loopSteps(planPhase(foreign.id).id).at(-1)!;
  expect(step).toMatchObject({ action: 'request_permission', status: 'awaiting-permission' });
  // Posted from this project's page with the other project's real run and step ids.
  for (const [action, fields] of [
    ['decideDirector', { decision: 'grant' }],
    ['answerDirector', { answer: 'oui' }]
  ] as const)
    expect(await post(action, { runId: foreign.id, stepId: step.id, ...fields })).toMatchObject({
      status: 400
    });
  expect(repo.loopSteps(planPhase(foreign.id).id).find((s) => s.id === step.id)).toMatchObject({
    status: 'awaiting-permission',
    startedAt: null
  });
  expect(repo.getRun(foreign.id).status).toBe('waiting');
  app.stopProduction(foreign.id);
  app.setProvider(new FakeAiProvider());
});

it('[simulé] assisted mode (claude-subscribe): an edit request is never routed to the Director, nothing runs', async () => {
  const project = app.createProject('Mode assisté').id;
  await app.sendPrompt(project, saas);
  expect(repo.listRevisions(project).at(-1)!.status).toBe('awaiting_approval');
  expect(app.directorEdits(project)).toBe(true);
  app.setProvider(new AssistedProvider());
  try {
    // M1: the page does not announce an edit of the pending video for this provider.
    expect(app.directorEdits(project)).toBe(false);
    await app.sendPrompt(project, goal);
    expect(repo.listRuns(project).map((r) => r.kind)).toEqual(['production', 'production']);
    expect(app.snapshot(project)!.director).toEqual([]);
    expect(app.snapshot(project)!.messages.map((m) => m.text)).toContainEqual(
      expect.stringMatching(/Montage par le Director indisponible pour claude-subscribe/)
    );
  } finally {
    app.setProvider(new FakeAiProvider());
  }
});

/** Fresh project with a rendered revision awaiting approval, then an edit by the simulated Director. */
async function directorChild(name: string) {
  const project = app.createProject(name).id;
  await app.sendPrompt(project, saas);
  const parent = repo.listRevisions(project).at(-1)!;
  await app.sendPrompt(project, 'Rends la scène 2 plus dynamique');
  const run = repo.listRuns(project).at(-1)!;
  await vi.waitFor(
    () => {
      if (app.activityFor(project) || repo.getRun(run.id).status === 'running')
        throw new Error('en cours');
    },
    { timeout: 120_000, interval: 50 }
  );
  const child = repo.getRevision(repo.getRun(run.id).revisionId!);
  expect(child).toMatchObject({ parentRevisionId: parent.id, status: 'awaiting_approval' });
  return { project, parent: repo.getRevision(parent.id), child, run };
}

it('[simulé, réel ffmpeg] I2: the original stays validable while the child waits; approving one closes the other', async () => {
  // Refusing the child = approving the original: the child is closed, never the other way.
  const a = await directorChild('I2 original');
  expect(a.parent.status).toBe('awaiting_approval');
  expect(app.snapshot(a.project)!.messages.map((m) => m.text)).toContainEqual(
    expect.stringMatching(/reste validable : elle n'est remplacée que si vous validez/)
  );
  app.approve(a.parent.id);
  expect(repo.getRevision(a.parent.id).status).toBe('approved');
  expect(repo.getRevision(a.child.id).status).toBe('changes_requested');
  await vi.waitFor(() => expect(repo.getRun(a.run.id).status).toBe('completed'));

  // Approving the child closes the original and completes its production's approval.
  const b = await directorChild('I2 enfant');
  const production = repo.listRuns(b.project)[0];
  expect(repo.getRun(production.id).status).toBe('waiting');
  app.approve(b.child.id);
  expect(repo.getRevision(b.parent.id).status).toBe('changes_requested');
  await vi.waitFor(() => expect(repo.getRun(production.id).status).toBe('completed'));
  await vi.waitFor(() => expect(repo.getRun(b.run.id).status).toBe('completed'));
});

it('[simulé stub] provider frozen per run: resuming or answering with another provider is refused; direct calls check the project', async () => {
  class Model extends Scripted {
    constructor(readonly model: string) {
      super();
    }
  }
  app.setProvider(new Model('modele-a'));
  try {
    const project = app.createProject('Fournisseur figé').id;
    await app.sendPrompt(project, saas);
    await app.sendPrompt(project, 'Vérifie la vidéo');
    const run = repo.listRuns(project).at(-1)!;
    await vi.waitFor(() => expect(repo.getRun(run.id).status).toBe('waiting'), {
      timeout: 120_000
    });
    expect(repo.getRun(run.id).brief?.provider).toEqual({ kind: 'fake', model: 'modele-a' });
    const step = repo.loopSteps(planPhase(run.id).id).at(-1)!;
    expect(step).toMatchObject({ action: 'request_permission', status: 'awaiting-permission' });

    // Item 8: a direct call with another project's id is refused before any change.
    expect(() => app.decideDirector(projectId, run.id, step.id, true)).toThrow(
      /étrangère au projet/
    );
    expect(() => app.answerDirector(projectId, run.id, step.id, 'oui')).toThrow(
      /étrangère au projet/
    );
    expect(repo.loopSteps(planPhase(run.id).id).at(-1)).toMatchObject({
      status: 'awaiting-permission'
    });

    // Item 6: another model now: the decision cannot wake the run, resume is refused too.
    app.setProvider(new Model('modele-b'));
    expect(() => app.decideDirector(project, run.id, step.id, true)).toThrow(
      /Reprise refusée : ce montage a été commencé avec fake \(modele-a\).*fake \(modele-b\)/
    );
    app.stopProduction(run.id);
    await vi.waitFor(() => expect(repo.getRun(run.id).status).toBe('stopped'));
    expect(() => app.resumeProduction(run.id)).toThrow(/Reprise refusée/);
    expect(repo.getRun(run.id).status).toBe('stopped');
    // Every displayed step carries the run's provider, not the current one.
    const history = app.snapshot(project)!.director.at(-1)!;
    expect(history.provider).toBe('fake');
    expect(history.model).toBe('modele-a');
    expect(history.steps.filter((s) => s.origin === 'source').length).toBeGreaterThan(0);
    expect(new Set(history.steps.map((s) => s.provider))).toEqual(new Set(['fake']));

    // Back to the run's own provider: resuming works.
    app.setProvider(new Model('modele-a'));
    await app.resumeProduction(run.id);
    expect(repo.getRun(run.id).status).not.toBe('stopped');
    app.stopProduction(run.id);
  } finally {
    app.setProvider(new FakeAiProvider());
  }
});
