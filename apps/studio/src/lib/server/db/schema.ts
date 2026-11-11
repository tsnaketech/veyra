import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  unique
} from 'drizzle-orm/sqlite-core';
import type {
  AiTask,
  Asset,
  AudioComposition,
  CaptionTrack,
  ProductionPhase,
  ProductionRun,
  ToolExecutionRecord,
  CorrectionBatch,
  ExpertFinding,
  ExpertVerdict,
  MediaInfo,
  QualityReport,
  RevisionPlan,
  Scene,
  Storyboard
} from '@veyra/schemas';
const timestamps = () => ({
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
});
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  resolvedConfig: text('resolved_config', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull(),
  // Per-project provider (D024); null = the global choice.
  aiProvider: text('ai_provider', {
    enum: ['fake', 'anthropic-api', 'claude-subscribe', 'openai-api', 'codex-chatgpt']
  }),
  ...timestamps()
});
export const videoRevisions = sqliteTable(
  'video_revisions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    parentRevisionId: text('parent_revision_id').references(
      (): AnySQLiteColumn => videoRevisions.id
    ),
    status: text('status', {
      enum: [
        'draft',
        'rendering',
        'qa',
        'awaiting_approval',
        'approved',
        'changes_requested',
        'failed',
        'published'
      ]
    })
      .notNull()
      .default('draft'),
    storyboard: text('storyboard', { mode: 'json' }).$type<Storyboard>().notNull(),
    resolvedConfig: text('resolved_config', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    videoPath: text('video_path'),
    media: text('media', { mode: 'json' }).$type<MediaInfo>(),
    audio: text('audio', { mode: 'json' }).$type<AudioComposition>(),
    captions: text('captions', { mode: 'json' }).$type<CaptionTrack>(),
    silentVideoPath: text('silent_video_path'),
    error: text('error'),
    ...timestamps()
  },
  (t) => [
    index('revisions_project_idx').on(t.projectId),
    unique('revision_project_unique').on(t.id, t.projectId),
    check(
      'revision_status',
      sql`${t.status} in ('draft','rendering','qa','awaiting_approval','approved','changes_requested','published','failed')`
    )
  ]
);
export const scenes = sqliteTable(
  'scenes',
  {
    id: text('id').notNull(),
    revisionId: text('revision_id')
      .notNull()
      .references(() => videoRevisions.id),
    start: integer('start').notNull(),
    duration: integer('duration').notNull(),
    text: text('text').notNull(),
    animation: text('animation', { mode: 'json' }).$type<Scene['animation']>().notNull(),
    ...timestamps()
  },
  (t) => [
    unique('scene_revision_unique').on(t.id, t.revisionId),
    index('scenes_revision_idx').on(t.revisionId),
    check('scene_times', sql`${t.start} >= 0 and ${t.duration} > 0`)
  ]
);
export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    path: text('path').notNull(),
    mediaType: text('media_type').notNull(),
    audio: text('audio', { mode: 'json' }).$type<Asset['audio']>(),
    ...timestamps()
  },
  (t) => [index('assets_project_idx').on(t.projectId)]
);
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    ...timestamps()
  },
  (t) => [index('conversations_project_idx').on(t.projectId)]
);
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    role: text('role', { enum: ['user', 'assistant', 'system', 'tool'] }).notNull(),
    text: text('text').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId),
    check('message_role', sql`${t.role} in ('user','assistant','system','tool')`)
  ]
);
export const renderJobs = sqliteTable(
  'render_jobs',
  {
    id: text('id').primaryKey(),
    revisionId: text('revision_id')
      .notNull()
      .references(() => videoRevisions.id),
    status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] })
      .notNull()
      .default('queued'),
    progress: integer('progress').notNull().default(0),
    stage: text('stage').notNull().default('queued'),
    stderrTail: text('stderr_tail'),
    resolvedConfig: text('resolved_config', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    outputPath: text('output_path'),
    error: text('error'),
    ...timestamps()
  },
  (t) => [
    index('jobs_revision_idx').on(t.revisionId),
    index('jobs_status_idx').on(t.status),
    check('job_progress', sql`${t.progress} between 0 and 100`),
    check('job_status', sql`${t.status} in ('queued','running','succeeded','failed','cancelled')`)
  ]
);
const feedbackStatuses = ['draft', 'queued', 'submitted', 'applied', 'rejected', 'failed'] as const;
export const feedback = sqliteTable(
  'feedback',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    revisionId: text('revision_id').notNull(),
    timestampMs: integer('timestamp_ms').notNull(),
    frameIndex: integer('frame_index'),
    fpsNum: integer('fps_num'),
    fpsDen: integer('fps_den'),
    capturePath: text('capture_path'),
    batchId: text('batch_id').references((): AnySQLiteColumn => correctionBatches.id),
    sceneId: text('scene_id'),
    rangeEndMs: integer('range_end_ms'),
    audioTrackId: text('audio_track_id'),
    captionCueId: text('caption_cue_id'),
    text: text('text').notNull(),
    status: text('status', { enum: feedbackStatuses }).notNull().default('draft'),
    author: text('author').notNull(),
    ...timestamps()
  },
  (t) => [
    foreignKey({
      columns: [t.revisionId, t.projectId],
      foreignColumns: [videoRevisions.id, videoRevisions.projectId]
    }),
    foreignKey({
      columns: [t.sceneId, t.revisionId],
      foreignColumns: [scenes.id, scenes.revisionId]
    }),
    index('feedback_revision_idx').on(t.revisionId),
    index('feedback_project_idx').on(t.projectId),
    index('feedback_batch_idx').on(t.batchId),
    check('feedback_time', sql`${t.timestampMs} >= 0`),
    check('feedback_frame', sql`${t.frameIndex} is null or ${t.frameIndex} >= 0`),
    check(
      'feedback_status',
      sql`${t.status} in ('draft','queued','submitted','applied','rejected','failed')`
    )
  ]
);
export const qualityReports = sqliteTable(
  'quality_reports',
  {
    id: text('id').primaryKey(),
    revisionId: text('revision_id')
      .notNull()
      .references(() => videoRevisions.id),
    report: text('report', { mode: 'json' }).$type<QualityReport>().notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [index('reports_revision_idx').on(t.revisionId)]
);
export const revisionPlans = sqliteTable(
  'revision_plans',
  {
    id: text('id').primaryKey(),
    revisionId: text('revision_id')
      .notNull()
      .references(() => videoRevisions.id),
    plan: text('plan', { mode: 'json' }).$type<RevisionPlan>().notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [index('plans_revision_idx').on(t.revisionId)]
);
export const correctionBatches = sqliteTable(
  'correction_batches',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    sourceRevisionId: text('source_revision_id').notNull(),
    submissionKey: text('submission_key').notNull().unique(),
    status: text('status', {
      enum: ['queued', 'submitted', 'awaiting_import', 'planned', 'applied', 'rejected', 'failed']
    })
      .notNull()
      .default('queued'),
    provider: text('provider').notNull(),
    feedbackIds: text('feedback_ids', { mode: 'json' })
      .$type<CorrectionBatch['feedbackIds']>()
      .notNull(),
    planId: text('plan_id').references(() => revisionPlans.id),
    resultRevisionId: text('result_revision_id').references(() => videoRevisions.id),
    verification: text('verification', { mode: 'json' }).$type<CorrectionBatch['verification']>(),
    error: text('error'),
    ...timestamps()
  },
  (t) => [
    foreignKey({
      columns: [t.sourceRevisionId, t.projectId],
      foreignColumns: [videoRevisions.id, videoRevisions.projectId]
    }),
    index('batches_revision_idx').on(t.sourceRevisionId),
    check(
      'batch_status',
      sql`${t.status} in ('queued','submitted','awaiting_import','planned','applied','rejected','failed')`
    )
  ]
);
// Requests waiting for a result produced outside Veyra (claude-subscribe assisted mode).
export const aiTasks = sqliteTable(
  'ai_tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    kind: text('kind', { enum: ['storyboard', 'plan', 'evaluation'] }).notNull(),
    provider: text('provider').notNull(),
    status: text('status', { enum: ['awaiting_import', 'imported', 'failed'] })
      .notNull()
      .default('awaiting_import'),
    batchId: text('batch_id').references(() => correctionBatches.id),
    input: text('input', { mode: 'json' }).$type<AiTask['input']>().notNull(),
    dir: text('dir').notNull(),
    error: text('error'),
    ...timestamps()
  },
  (t) => [
    index('tasks_project_idx').on(t.projectId),
    check('task_kind', sql`${t.kind} in ('storyboard','plan','evaluation')`),
    check('task_status', sql`${t.status} in ('awaiting_import','imported','failed')`)
  ]
);
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull()
});
// Expert QA of a corrected revision; never changes the revisions it compares.
export const qualityEvaluations = sqliteTable(
  'quality_evaluations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    revisionId: text('revision_id')
      .notNull()
      .references(() => videoRevisions.id),
    baseRevisionId: text('base_revision_id')
      .notNull()
      .references(() => videoRevisions.id),
    batchId: text('batch_id').references(() => correctionBatches.id),
    evaluator: text('evaluator', {
      enum: ['fake', 'anthropic-api', 'claude-subscribe', 'openai-api', 'codex-chatgpt']
    }),
    analysisMode: text('analysis_mode', {
      enum: ['deterministic', 'multimodal', 'text-only', 'simulated']
    }),
    status: text('status', {
      enum: ['pending', 'awaiting_import', 'completed', 'failed', 'unavailable']
    })
      .notNull()
      .default('pending'),
    verdicts: text('verdicts', { mode: 'json' }).$type<ExpertVerdict[]>().notNull(),
    findings: text('findings', { mode: 'json' }).$type<ExpertFinding[]>().notNull(),
    imagesExamined: text('images_examined', { mode: 'json' }).$type<string[]>().notNull(),
    error: text('error'),
    ...timestamps()
  },
  (t) => [
    index('evaluations_revision_idx').on(t.revisionId),
    check(
      'evaluation_status',
      sql`${t.status} in ('pending','awaiting_import','completed','failed','unavailable')`
    )
  ]
);
// Orchestrated productions and revisions (Director plan, phases, agent results).
export const productionRuns = sqliteTable(
  'production_runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    kind: text('kind', { enum: ['production', 'revision'] }).notNull(),
    status: text('status', {
      enum: ['running', 'waiting', 'completed', 'failed', 'stopped']
    })
      .notNull()
      .default('running'),
    brief: text('brief', { mode: 'json' }).$type<ProductionRun['brief']>(),
    plan: text('plan', { mode: 'json' }).$type<ProductionRun['plan']>().notNull(),
    sourceRevisionId: text('source_revision_id').references(() => videoRevisions.id),
    revisionId: text('revision_id').references(() => videoRevisions.id),
    aiCalls: integer('ai_calls').notNull().default(0),
    // D022 spend envelope in micro-dollars; written only by the repository budget methods.
    budgetMicroUsd: integer('budget_micro_usd').notNull().default(0),
    spentMicroUsd: integer('spent_micro_usd').notNull().default(0),
    reservedMicroUsd: integer('reserved_micro_usd').notNull().default(0),
    error: text('error'),
    ...timestamps()
  },
  (t) => [
    index('runs_project_idx').on(t.projectId),
    check('run_status', sql`${t.status} in ('running','waiting','completed','failed','stopped')`)
  ]
);
export const productionPhases = sqliteTable(
  'production_phases',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => productionRuns.id),
    phase: text('phase').notNull(),
    agent: text('agent').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'done', 'failed', 'waiting', 'skipped']
    })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    inputHash: text('input_hash'),
    result: text('result', { mode: 'json' }).$type<ProductionPhase['result']>(),
    error: text('error'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    ...timestamps()
  },
  (t) => [
    index('phases_run_idx').on(t.runId),
    unique('phase_run_unique').on(t.runId, t.phase),
    check(
      'phase_status',
      sql`${t.status} in ('pending','running','done','failed','waiting','skipped')`
    )
  ]
);
// T129a: one row per step of a tool loop running inside a phase (DIRECTOR-TOOL-LOOP § 5).
export const loopSteps = sqliteTable(
  'loop_steps',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => productionRuns.id),
    phaseId: text('phase_id')
      .notNull()
      .references(() => productionPhases.id),
    step: integer('step').notNull(),
    origin: text('origin').notNull(),
    action: text('action').notNull(),
    request: text('request', { mode: 'json' }).$type<ToolExecutionRecord['request']>().notNull(),
    invocation: text('invocation', { mode: 'json' }).$type<ToolExecutionRecord['invocation']>(),
    status: text('status').notNull(),
    result: text('result', { mode: 'json' }).$type<ToolExecutionRecord['result']>(),
    error: text('error', { mode: 'json' }).$type<ToolExecutionRecord['error']>(),
    costMicroUsd: integer('cost_micro_usd').notNull().default(0),
    durationMs: integer('duration_ms'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    ...timestamps()
  },
  (t) => [
    unique('loop_step_unique').on(t.phaseId, t.step),
    index('loop_steps_run_idx').on(t.runId),
    check(
      'loop_step_status',
      sql`${t.status} in ('awaiting-permission','authorized','denied','running','done','failed','interrupted','cancelled')`
    )
  ]
);
