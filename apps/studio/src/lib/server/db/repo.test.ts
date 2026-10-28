import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
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
