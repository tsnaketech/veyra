import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStorage } from '@veyra/storage';
import {
  AssistedProvider,
  FakeAiProvider,
  revisionProposalSchema,
  ProviderUnavailableError,
  type AiProvider,
  type RevisionProposalInput
} from '@veyra/ai';
import type { Storyboard } from '@veyra/schemas';
import { createRepository } from './db/repo';
import { colorEngine as sharedColorEngine } from './test-engines';
import * as schema from './db/schema';
import { defaultConfigDir, loadRenderSettings, RenderJobRunner } from './jobs/runner';
import { loadStudioSettings, Studio } from './studio';

vi.setConfig({ testTimeout: 180_000 });
// Five 5 s scenes: subject, three offers, call to action.
const prompt =
  "Crée une vidéo de 25 secondes présentant la création, l'hébergement et la maintenance.";
let client: Database.Database, root: string, repo: ReturnType<typeof createRepository>;

const colorEngine = () => sharedColorEngine((id) => repo.getRevision(id).storyboard);
/** Provider whose planner follows a script, so each QA case is produced on purpose. */
function scripted(
  plan: (board: Storyboard, ids: string[]) => RevisionProposalInput,
  evaluator: AiProvider['qualityEvaluator'] = () => new FakeAiProvider().qualityEvaluator()
): AiProvider {
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
    qualityEvaluator: evaluator
  };
}
function studio(ai: ConstructorParameters<typeof Studio>[2]): Studio {
  const settings = loadStudioSettings(loadRenderSettings(), defaultConfigDir());
  const storage = new ProjectStorage(root);
  const runner: RenderJobRunner = new RenderJobRunner(
    repo,
    storage,
    colorEngine(),
    settings,
    (revision, path) => app.review(revision, path)
  );
  const app: Studio = new Studio(repo, runner, ai, settings, storage);
  return app;
}
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 900 && !condition(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(condition()).toBe(true);
};
/** Renders v1, annotates, sends one batch and applies the (scripted) plan. */
async function correct(app: Studio, comments: [number, string][]) {
  const project = app.createProject('QA');
  await app.sendPrompt(project.id, prompt);
  const [v1] = repo.listRevisions(project.id);
  const ids: string[] = [];
  for (const [frameIndex, text] of comments)
    ids.push((await app.addAnnotation({ revisionId: v1.id, frameIndex, text, author: 'u' })).id);
  const batch = app.submitBatch({
    revisionId: v1.id,
    feedbackIds: ids,
    submissionKey: `key-${crypto.randomUUID()}`
  });
  await until(() => repo.getBatch(batch.id).status === 'planned');
  const before = structuredClone(repo.getRevision(v1.id));
  await app.applyPlan(repo.getBatch(batch.id).planId!);
  const v2 = repo.listRevisions(project.id).at(-1)!;
  return { project, v1, before, v2, ids, batch: repo.getBatch(batch.id) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'veyra-eval-'));
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

it('separates applied, contrary, partial, unverifiable and regression, with aligned evidence', async () => {
  const app = studio(
    scripted((board, [applied, contrary, partial, unverifiable]) => {
      const [s1, s2, s3, s4, s5] = board.scenes;
      return {
        summary: 'scripted',
        changes: [
          // Longer first scene: every later scene moves by +1 s in the new render.
          {
            feedbackId: applied,
            sceneId: s1.id,
            instruction: 'slow',
            patch: { animationMs: 800, durationMs: 6000 }
          },
          {
            feedbackId: contrary,
            sceneId: s2.id,
            instruction: 'faster (wrong)',
            patch: { animationMs: 300 }
          },
          {
            feedbackId: partial,
            sceneId: s3.id,
            instruction: 'slow only',
            patch: { animationMs: 800 }
          },
          { feedbackId: unverifiable, sceneId: s4.id, instruction: 'n/a', patch: {} },
          // Nobody asked for this one.
          {
            feedbackId: null,
            sceneId: s5.id,
            instruction: 'extra',
            patch: { text: 'Appelez-nous' }
          }
        ],
        conflicts: []
      };
    })
  );
  const { v1, before, v2, ids, batch } = await correct(app, [
    [60, "Ralentis l'animation"],
    [210, "Ralentis l'animation"],
    [360, 'Ralentis et remplace le texte par « Hébergement sécurisé »'],
    [510, 'Baisse la musique']
  ]);

  const [evaluation] = repo.evaluationsFor([v2.id]);
  expect(evaluation).toMatchObject({
    status: 'completed',
    evaluator: 'fake',
    analysisMode: 'simulated',
    imagesExamined: [],
    baseRevisionId: v1.id,
    batchId: batch.id
  });
  expect(evaluation.verdicts.map((v) => v.verdict)).toEqual([
    'applied',
    'contradicts_request',
    'partially_applied',
    'unverifiable'
  ]);
  expect(evaluation.verdicts.every((v) => v.justification.startsWith('Simulé'))).toBe(true);
  const scene5 = v2.storyboard.scenes[4];
  expect(evaluation.findings).toEqual([
    expect.objectContaining({ kind: 'regression', sceneId: scene5.id })
  ]);
  // Measurements alone cannot see the contrary case: PSNR says "changed".
  const measured = repo.getBatch(batch.id).verification!;
  expect(measured[1]).toMatchObject({ feedbackId: ids[1], verdict: 'applied' });
  expect(measured[3]).toMatchObject({ feedbackId: ids[3], verdict: 'not_applied' });
  const report = repo.reportsFor([v2.id]).at(-1)!;
  expect(report.checks.some((c) => c.name === 'Régression possible')).toBe(true);

  // Evidence pack: exact capture, aligned frame (+1 s shift), sequences for timing.
  const pack = JSON.parse(
    readFileSync(
      join(root, v2.projectId, 'revisions', v2.id, 'qa-expert', evaluation.id, 'input.json'),
      'utf8'
    )
  );
  const second = pack.comments.find((c: { feedbackId: string }) => c.feedbackId === ids[1]);
  expect(second).toMatchObject({ timestampMs: 7000, alignedTimestampMs: 8000 });
  const files = pack.images.map((i: { file: string }) => i.file);
  expect(files).toContain(`${ids[1]}-before-capture.png`);
  expect(files).toContain(`${ids[1]}-after-aligned.png`);
  expect(files.filter((f: string) => f.startsWith(`${ids[1]}-after-seq-`))).toHaveLength(5);
  expect(files).toContain(`${scene5.id}-after-scene.png`);
  const aligned = pack.images.find(
    (i: { file: string }) => i.file === `${ids[1]}-after-aligned.png`
  );
  expect(aligned).toMatchObject({ timestampMs: 8000, frameIndex: 240, offsetMs: 2000 });
  for (const image of pack.images) expect(existsSync(image.path)).toBe(true);
  expect(brief(pack)).toMatchObject({ prompt });

  // Nothing about the old revision changed, and approval is still a human step.
  expect(repo.getRevision(v1.id)).toMatchObject({
    status: 'changes_requested',
    storyboard: before.storyboard,
    videoPath: before.videoPath
  });
  expect(repo.getRevision(v2.id).status).toBe('awaiting_approval');
});
const brief = (pack: { brief: unknown }) => pack.brief;

it('records an unavailable provider without hiding the measurements', async () => {
  const app = studio(
    scripted(
      (board, [id]) => ({
        summary: 's',
        changes: [
          {
            feedbackId: id,
            sceneId: board.scenes[0].id,
            instruction: 'x',
            patch: { animationMs: 800 }
          }
        ],
        conflicts: []
      }),
      () => ({
        kind: 'anthropic-api',
        evaluate: async () => {
          throw new ProviderUnavailableError('quota API atteint');
        }
      })
    )
  );
  const { v2, batch } = await correct(app, [[60, "Ralentis l'animation"]]);
  const [evaluation] = repo.evaluationsFor([v2.id]);
  expect(evaluation).toMatchObject({
    status: 'unavailable',
    error: 'quota API atteint',
    verdicts: []
  });
  expect(repo.getBatch(batch.id).verification?.[0].verdict).toBe('applied');
  expect(repo.getRevision(v2.id).status).toBe('awaiting_approval');
  const last = repo.listMessages(repo.conversationFor(v2.projectId)!.id).at(-1)!.text;
  expect(last).toMatch(/indisponible.*validation reste la vôtre/);

  // Without any provider the expertise is unavailable too, never simulated in disguise.
  app.setProvider(null);
  const again = await app.requestEvaluation(v2.id);
  expect(again).toMatchObject({ status: 'unavailable', evaluator: null, analysisMode: null });
});

it('claude-subscribe exports the evidence and only trusts images that were in the pack', async () => {
  const planner = scripted((board, [id]) => ({
    summary: 's',
    changes: [
      { feedbackId: id, sceneId: board.scenes[0].id, instruction: 'x', patch: { animationMs: 800 } }
    ],
    conflicts: []
  }));
  const app = studio(planner);
  const { v2, ids } = await correct(app, [[60, "Ralentis l'animation"]]);
  app.setProvider(new AssistedProvider());
  const evaluation = await app.requestEvaluation(v2.id);
  expect(evaluation).toMatchObject({ status: 'awaiting_import', evaluator: 'claude-subscribe' });
  const task = repo.listTasks(v2.projectId).find((t) => t.kind === 'evaluation')!;
  const request = JSON.parse(readFileSync(join(task.dir, 'request.json'), 'utf8'));
  expect(request.kind).toBe('evaluation');
  expect(JSON.stringify(request)).not.toContain(root);
  for (const image of request.input.images)
    expect(existsSync(join(task.dir, image.path))).toBe(true);

  writeFileSync(join(task.dir, 'result.json'), '{"verdicts":[]}');
  expect(() => app.importTask(task.id)).toThrow(/non conforme/);
  expect(repo.getEvaluation(evaluation.id).status).toBe('awaiting_import');

  const seen = `${ids[0]}-after-seq-2.png`;
  writeFileSync(
    join(task.dir, 'result.json'),
    JSON.stringify({
      verdicts: [
        {
          feedbackId: ids[0],
          verdict: 'applied',
          category: 'content',
          confidence: 0.8,
          justification: "L'entrée est plus lente sur la séquence.",
          evidence: [{ image: seen, observation: 'opacité encore partielle à 600 ms' }]
        }
      ],
      findings: [
        {
          kind: 'observation',
          category: 'aesthetic',
          sceneId: null,
          severity: 'info',
          confidence: 0.4,
          justification: 'Rythme un peu lent pour un premier plan.',
          evidence: []
        }
      ],
      imagesExamined: [seen, 'not-in-pack.png']
    })
  );
  const done = app.importTask(task.id) as ReturnType<typeof repo.getEvaluation>;
  expect(done).toMatchObject({
    status: 'completed',
    analysisMode: 'multimodal',
    imagesExamined: [seen]
  });
  expect(done.findings[0]).toMatchObject({ category: 'aesthetic', kind: 'observation' });

  // A result that claims no image is text-only, not multimodal.
  const second = await app.requestEvaluation(v2.id);
  const task2 = repo
    .listTasks(v2.projectId)
    .filter((t) => t.kind === 'evaluation')
    .at(-1)!;
  writeFileSync(
    join(task2.dir, 'result.json'),
    JSON.stringify({ verdicts: [], findings: [], imagesExamined: [] })
  );
  const textOnly = app.importTask(task2.id) as ReturnType<typeof repo.getEvaluation>;
  expect(textOnly).toMatchObject({ id: second.id, analysisMode: 'text-only' });
  expect(textOnly.verdicts[0]).toMatchObject({ verdict: 'unverifiable', confidence: 0 });
});
