import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  BudgetExceededError,
  usageMicroUsd,
  worstCaseMicroUsd,
  captionRulesSchema,
  captionStyleSchema,
  captionTrackSchema,
  groupCaptions,
  sceneFallbackWords
} from '@veyra/schemas';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from './repo';
import * as schema from './schema';
let client: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let repo: ReturnType<typeof createRepository>;
const board = {
  width: 1920,
  height: 1080,
  fps: 30,
  scenes: [{ id: 'scn_one', start: 0, duration: 1000, text: 'Hello', animation: {} }]
};
const revision = {
  id: 'rev_one',
  projectId: 'prj_one',
  storyboard: board,
  resolvedConfig: {},
  videoPath: null,
  error: null,
  createdAt: 1,
  updatedAt: 1
};
const feedback = {
  id: 'fdb_one',
  projectId: 'prj_one',
  revisionId: 'rev_one',
  timestampMs: 500,
  sceneId: 'scn_one',
  text: 'Bigger',
  author: 'Tester',
  createdAt: 1,
  updatedAt: 1
};
beforeEach(() => {
  client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  db = drizzle(client, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  repo = createRepository(db);
  repo.createProject({
    id: 'prj_one',
    name: 'Test',
    resolvedConfig: {},
    createdAt: 1,
    updatedAt: 1
  });
  repo.createRevision(revision);
});
afterEach(() => client.close());
it('persists JSON, scenes, messages, assets and reports through migrations', () => {
  repo.createAsset({
    id: 'ast_one',
    projectId: 'prj_one',
    path: 'assets/test.svg',
    mediaType: 'image/svg+xml',
    createdAt: 1,
    updatedAt: 1
  });
  repo.createConversation({ id: 'cnv_one', projectId: 'prj_one', createdAt: 1, updatedAt: 1 });
  repo.createMessage({
    id: 'msg_one',
    conversationId: 'cnv_one',
    role: 'user',
    text: 'Test',
    createdAt: 1
  });
  repo.createQualityReport({
    id: 'qar_one',
    revisionId: 'rev_one',
    analysisModes: [],
    checks: [],
    issues: [],
    createdAt: 1
  });
  expect(createRepository(drizzle(client, { schema })).getRevision('rev_one').storyboard).toEqual(
    board
  );
  expect(db.select().from(schema.scenes).all()).toHaveLength(1);
  expect(db.select().from(schema.messages).get()?.text).toBe('Test');
  expect(db.select().from(schema.assets).get()?.path).toBe('assets/test.svg');
  expect(db.select().from(schema.qualityReports).get()?.report.analysisModes).toEqual([]);
});
it('requires an existing revision, matching project and matching scene for feedback', () => {
  expect(() => repo.createFeedback({ ...feedback, revisionId: 'rev_missing' })).toThrow();
  repo.createProject({
    id: 'prj_other',
    name: 'Other',
    resolvedConfig: {},
    createdAt: 1,
    updatedAt: 1
  });
  expect(() => repo.createFeedback({ ...feedback, projectId: 'prj_other' })).toThrow();
  expect(() => repo.createFeedback({ ...feedback, sceneId: 'scn_missing' })).toThrow();
  repo.createFeedback(feedback);
  expect(db.select().from(schema.feedback).get()?.revisionId).toBe('rev_one');
});
it('rejects illegal transitions and initial state bypasses', () => {
  expect(() => repo.transitionRevision('rev_one', 'approved')).toThrow('Illegal');
  expect(() => repo.createRevision({ ...revision, id: 'rev_two', status: 'approved' })).toThrow(
    'start in draft'
  );
  expect(() => repo.updateRevision('rev_one', { status: 'approved' } as never)).toThrow(
    'Unsupported'
  );
  repo.createFeedback(feedback);
  expect(() => repo.transitionFeedback('fdb_one', 'applied')).toThrow('Illegal');
  expect(repo.getRevision('rev_one').status).toBe('draft');
});
it('allows edits before approval and rejects updates after approval or publication', () => {
  repo.updateRevision('rev_one', { videoPath: 'renders/test.mp4' });
  for (const state of ['rendering', 'qa', 'awaiting_approval', 'approved'] as const)
    repo.transitionRevision('rev_one', state);
  expect(() => repo.updateRevision('rev_one', { videoPath: 'changed.mp4' })).toThrow('immutable');
  repo.transitionRevision('rev_one', 'published');
  expect(() => repo.updateRevision('rev_one', { error: 'changed' })).toThrow('immutable');
  expect(() => repo.transitionRevision('rev_one', 'draft')).toThrow('Illegal');
  expect(repo.getRevision('rev_one').videoPath).toBe('renders/test.mp4');
});
it('persists job failure details and rejects terminal transitions', () => {
  repo.createRenderJob({
    id: 'rnd_one',
    revisionId: 'rev_one',
    outputPath: null,
    error: null,
    createdAt: 1,
    updatedAt: 1
  });
  expect(() => repo.transitionRenderJob('rnd_one', 'succeeded')).toThrow('Illegal');
  repo.transitionRenderJob('rnd_one', 'running');
  repo.transitionRenderJob('rnd_one', 'failed', { error: 'Test failure' });
  expect(db.select().from(schema.renderJobs).get()?.error).toBe('Test failure');
  expect(() => repo.transitionRenderJob('rnd_one', 'running')).toThrow('Illegal');
});
it('persists feedback plan and full resolution lifecycle', () => {
  repo.createFeedback(feedback);
  repo.createRevisionPlan({
    id: 'pln_one',
    revisionId: 'rev_one',
    feedbackIds: ['fdb_one'],
    changes: [{ sceneId: 'scn_one', instruction: 'Enlarge title' }],
    createdAt: 1
  });
  for (const state of ['queued', 'submitted', 'applied'] as const)
    repo.transitionFeedback('fdb_one', state);
  expect(db.select().from(schema.feedback).get()?.status).toBe('applied');
  expect(db.select().from(schema.revisionPlans).get()?.plan.feedbackIds).toEqual(['fdb_one']);
});
it('rolls back storyboard edits that would orphan feedback', () => {
  repo.createFeedback(feedback);
  expect(() => repo.updateRevision('rev_one', { storyboard: { ...board, scenes: [] } })).toThrow();
  expect(repo.getRevision('rev_one').storyboard).toEqual(board);
});

it('preserves feedback when editing a retained scene', () => {
  repo.createFeedback(feedback);
  repo.updateRevision('rev_one', {
    storyboard: { ...board, scenes: [{ ...board.scenes[0], text: 'Updated' }] }
  });
  expect(repo.getRevision('rev_one').storyboard.scenes[0].text).toBe('Updated');
  expect(db.select().from(schema.feedback).get()?.sceneId).toBe('scn_one');
});
it('edits and deletes drafts only, and keeps them in SQLite', () => {
  repo.createFeedback({ ...feedback, frameIndex: 360, fpsNum: 30, fpsDen: 1 });
  expect(repo.updateDraftFeedback('fdb_one', { text: 'Edited' }).text).toBe('Edited');
  expect(db.select().from(schema.feedback).get()).toMatchObject({
    text: 'Edited',
    frameIndex: 360,
    fpsNum: 30,
    status: 'draft'
  });
  repo.transitionFeedback('fdb_one', 'queued');
  expect(() => repo.updateDraftFeedback('fdb_one', { text: 'x' })).toThrow('déjà envoyé');
  expect(() => repo.deleteDraftFeedback('fdb_one')).toThrow('déjà envoyé');
  repo.createFeedback({ ...feedback, id: 'fdb_two' });
  repo.deleteDraftFeedback('fdb_two');
  expect(repo.getFeedback('fdb_two')).toBeUndefined();
});
it('enforces batch transitions and unique submission keys', () => {
  repo.createFeedback(feedback);
  const batch = {
    id: 'cbt_one',
    projectId: 'prj_one',
    sourceRevisionId: 'rev_one',
    submissionKey: 'key-00000001',
    provider: 'fake',
    feedbackIds: ['fdb_one'],
    createdAt: 1,
    updatedAt: 1
  };
  repo.createBatch(batch);
  expect(() => repo.createBatch({ ...batch, id: 'cbt_two' })).toThrow();
  expect(repo.batchByKey('key-00000001')?.id).toBe('cbt_one');
  expect(() => repo.updateBatch('cbt_one', { status: 'applied' })).toThrow('Illegal');
  repo.updateBatch('cbt_one', { status: 'submitted' });
  repo.updateBatch('cbt_one', { status: 'failed', error: 'boom' });
  expect(repo.updateBatch('cbt_one', { status: 'queued' }).status).toBe('queued');
});
it('persists captions with the revision and cue targets on feedback, never patching captions', () => {
  const words = sceneFallbackWords([{ ...board.scenes[0], narration: { text: 'Bonjour à tous' } }]);
  const captions = captionTrackSchema.parse({
    schemaVersion: 1,
    id: 'cap_one',
    words,
    cues: groupCaptions(words, captionStyleSchema.parse({}), captionRulesSchema.parse({})),
    provenance: { provider: 'script' }
  });
  expect(repo.getRevision('rev_one').captions).toBeNull();
  repo.createRevision({ ...revision, id: 'rev_cap', captions });
  expect(repo.getRevision('rev_cap').captions).toEqual(captions);
  expect(repo.listRevisions('prj_one').find((r) => r.id === 'rev_cap')?.captions).toEqual(captions);
  expect(() => repo.updateRevision('rev_cap', { captions: null } as never)).toThrow('Unsupported');
  expect(repo.getRevision('rev_cap').captions).toEqual(captions);
  const cueId = captions.cues[0].id;
  repo.createFeedback({ ...feedback, revisionId: 'rev_cap', captionCueId: cueId });
  expect(repo.getFeedback('fdb_one')?.captionCueId).toBe(cueId);
});

it('gates billable calls on the persisted spend envelope (D022)', () => {
  const run = (id: string, budgetMicroUsd?: number) =>
    repo.createRun({
      id,
      projectId: 'prj_one',
      kind: 'production',
      plan: { phases: [], budget: { maxAiCalls: 3, maxRenders: 2 }, reason: 'R' },
      ...(budgetMicroUsd === undefined ? {} : { budgetMicroUsd }),
      createdAt: 1,
      updatedAt: 1
    });
  // Default envelope is zero: nothing billable, not even a one-micro-dollar call.
  run('run_zero');
  expect(() => repo.reserveBudget('run_zero', 1)).toThrow(BudgetExceededError);
  expect(repo.getRun('run_zero')).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 0 });

  run('run_one', 1_000_000);
  // Worst case of a 1000-token prompt with max_tokens 16000 on 4/20 $ per MTok.
  const pricing = { inputUsdPerMTok: 4, outputUsdPerMTok: 20 };
  const worst = worstCaseMicroUsd(pricing, 1000, 16000);
  expect(worst).toBe(325_000);
  repo.reserveBudget('run_one', worst);
  repo.reserveBudget('run_one', worst);
  repo.reserveBudget('run_one', worst);
  // A fourth concurrent reservation would overrun 1 $: refused with the three amounts.
  expect(() => repo.reserveBudget('run_one', worst)).toThrow(
    'Budget insuffisant : 0.9750 $ dépensés (dont 0.9750 $ réservés), 1.0000 $ autorisés, 0.3250 $ nécessaires'
  );
  const cost = usageMicroUsd(pricing, {
    input_tokens: 1000,
    output_tokens: 2000,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 1000
  });
  expect(cost).toBe(4000 + 500 + 400 + 40_000);
  repo.settleBudget('run_one', worst, cost);
  // Aborted call: billing unknown, the reservation stays spent.
  repo.settleBudget('run_one', worst, null);
  expect(repo.getRun('run_one')).toMatchObject({
    spentMicroUsd: cost + worst,
    reservedMicroUsd: worst
  });
  expect(() => repo.settleBudget('run_one', worst * 2, 0)).toThrow('Réservation inconnue');
  repo.settleBudget('run_one', worst, cost);
  repo.reserveBudget('run_one', worst);
  expect(() => repo.reserveBudget('run_one', worst)).toThrow(BudgetExceededError);
  expect(() => repo.raiseBudget('run_one', 999_999)).toThrow("L'enveloppe ne peut qu'augmenter");
  repo.raiseBudget('run_one', 2_000_000);
  repo.reserveBudget('run_one', worst);
  // Unrelated run updates keep the envelope.
  repo.updateRun('run_one', { status: 'waiting', aiCalls: 3 });

  expect(() => repo.reserveBudget('run_one', -1)).toThrow();
  expect(() => repo.reserveBudget('run_one', 0.5)).toThrow();
});

it('keeps the spend envelope across a restart on a database file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-budget-'));
  const open = () => {
    const file = new Database(join(dir, 'veyra.db'));
    const fileDb = drizzle(file, { schema });
    migrate(fileDb, { migrationsFolder: './drizzle' });
    return { file, repo: createRepository(fileDb) };
  };
  try {
    const first = open();
    first.repo.createProject({
      id: 'prj_one',
      name: 'T',
      resolvedConfig: {},
      createdAt: 1,
      updatedAt: 1
    });
    first.repo.createRun({
      id: 'run_one',
      projectId: 'prj_one',
      kind: 'production',
      plan: { phases: [], budget: { maxAiCalls: 3, maxRenders: 2 }, reason: 'R' },
      budgetMicroUsd: 500_000,
      createdAt: 1,
      updatedAt: 1
    });
    first.repo.reserveBudget('run_one', 300_000);
    first.file.close();
    // The in-flight reservation survives the crash and still blocks an overrun.
    const second = open();
    expect(() => second.repo.reserveBudget('run_one', 300_000)).toThrow(BudgetExceededError);
    expect(second.repo.getRun('run_one')).toMatchObject({
      budgetMicroUsd: 500_000,
      reservedMicroUsd: 300_000,
      spentMicroUsd: 0
    });
    second.file.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
