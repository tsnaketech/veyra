import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compositionCheckSchema } from '@veyra/hyperframes-adapter';
import { ProjectStorage } from '@veyra/storage';
import { FakeAiProvider } from '@veyra/ai';
import { createRepository } from './db/repo';
import * as schema from './db/schema';
import {
  compositionChecks,
  defaultConfigDir,
  loadRenderSettings,
  RenderJobRunner
} from './jobs/runner';
import { loadStudioSettings, Studio } from './studio';
import { colorEngine } from './test-engines';

vi.setConfig({ testTimeout: 180_000 });
const saas =
  'Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.';
let client: Database.Database, root: string, repo: ReturnType<typeof createRepository>;
const layoutError = compositionCheckSchema.parse({
  ok: false,
  engine: 'hyperframes',
  sections: {
    layout: {
      ok: false,
      errorCount: 1,
      findings: [{ code: 'text_overflow', severity: 'error', message: 'Text overflows', time: 1.5 }]
    },
    craft: {
      ok: true,
      warningCount: 1,
      findings: [{ code: 'film_silent', severity: 'warning', message: 'No sound' }]
    }
  }
});
function studio(check?: Parameters<typeof colorEngine>[1]): Studio {
  const settings = loadStudioSettings(loadRenderSettings(), defaultConfigDir());
  const storage = new ProjectStorage(root);
  const runner: RenderJobRunner = new RenderJobRunner(
    repo,
    storage,
    colorEngine((id) => repo.getRevision(id).storyboard, check),
    settings,
    (revision, path) => app.review(revision, path)
  );
  const app: Studio = new Studio(repo, runner, new FakeAiProvider(), settings, storage);
  return app;
}
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 900 && !condition(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(condition()).toBe(true);
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'veyra-motion-'));
  client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  repo = createRepository(db);
});
afterEach(() => {
  client.close();
  rmSync(root, { recursive: true, force: true });
});

it('composes with components, corrects one component in natural language and keeps the rest', async () => {
  const app = studio();
  const project = app.createProject('SaaS');
  await app.sendPrompt(project.id, saas);
  const [v1] = repo.listRevisions(project.id);
  expect(v1.status).toBe('awaiting_approval');
  expect(v1.storyboard.scenes.map((s) => s.component?.id)).toEqual([
    'animated-title',
    'feature-cards',
    'product-mockup',
    'metrics-counter',
    'call-to-action'
  ]);
  const names = repo
    .reportsFor([v1.id])
    .at(-1)!
    .checks.map((c) => c.name);
  expect(names).toEqual(
    expect.arrayContaining([
      'Mise en page (marges, débordements)',
      'Lisibilité (contraste WCAG AA)',
      'Performance de rendu'
    ])
  );
  const message = repo
    .listMessages(repo.conversationFor(project.id)!.id)
    .find((m) => m.text.includes('Storyboard'))!.text;
  expect(message).toMatch(/CallToAction — /);
  expect(message).toMatch(/à remplacer par les vôtres/);

  const cta = v1.storyboard.scenes[4];
  const button = await app.addAnnotation({
    revisionId: v1.id,
    frameIndex: Math.round(((cta.start + 1500) * 30) / 1000),
    text: 'Change le bouton en « Démarrer maintenant »',
    author: 'u'
  });
  const title = await app.addAnnotation({
    revisionId: v1.id,
    frameIndex: 30,
    text: 'Remplace le titre par « Gérez tout, simplement »',
    author: 'u'
  });
  const batch = app.submitBatch({
    revisionId: v1.id,
    feedbackIds: [button.id, title.id],
    submissionKey: `key-${crypto.randomUUID()}`
  });
  await until(() => repo.getBatch(batch.id).status === 'planned');
  await app.applyPlan(repo.getBatch(batch.id).planId!);
  const v2 = repo.listRevisions(project.id).at(-1)!;
  expect(v2.status).toBe('awaiting_approval');
  // Untouched components carried over unchanged; the source revision is intact.
  expect(v2.storyboard.scenes.slice(1, 4).map((s) => s.component)).toEqual(
    v1.storyboard.scenes.slice(1, 4).map((s) => s.component)
  );
  expect(v2.storyboard.scenes[4].component!.params).toMatchObject({
    buttonLabel: 'Démarrer maintenant',
    headline: cta.component!.params.headline
  });
  expect(v2.storyboard.scenes[0].component!.params.title).toBe('Gérez tout, simplement');
  expect(repo.getRevision(v1.id).storyboard).toEqual(v1.storyboard);
  expect(repo.getBatch(batch.id).verification?.map((v) => v.verdict)).toEqual([
    'applied',
    'applied'
  ]);
  const report = repo.reportsFor([v2.id]).at(-1)!;
  expect(report.checks.some((c) => c.name === 'Régression possible')).toBe(false);
  const [evaluation] = repo.evaluationsFor([v2.id]);
  expect(evaluation.verdicts.map((v) => v.verdict)).toEqual(['applied', 'applied']);
});

it('reports layout errors from HyperFrames check without a useless automatic re-render', async () => {
  const app = studio(async () => layoutError);
  const project = app.createProject('Overflow');
  await app.sendPrompt(project.id, saas);
  const revisions = repo.listRevisions(project.id);
  expect(revisions).toHaveLength(1);
  expect(revisions[0].status).toBe('awaiting_approval');
  const layout = repo
    .reportsFor([revisions[0].id])
    .at(-1)!
    .checks.find((c) => c.name.startsWith('Mise en page'))!;
  expect(layout).toMatchObject({ passed: false, severity: 'major', timestamp: 1500 });
  expect(layout.evidence).toMatch(/text_overflow@1.5s/);
});

it('maps HyperFrames check sections to QA checks and reports when it could not run', () => {
  const checks = compositionChecks(layoutError, null);
  expect(checks.map((c) => [c.name, c.passed])).toEqual([
    ['Mise en page (marges, débordements)', false],
    ['Lisibilité (contraste WCAG AA)', true],
    ['Exécution de la composition', true],
    ['Animations et transitions (conseils HyperFrames)', true]
  ]);
  expect(checks[3].evidence).toMatch(/"avertissements":1/);
  const missing = compositionChecks(null, 'Chrome introuvable');
  expect(missing[0]).toMatchObject({ passed: false, severity: 'minor' });
  expect(missing[0].evidence).toMatch(/Chrome introuvable/);
});
