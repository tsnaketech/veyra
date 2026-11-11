import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { FakeAiProvider } from '@veyra/ai';
import {
  agentResultSchema,
  toolLoopOutcomeSchema,
  type PermissionClass,
  type ToolExecutionRecord
} from '@veyra/schemas';
import { ProjectStorage } from '@veyra/storage';
import { runProcess } from '@veyra/video';
import { createRepository } from './db/repo';
import * as schema from './db/schema';
import { defaultConfigDir, loadRenderSettings, RenderJobRunner } from './jobs/runner';
import { Orchestrator } from './production';
import { loadStudioSettings, Studio } from './studio';
import { colorEngine } from './test-engines';
import { decidePermission, loopState, toolLoopRunner, type LoopView } from './tool-loop';
import { createToolRegistry, defineTool, studioTools, type ToolContext } from './tools';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * T129a: the controlled tool loop on a real Studio project. "[réel]" tests run real
 * processes (ffprobe, ffmpeg, sleep) through the registry and colorEngine renders (real
 * H.264 via ffmpeg, NOT HyperFrames: see tool-loop.slow.test.ts). "[simulé]" tests use
 * a labelled test tool (no network, no billing) or only exercise the loop's bookkeeping.
 * Step sources are scripted functions of the persisted history, never an AI.
 */
const saas =
  'Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.';
const LOCAL: PermissionClass[] = ['read-only', 'local-compute', 'writes-revision-artefacts'];
const marker = () => `veyra-t129a-${Math.random().toString(36).slice(2)}`;
/** Real liveness check: is a process whose argv contains `text` still running? */
const alive = (text: string) =>
  readdirSync('/proc')
    .filter((d) => /^\d+$/.test(d))
    .some((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(text);
      } catch {
        return false;
      }
    });
const until = async (check: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end && !check();)
    await new Promise((r) => setTimeout(r, 25));
  return check();
};
const busyFfmpeg = (tag: string) => [
  '-nostdin',
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=1280x720:rate=60:duration=3600',
  '-metadata',
  `comment=${tag}`,
  '-f',
  'null',
  '-'
];
const tagInput = z.object({ tag: z.string().regex(/^veyra-t129a-[a-z0-9]+$/) }).strict();
const testMeta = {
  version: 1,
  network: 'none' as const,
  requires: [] as string[],
  capabilities: ['test'],
  produces: [] as string[],
  validation: ['zod'],
  deterministic: false
};
let billableRuns = 0;
// Test-only tools, registered next to the Studio tools in the same registry.
const testTools = [
  defineTool({
    meta: {
      ...testMeta,
      id: 'test.sleep',
      description: 'Processus long réel (sleep), annulable.',
      requires: ['prlimit'],
      permissions: ['local-compute'],
      sideEffects: 'artefacts',
      cost: { kind: 'local-cpu' },
      limits: { timeoutMs: 120_000 }
    },
    input: tagInput,
    output: z.object({}),
    async run({ tag }, ctx) {
      // The tag is a fractional duration: unique in /proc, and ~16 min if never killed.
      const seconds = `${900 + (parseInt(tag.slice(13, 19), 36) % 1000) / 1000}`;
      tags.set(tag, seconds);
      await runProcess('sleep', [seconds], {
        signal: ctx.signal,
        limits: ctx.processLimits,
        timeoutMs: 600_000
      });
      return {};
    }
  }),
  defineTool({
    meta: {
      ...testMeta,
      id: 'test.ffmpeg-slow',
      description: 'Encodage ffmpeg réel plus long que son délai.',
      requires: ['ffmpeg'],
      permissions: ['local-compute'],
      sideEffects: 'none',
      cost: { kind: 'local-cpu' },
      limits: { timeoutMs: 2_000 }
    },
    input: tagInput,
    output: z.object({}),
    async run({ tag }, ctx) {
      await runProcess('ffmpeg', busyFfmpeg(tag), {
        signal: ctx.signal,
        limits: ctx.processLimits,
        timeoutMs: 600_000
      });
      return {};
    }
  }),
  defineTool({
    meta: {
      ...testMeta,
      id: 'test.ffmpeg-cpu',
      description: 'Encodage ffmpeg réel borné à 1 s de CPU (prlimit).',
      requires: ['ffmpeg', 'prlimit'],
      permissions: ['local-compute'],
      sideEffects: 'none',
      cost: { kind: 'local-cpu' },
      limits: { timeoutMs: 60_000, cpuSeconds: 1, memoryBytes: 2 * 1024 ** 3 }
    },
    input: tagInput,
    output: z.object({}),
    async run({ tag }, ctx) {
      await runProcess('ffmpeg', busyFfmpeg(tag), {
        signal: ctx.signal,
        limits: ctx.processLimits,
        timeoutMs: 600_000
      });
      return {};
    }
  }),
  defineTool({
    meta: {
      ...testMeta,
      id: 'test.billable',
      description: '[Simulé] Action facturable de démonstration (aucun appel réseau).',
      permissions: ['billable'],
      sideEffects: 'external',
      cost: { kind: 'billable', microUsd: 1500 },
      limits: { timeoutMs: 5_000 }
    },
    simulated: true,
    input: z.object({ prompt: z.string().max(200) }).strict(),
    output: z.object({ done: z.literal(true) }),
    async run() {
      billableRuns++;
      return { done: true as const };
    }
  })
];
const tags = new Map<string, string>();

let root: string, client: Database.Database;
let repo: ReturnType<typeof createRepository>;
let app: Studio, storage: ProjectStorage, ctx: ToolContext;
let orchestrator: Orchestrator;
let projectId: string, v1: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'veyra-loop-'));
  client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  repo = createRepository(db);
  const settings = loadStudioSettings(loadRenderSettings(), defaultConfigDir());
  storage = new ProjectStorage(join(root, 'projects'));
  const engine = colorEngine((id) => repo.getRevision(id).storyboard);
  app = new Studio(
    repo,
    new RenderJobRunner(repo, storage, engine, settings),
    new FakeAiProvider(),
    settings,
    storage
  );
  projectId = app.createProject('Boucle').id;
  await app.sendPrompt(projectId, saas);
  v1 = repo.listRevisions(projectId)[0].id;
  ctx = { repo, storage, settings, engine, studio: app, projectId };
  orchestrator = new Orchestrator(repo, () => {});
});
afterAll(() => {
  client.close();
  rmSync(root, { recursive: true, force: true });
});

type Source = (view: LoopView) => unknown;
function startLoop(
  source: Source,
  options: { grants?: PermissionClass[]; limits?: object; signal?: AbortSignal } = {},
  on = { repo, orchestrator, ctx }
) {
  const registry = createToolRegistry(on.ctx, [...studioTools, ...testTools]);
  const run = on.orchestrator.create({
    projectId,
    kind: 'revision',
    sourceRevisionId: v1,
    plan: {
      phases: [{ phase: 'plan', agent: 'director', dependsOn: [], maxAttempts: 1 }],
      budget: { maxAiCalls: 0, maxRenders: 0 },
      reason: 'Boucle d’outils scriptée (T129a)'
    }
  });
  const runners = {
    plan: toolLoopRunner({
      repo: on.repo,
      registry,
      source: { next: source },
      runId: run.id,
      grants: options.grants ?? LOCAL,
      limits: options.limits,
      signal: options.signal
    })
  };
  const phaseId = on.repo.phasesFor([run.id])[0].id;
  return {
    run,
    runners,
    registry,
    phaseId,
    drive: () => on.orchestrator.drive(run.id, runners),
    steps: () => on.repo.loopSteps(phaseId),
    state: () => loopState(on.repo, run.id, phaseId, toolLoopOutcomeLimits)
  };
}
const toolLoopOutcomeLimits = {
  maxSteps: 20,
  maxToolCalls: 40,
  maxConsecutiveFailures: 3,
  maxObservationBytes: 16384
};
/** Discovery: the version comes from the registry listing the source sees. */
const call = (view: LoopView, toolId: string, input: unknown, justification = 'Démonstration') => {
  const tool = view.tools.find((t) => t.meta.id === toolId);
  return {
    action: 'tool_call',
    toolId,
    toolVersion: tool?.meta.version ?? 1,
    input,
    justification
  };
};
const tried = (view: LoopView, toolId: string) =>
  view.history.filter((r) => r.invocation?.toolId === toolId);
const output = <T>(row: ToolExecutionRecord | undefined) =>
  (row?.result?.ok ? row.result.output : undefined) as T | undefined;

it('[réel] boucle scriptée : découverte, ffprobe, outil indisponible, entrée corrigée, frame ffmpeg, revision.apply, approbation', async () => {
  const parent = repo.getRevision(v1);
  const [, target, ...others] = parent.storyboard.scenes;
  let sawTools: string[] = [];
  const loop = startLoop((view) => {
    sawTools = view.tools.map((t) => t.meta.id);
    const inspected = output<{ frameCount: number }>(tried(view, 'media.inspect').at(-1));
    if (!inspected) return call(view, 'media.inspect', { revisionId: v1 }, 'Mesurer le rendu');
    if (!tried(view, 'transcription.local-asr').length)
      return call(view, 'transcription.local-asr', { assetId: 'ast_absent' }, 'Transcrire');
    const frames = tried(view, 'media.frame');
    // First attempt has a wrong argument; the source reads the refusal and corrects it.
    if (!frames.length)
      return call(view, 'media.frame', { revisionId: v1, frameIndex: -1 }, 'Frame (erreur)');
    if (!frames.some((r) => r.status === 'done'))
      return call(view, 'media.frame', {
        revisionId: v1,
        frameIndex: Math.floor(inspected.frameCount / 2)
      });
    const applied = output<{ revisionId: string }>(tried(view, 'revision.apply').at(-1));
    if (!applied)
      return call(view, 'revision.apply', {
        revisionId: v1,
        operations: [
          { op: 'scene.update', sceneId: target.id, patch: { text: 'Modifié par la boucle' } }
        ]
      });
    return {
      action: 'request_approval',
      revisionId: applied.revisionId,
      summary: 'Scène 2 modifiée'
    };
  });
  const run = await loop.drive();
  expect(run.status).toBe('completed');
  expect(sawTools).toEqual(
    expect.arrayContaining(['media.inspect', 'revision.apply', 'test.sleep'])
  );

  const steps = loop.steps();
  expect(
    steps.map((s) => [s.invocation?.toolId ?? s.action, s.status, s.error?.code ?? null])
  ).toEqual([
    ['media.inspect', 'done', null],
    ['transcription.local-asr', 'failed', 'unavailable'],
    ['media.frame', 'failed', 'invalid-input'],
    ['media.frame', 'done', null],
    ['revision.apply', 'done', null],
    ['request_approval', 'done', null]
  ]);
  expect(steps[1].error?.installHint).toMatch(/T118/);
  for (const s of steps.slice(0, 5)) expect(s.result?.simulated).toBe(false);
  // Exact frame written by real ffmpeg in the call's own folder, with its sha256.
  const [png] = steps[3].result!.artefacts;
  expect(png.kind).toBe('png');
  expect(existsSync(join(storage.root, png.path))).toBe(true);
  expect(png.path).toMatch(/\/tool-calls\/tcl_[^/]+\/frame-\d+\.png$/);

  // Child revision: target scene changed, other scenes and the parent untouched.
  const childId = output<{ revisionId: string }>(steps[4])!.revisionId;
  const child = repo.getRevision(childId);
  expect(child).toMatchObject({ parentRevisionId: v1, status: 'draft', videoPath: null });
  expect(child.storyboard.scenes.find((s) => s.id === target.id)?.text).toBe(
    'Modifié par la boucle'
  );
  for (const scene of [parent.storyboard.scenes[0], ...others])
    expect(child.storyboard.scenes.find((s) => s.id === scene.id)).toEqual(scene);
  expect(repo.getRevision(v1)).toEqual(parent);

  // Phase result: validated agent envelope carrying the persisted loop state.
  expect(run.revisionId).toBe(childId);
  const envelope = agentResultSchema(toolLoopOutcomeSchema).parse(
    repo.phasesFor([run.id])[0].result
  );
  expect(envelope).toMatchObject({ agent: 'director', phase: 'plan', provider: 'rules' });
  expect(envelope.payload.loop).toMatchObject({
    status: 'completed',
    step: 6,
    counters: { steps: 6, toolCalls: 5 },
    costMicroUsd: 0
  });
});

it('[réel] refus : permission absente → revision.apply non exécuté ; [simulé] action facturable refusée jamais exécutée, même redemandée', async () => {
  const revisions = repo.listRevisions(projectId).length;
  const loop = startLoop(
    (view) => {
      if (!tried(view, 'revision.apply').length)
        return call(view, 'revision.apply', {
          revisionId: v1,
          operations: [{ op: 'captions.delivery', mode: 'clean' }]
        });
      // Asks twice for the same billable action: the second ask is refused without a pause.
      if (tried(view, 'test.billable').length < 2)
        return call(view, 'test.billable', { prompt: 'générer une image' }, 'Image générée');
      return { action: 'stop', reason: 'Action refusée, rien d’autre à faire' };
    },
    { grants: ['read-only', 'local-compute'] }
  );
  expect((await loop.drive()).status).toBe('waiting');
  expect(loop.state()).toMatchObject({ status: 'paused-awaiting-permission' });
  const [denied, pending] = loop.steps();
  expect(denied).toMatchObject({ status: 'failed', error: { code: 'permission-denied' } });
  expect(pending).toMatchObject({ status: 'awaiting-permission', startedAt: null });
  expect(loop.state().pendingStepId).toBe(pending.id);

  decidePermission(repo, loop.phaseId, pending.id, false);
  const run = await orchestrator.wake(loop.run.id, 'plan', loop.runners);
  expect(run.status).toBe('failed');
  expect(loop.steps().map((s) => [s.status, s.error?.code ?? null])).toEqual([
    ['failed', 'permission-denied'],
    ['denied', 'permission-denied'],
    ['failed', 'permission-denied'],
    ['done', null]
  ]);
  expect(loop.state().status).toBe('stopped');
  expect(billableRuns).toBe(0);
  expect(repo.listRevisions(projectId)).toHaveLength(revisions);
});

it('[simulé] action facturable : pause persistée, autorisation explicite après « redémarrage », exécution unique, coût déclaré', async () => {
  const before = billableRuns;
  const source: Source = (view) =>
    tried(view, 'test.billable').some((r) => r.status === 'done')
      ? { action: 'request_approval', revisionId: null, summary: 'Fait' }
      : call(view, 'test.billable', { prompt: 'une image' });
  const loop = startLoop(source, { grants: [...LOCAL, 'billable'] });
  expect((await loop.drive()).status).toBe('waiting');
  const [pending] = loop.steps();
  // Even with 'billable' in the phase grants, this very call waits for a human decision.
  expect(pending.status).toBe('awaiting-permission');
  expect(billableRuns).toBe(before);

  // A new orchestrator on the same database (Studio restarted): the pause survived.
  const restarted = new Orchestrator(repo, () => {});
  decidePermission(repo, loop.phaseId, pending.id, true);
  expect(() => decidePermission(repo, loop.phaseId, pending.id, true)).toThrow();
  expect((await restarted.wake(loop.run.id, 'plan', loop.runners)).status).toBe('completed');
  expect(billableRuns).toBe(before + 1);
  const [done] = loop.steps();
  expect(done).toMatchObject({ status: 'done', costMicroUsd: 1500 });
  expect(done.result).toMatchObject({
    simulated: true,
    cost: { kind: 'billable', microUsd: 1500 }
  });
  expect(loop.state()).toMatchObject({ status: 'completed', costMicroUsd: 1500 });
});

it('[réel] délai dépassé : ffmpeg réel tué à l’échéance de l’outil (processus vérifié mort)', async () => {
  const tag = marker();
  const loop = startLoop((view) =>
    tried(view, 'test.ffmpeg-slow').length
      ? { action: 'stop', reason: 'Délai dépassé' }
      : call(view, 'test.ffmpeg-slow', { tag })
  );
  const driving = loop.drive();
  expect(await until(() => alive(tag))).toBe(true);
  await driving;
  expect(await until(() => !alive(tag))).toBe(true);
  const [step] = loop.steps();
  expect(step).toMatchObject({ status: 'failed', error: { code: 'timeout' } });
  expect(step.durationMs).toBeLessThan(10_000);
  expect(loop.state().status).toBe('stopped');
});

it('[réel] limite CPU par outil : prlimit --cpu=1 arrête un ffmpeg réel bien avant son délai', async () => {
  const tag = marker();
  const registry = createToolRegistry(ctx, testTools);
  const started = Date.now();
  const result = await registry.invoke('test.ffmpeg-cpu', { tag }, { grants: ['local-compute'] });
  expect(result).toMatchObject({ ok: false, error: { code: 'failed' } });
  expect(Date.now() - started).toBeLessThan(30_000);
  expect(await until(() => !alive(tag))).toBe(true);
});

it('[réel] annulation : l’AbortSignal de la boucle tue le processus en cours et termine la boucle', async () => {
  const tag = marker();
  const controller = new AbortController();
  const loop = startLoop(
    (view) =>
      tried(view, 'test.sleep').length
        ? { action: 'stop', reason: 'x' }
        : call(view, 'test.sleep', { tag }),
    { signal: controller.signal }
  );
  const driving = loop.drive();
  expect(await until(() => tags.has(tag) && alive(`sleep\0${tags.get(tag)}`))).toBe(true);
  controller.abort();
  expect((await driving).status).toBe('failed');
  expect(await until(() => !alive(`sleep\0${tags.get(tag)}`))).toBe(true);
  expect(loop.steps().map((s) => s.status)).toEqual(['cancelled']);
  expect(loop.state()).toMatchObject({ status: 'failed', error: 'Boucle d’outils annulée' });
});

it('[réel] reprise après interruption : base rouverte, reprise au bon pas, aucun pas terminé rejoué', async () => {
  const tag = marker();
  // A pure function of the persisted history: it resumes wherever the loop stopped.
  const source: Source = (view) => {
    if (!tried(view, 'media.inspect').length)
      return call(view, 'media.inspect', { revisionId: v1 });
    if (!tried(view, 'media.frame').length)
      return call(view, 'media.frame', { revisionId: v1, frameIndex: 0 });
    const slept = tried(view, 'test.sleep');
    if (!slept.length) return call(view, 'test.sleep', { tag });
    return { action: 'request_approval', revisionId: null, summary: `sleep : ${slept[0].status}` };
  };
  const controller = new AbortController();
  const first = startLoop(source, { signal: controller.signal });
  const driving = first.drive();
  expect(await until(() => tags.has(tag) && alive(`sleep\0${tags.get(tag)}`), 30_000)).toBe(true);
  // Crash snapshot: the database as a killed Studio would leave it (step 2 'running').
  const file = join(root, 'crash.db');
  client.exec(`VACUUM INTO '${file}'`);
  controller.abort();
  await driving;

  const reopened = new Database(file);
  reopened.pragma('foreign_keys = ON');
  const repo2 = createRepository(drizzle(reopened, { schema }));
  try {
    expect(repo2.getRun(first.run.id).status).toBe('running');
    expect(repo2.loopSteps(first.phaseId).map((s) => s.status)).toEqual([
      'done',
      'done',
      'running'
    ]);
    const frames = readdirSync(join(storage.root, projectId, 'tool-calls')).length;
    const orchestrator2 = new Orchestrator(repo2, () => {});
    const registry2 = createToolRegistry({ ...ctx, repo: repo2 }, [...studioTools, ...testTools]);
    const runners = {
      plan: toolLoopRunner({
        repo: repo2,
        registry: registry2,
        source: { next: source },
        runId: first.run.id,
        grants: LOCAL
      })
    };
    expect((await orchestrator2.resume(first.run.id, runners)).status).toBe('completed');
    const steps = repo2.loopSteps(first.phaseId);
    expect(steps.map((s) => [s.step, s.invocation?.toolId ?? s.action, s.status])).toEqual([
      [0, 'media.inspect', 'done'],
      [1, 'media.frame', 'done'],
      [2, 'test.sleep', 'interrupted'],
      [3, 'request_approval', 'done']
    ]);
    expect(steps[2].error?.code).toBe('interrupted');
    // Nothing re-executed after the restart: no call in the new registry, no new folder.
    expect(registry2.history).toEqual([]);
    expect(readdirSync(join(storage.root, projectId, 'tool-calls'))).toHaveLength(frames);
  } finally {
    reopened.close();
  }
});

it('[réel] reprise : un appel déterministe et sans effet de bord coupé en cours est rejoué une fois', async () => {
  const loop = startLoop((view) =>
    tried(view, 'media.inspect').some((r) => r.status === 'done')
      ? { action: 'request_approval', revisionId: null, summary: 'Mesuré' }
      : call(view, 'media.inspect', { revisionId: v1 })
  );
  // [simulé] crash: the step row is written as a killed Studio would leave it.
  const now = Date.now();
  repo.createLoopStep({
    id: 'stp_crash',
    runId: loop.run.id,
    phaseId: loop.phaseId,
    step: 0,
    origin: 'source',
    action: 'tool_call',
    request: { action: 'tool_call' },
    invocation: {
      stepId: 'stp_crash',
      runId: loop.run.id,
      phaseId: loop.phaseId,
      agent: 'director',
      phase: 'plan',
      toolId: 'media.inspect',
      toolVersion: 1,
      input: { revisionId: v1 },
      inputHash: 'a'.repeat(64),
      grants: LOCAL
    },
    status: 'running',
    startedAt: now,
    createdAt: now,
    updatedAt: now
  });
  expect((await loop.drive()).status).toBe('completed');
  expect(loop.registry.history.map((r) => [r.toolId, r.ok])).toEqual([['media.inspect', true]]);
  expect(loop.steps().map((s) => s.status)).toEqual(['done', 'done']);
});

it('[simulé] bornes : limite de pas, limite d’appels, échecs consécutifs, appel identique répété, sortie tronquée', async () => {
  const sceneId = repo.getRevision(v1).storyboard.scenes[0].id;
  const forever: Source = (view) =>
    call(view, 'scene.patch', {
      revisionId: v1,
      changes: [{ sceneId, patch: { text: 'Aperçu' } }]
    });
  const steps = startLoop(forever, { limits: { maxSteps: 4, maxObservationBytes: 1024 } });
  expect((await steps.drive()).status).toBe('failed');
  expect(steps.state()).toMatchObject({ status: 'stopped', error: 'limite de 4 pas atteinte' });
  expect(steps.steps().at(-1)).toMatchObject({ origin: 'engine', action: 'stop' });
  expect(steps.steps()).toHaveLength(4);
  // scene.patch returns the whole storyboard (> 1 KiB): persisted as a bounded preview.
  expect(steps.steps()[0].result).toMatchObject({ output: { truncated: true } });

  const calls = startLoop(forever, { limits: { maxToolCalls: 2 } });
  await calls.drive();
  expect(calls.state().error).toBe('limite de 2 appels d’outils atteinte');
  expect(calls.state().counters.toolCalls).toBe(2);

  const garbage = startLoop(() => ({ action: 'shell', command: 'rm -rf /' }));
  await garbage.drive();
  expect(garbage.state().error).toBe('3 échecs consécutifs');
  expect(
    garbage
      .steps()
      .slice(0, 3)
      .map((s) => s.error?.code)
  ).toEqual(Array(3).fill('invalid-input'));

  const same = startLoop((view) =>
    call(view, 'media.frame', { revisionId: v1, frameIndex: 10 ** 9 })
  );
  await same.drive();
  expect(same.state().error).toBe('appel identique en échec répété (media.frame)');
  expect(same.steps()).toHaveLength(3);
});
