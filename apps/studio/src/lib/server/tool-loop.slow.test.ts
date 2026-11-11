import { afterAll, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAiProvider } from '@veyra/ai';
import { HyperFramesEngine } from '@veyra/hyperframes-adapter';
import { ProjectStorage } from '@veyra/storage';
import { createRepository } from './db/repo';
import * as schema from './db/schema';
import { defaultConfigDir, loadRenderSettings, RenderJobRunner } from './jobs/runner';
import { Orchestrator } from './production';
import { loadStudioSettings, Studio } from './studio';
import { colorEngine } from './test-engines';
import { toolLoopRunner } from './tool-loop';
import { missingRequirements, studioToolRegistry } from './tools';

// T129a: the loop calls the existing composition.check tool, which runs the real
// `hyperframes check` (bwrap, Chrome headless) when its requirements are present; otherwise
// the loop must observe 'unavailable' and say so. colorEngine only encodes the MP4 fast.
const root = mkdtempSync(join(tmpdir(), 'veyra-loop-slow-'));
const client = new Database(':memory:');
client.pragma('foreign_keys = ON');
const db = drizzle(client, { schema });
migrate(db, { migrationsFolder: './drizzle' });
const repo = createRepository(db);
afterAll(() => {
  client.close();
  rmSync(root, { recursive: true, force: true });
});

it('[réel] boucle : vérification HyperFrames par composition.check (ou indisponibilité déclarée)', async () => {
  const settings = loadStudioSettings(loadRenderSettings(), defaultConfigDir());
  const storage = new ProjectStorage(root);
  const fast = colorEngine((id) => repo.getRevision(id).storyboard);
  const app = new Studio(
    repo,
    new RenderJobRunner(repo, storage, fast, settings),
    new FakeAiProvider(),
    settings,
    storage
  );
  const project = app.createProject('Boucle HyperFrames');
  await app.sendPrompt(
    project.id,
    'Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.'
  );
  const [revision] = repo.listRevisions(project.id);
  const registry = studioToolRegistry({
    repo,
    storage,
    settings,
    engine: new HyperFramesEngine(settings.engine),
    studio: app,
    projectId: project.id
  });
  const orchestrator = new Orchestrator(repo, () => {});
  const run = orchestrator.create({
    projectId: project.id,
    kind: 'revision',
    sourceRevisionId: revision.id,
    plan: {
      phases: [{ phase: 'plan', agent: 'director', dependsOn: [], maxAttempts: 1 }],
      budget: { maxAiCalls: 0, maxRenders: 0 },
      reason: 'Vérification HyperFrames (T129a)'
    }
  });
  const runners = {
    plan: toolLoopRunner({
      repo,
      registry,
      runId: run.id,
      grants: ['read-only', 'local-compute'],
      source: {
        next: (view) =>
          view.history.length
            ? { action: 'request_approval', revisionId: null, summary: 'Composition vérifiée' }
            : {
                action: 'tool_call',
                toolId: 'composition.check',
                toolVersion: view.tools.find((t) => t.meta.id === 'composition.check')!.meta
                  .version,
                input: { revisionId: revision.id },
                justification: 'Vérifier la composition'
              }
      }
    })
  };
  expect((await orchestrator.drive(run.id, runners)).status).toBe('completed');
  const [step] = repo.loopSteps(repo.phasesFor([run.id])[0].id);
  const unmet = missingRequirements(['bwrap', 'chrome']);
  if (unmet.length) {
    console.info(`composition.check indisponible ici (${unmet.join(', ')}) : observation vérifiée`);
    expect(step).toMatchObject({ status: 'failed', error: { code: 'unavailable' } });
    return;
  }
  if (!step.result?.ok) throw new Error(JSON.stringify(step.error));
  const check = step.result.output as { engine: string; sections: Record<string, unknown> };
  expect(check.engine).toBe('hyperframes');
  expect(Object.keys(check.sections)).toEqual(expect.arrayContaining(['lint', 'layout']));
  expect(step.result.simulated).toBe(false);
}, 600_000);
