import { afterAll, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAiProvider } from '@veyra/ai';
import { HyperFramesEngine } from '@veyra/hyperframes-adapter';
import { ProjectStorage } from '@veyra/storage';
import { createRepository } from '../db/repo';
import * as schema from '../db/schema';
import { defaultConfigDir, loadRenderSettings, RenderJobRunner } from '../jobs/runner';
import { loadStudioSettings, Studio } from '../studio';
import { colorEngine } from '../test-engines';
import { studioToolRegistry } from './index';

// (h) The runner writes the real composition (compose + writeComposition); colorEngine only
// encodes the MP4 fast. The tool then runs the real `hyperframes check` (bwrap, Chrome headless).
const root = mkdtempSync(join(tmpdir(), 'veyra-tools-slow-'));
const client = new Database(':memory:');
client.pragma('foreign_keys = ON');
const db = drizzle(client, { schema });
migrate(db, { migrationsFolder: './drizzle' });
const repo = createRepository(db);
afterAll(() => {
  client.close();
  rmSync(root, { recursive: true, force: true });
});

it('composition.check runs the real HyperFrames check in the sandbox on a revision composition', async () => {
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
  const project = app.createProject('Check');
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
  const result = await registry.invoke(
    'composition.check',
    { revisionId: revision.id },
    { grants: ['local-compute'] }
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  const check = result.output as { engine: string; ok: boolean; sections: Record<string, unknown> };
  expect(check.engine).toBe('hyperframes');
  expect(Object.keys(check.sections)).toEqual(expect.arrayContaining(['lint', 'layout']));
  expect(typeof check.ok).toBe('boolean');
  expect(result.simulated).toBe(false);
}, 600_000);

// Real demo defect: a draft child of revision.apply has no composition on disk. The tool
// composes it in its own call folder, checks it, removes the folder and never writes into
// the revision folder (immutability).
it('composition.check on an unrendered draft child composes it outside the revision folder', async () => {
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
  const project = app.createProject('Check draft');
  await app.sendPrompt(
    project.id,
    'Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.'
  );
  const [parent] = repo.listRevisions(project.id);
  const registry = studioToolRegistry({
    repo,
    storage,
    settings,
    engine: new HyperFramesEngine(settings.engine),
    studio: app,
    projectId: project.id
  });
  const applied = await registry.invoke(
    'revision.apply',
    {
      revisionId: parent.id,
      operations: [
        { op: 'scene.transition', sceneId: parent.storyboard.scenes[1].id, enter: 'slide-up' }
      ]
    },
    { grants: ['writes-revision-artefacts'] }
  );
  if (!applied.ok) throw new Error(`${applied.error.code}: ${applied.error.message}`);
  const childId = (applied.output as { revisionId: string }).revisionId;
  expect(repo.getRevision(childId).status).toBe('draft');
  const childDir = storage.revision(project.id, childId);
  const before = existsSync(childDir) ? readdirSync(childDir, { recursive: true }) : null;

  const result = await registry.invoke(
    'composition.check',
    { revisionId: childId },
    { grants: ['local-compute'] }
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  const check = result.output as { engine: string; sections: Record<string, unknown> };
  expect(check.engine).toBe('hyperframes');
  expect(Object.keys(check.sections)).toEqual(expect.arrayContaining(['lint', 'layout']));
  expect(existsSync(childDir) ? readdirSync(childDir, { recursive: true }) : null).toEqual(before);
  const calls = join(root, project.id, 'tool-calls');
  expect(existsSync(calls) ? readdirSync(calls) : []).toEqual([]);
}, 600_000);
