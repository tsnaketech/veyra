import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  assertTransition,
  projectSchema,
  videoRevisionSchema,
  feedbackSchema,
  renderJobSchema,
  assetSchema,
  conversationSchema,
  messageSchema,
  qualityReportSchema,
  revisionPlanSchema,
  correctionBatchSchema,
  aiTaskSchema,
  qualityEvaluationSchema,
  type QualityEvaluation,
  type AiTask,
  type CorrectionBatch,
  type VideoRevision,
  type RenderJob,
  type Feedback
} from '@veyra/schemas';
import * as tables from './schema';

export function createRepository(db: BetterSQLite3Database<typeof tables>) {
  const revision = (id: string) => {
    const row = db
      .select()
      .from(tables.videoRevisions)
      .where(eq(tables.videoRevisions.id, id))
      .get();
    if (!row) throw new Error(`Revision not found: ${id}`);
    return row;
  };
  const mutable = (id: string) => {
    const row = revision(id);
    if (row.status === 'approved' || row.status === 'published')
      throw new Error('Revision is immutable');
    return row;
  };
  const syncScenes = (row: VideoRevision) => {
    const retained = new Set(row.storyboard.scenes.map((scene) => scene.id));
    const existing = db
      .select()
      .from(tables.scenes)
      .where(eq(tables.scenes.revisionId, row.id))
      .all();
    for (const scene of existing)
      if (!retained.has(scene.id)) {
        db.delete(tables.scenes)
          .where(and(eq(tables.scenes.revisionId, row.id), eq(tables.scenes.id, scene.id)))
          .run();
      }
    // The scenes table indexes timing and text; components live in the storyboard JSON.
    for (const { id, start, duration, text, animation } of row.storyboard.scenes) {
      const scene = { id, start, duration, text, animation };
      db.insert(tables.scenes)
        .values({
          ...scene,
          revisionId: row.id,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt
        })
        .onConflictDoUpdate({
          target: [tables.scenes.id, tables.scenes.revisionId],
          set: { ...scene, updatedAt: row.updatedAt }
        })
        .run();
    }
  };
  const draft = (id: string) => {
    const row = db.select().from(tables.feedback).where(eq(tables.feedback.id, id)).get();
    if (!row) throw new Error('Commentaire introuvable');
    if (row.status !== 'draft')
      throw new Error('Commentaire déjà envoyé : modification impossible');
    return row;
  };
  const batch = (id: string) => {
    const row = db
      .select()
      .from(tables.correctionBatches)
      .where(eq(tables.correctionBatches.id, id))
      .get();
    if (!row) throw new Error('Lot de corrections introuvable');
    return row;
  };
  const task = (id: string) => {
    const row = db.select().from(tables.aiTasks).where(eq(tables.aiTasks.id, id)).get();
    if (!row) throw new Error('Tâche IA introuvable');
    return row;
  };
  return {
    transaction<T>(work: () => T): T {
      return db.transaction(work);
    },
    createProject(input: unknown) {
      const row = projectSchema.parse(input);
      db.insert(tables.projects).values(row).run();
      return row;
    },
    createRevision(input: unknown) {
      const row = videoRevisionSchema.parse(input);
      if (row.status !== 'draft') throw new Error('Revision must start in draft');
      db.transaction(() => {
        db.insert(tables.videoRevisions).values(row).run();
        syncScenes(row);
      });
      return row;
    },
    getRevision: revision,
    updateRevision(
      id: string,
      patch: Pick<
        Partial<VideoRevision>,
        'storyboard' | 'resolvedConfig' | 'videoPath' | 'media' | 'error'
      >
    ) {
      return db.transaction(() => {
        const current = mutable(id);
        const allowed = ['storyboard', 'resolvedConfig', 'videoPath', 'media', 'error'];
        if (Object.keys(patch).some((key) => !allowed.includes(key)))
          throw new Error('Unsupported revision update');
        const row = videoRevisionSchema.parse({ ...current, ...patch, updatedAt: Date.now() });
        db.update(tables.videoRevisions).set(row).where(eq(tables.videoRevisions.id, id)).run();
        if (patch.storyboard) syncScenes(row);
        return row;
      });
    },
    transitionRevision(id: string, to: VideoRevision['status']) {
      db.transaction(() => {
        const row = revision(id);
        assertTransition('VideoRevision', row.status, to);
        db.update(tables.videoRevisions)
          .set({ status: to, updatedAt: Date.now() })
          .where(eq(tables.videoRevisions.id, id))
          .run();
      });
    },
    createRenderJob(input: unknown) {
      const row = renderJobSchema.parse(input);
      if (row.status !== 'queued') throw new Error('Render job must start queued');
      mutable(row.revisionId);
      db.insert(tables.renderJobs).values(row).run();
      return row;
    },
    getRenderJob(id: string) {
      const row = db.select().from(tables.renderJobs).where(eq(tables.renderJobs.id, id)).get();
      if (!row) throw new Error(`Render job not found: ${id}`);
      return row;
    },
    queuedRenderJobs() {
      return db
        .select()
        .from(tables.renderJobs)
        .where(eq(tables.renderJobs.status, 'queued'))
        .all();
    },
    updateRenderProgress(id: string, progress: number, stage: string) {
      db.transaction(() => {
        const row = db.select().from(tables.renderJobs).where(eq(tables.renderJobs.id, id)).get();
        if (!row || row.status !== 'running') throw new Error('Only running jobs accept progress');
        if (progress < row.progress) throw new Error('Progress cannot decrease');
        const next = renderJobSchema.parse({ ...row, progress, stage, updatedAt: Date.now() });
        db.update(tables.renderJobs).set(next).where(eq(tables.renderJobs.id, id)).run();
      });
    },
    transitionRenderJob(
      id: string,
      to: RenderJob['status'],
      result: {
        outputPath?: string;
        error?: string;
        stderrTail?: string;
        resolvedConfig?: RenderJob['resolvedConfig'];
      } = {}
    ) {
      db.transaction(() => {
        const row = db.select().from(tables.renderJobs).where(eq(tables.renderJobs.id, id)).get();
        if (!row) throw new Error(`Render job not found: ${id}`);
        assertTransition('RenderJob', row.status, to);
        const next = renderJobSchema.parse({
          ...row,
          outputPath: result.outputPath ?? row.outputPath,
          error: result.error ?? row.error,
          stderrTail: result.stderrTail ?? row.stderrTail,
          resolvedConfig: result.resolvedConfig ?? row.resolvedConfig,
          stage: to === 'failed' ? row.stage : to === 'succeeded' ? 'complete' : to,
          progress: to === 'succeeded' ? 100 : row.progress,
          status: to,
          updatedAt: Date.now()
        });
        db.update(tables.renderJobs).set(next).where(eq(tables.renderJobs.id, id)).run();
      });
    },
    createFeedback(input: unknown) {
      const row = feedbackSchema.parse(input);
      if (row.status !== 'draft') throw new Error('Feedback must start as draft');
      db.insert(tables.feedback).values(row).run();
      return row;
    },
    /** Only drafts can be edited or deleted: anything sent belongs to a batch. */
    updateDraftFeedback(id: string, patch: { text?: string; capturePath?: string | null }) {
      const row = draft(id);
      const next = feedbackSchema.parse({ ...row, ...patch, updatedAt: Date.now() });
      db.update(tables.feedback).set(next).where(eq(tables.feedback.id, id)).run();
      return next;
    },
    deleteDraftFeedback(id: string) {
      const row = draft(id);
      db.delete(tables.feedback).where(eq(tables.feedback.id, id)).run();
      return row;
    },
    transitionFeedback(id: string, to: Feedback['status']) {
      db.transaction(() => {
        const row = db.select().from(tables.feedback).where(eq(tables.feedback.id, id)).get();
        if (!row) throw new Error(`Feedback not found: ${id}`);
        assertTransition('Feedback', row.status, to);
        db.update(tables.feedback)
          .set({ status: to, updatedAt: Date.now() })
          .where(eq(tables.feedback.id, id))
          .run();
      });
    },
    createAsset(input: unknown) {
      const row = assetSchema.parse(input);
      db.insert(tables.assets).values(row).run();
      return row;
    },
    createConversation(input: unknown) {
      const row = conversationSchema.parse(input);
      db.insert(tables.conversations).values(row).run();
      return row;
    },
    createMessage(input: unknown) {
      const row = messageSchema.parse(input);
      db.insert(tables.messages).values(row).run();
      return row;
    },
    createQualityReport(input: unknown) {
      const row = qualityReportSchema.parse(input);
      mutable(row.revisionId);
      db.insert(tables.qualityReports)
        .values({ id: row.id, revisionId: row.revisionId, report: row, createdAt: row.createdAt })
        .run();
      return row;
    },
    // Read models for the Studio UI.
    listProjects() {
      return db.select().from(tables.projects).orderBy(desc(tables.projects.updatedAt)).all();
    },
    getProject(id: string) {
      return db.select().from(tables.projects).where(eq(tables.projects.id, id)).get();
    },
    touchProject(id: string) {
      db.update(tables.projects)
        .set({ updatedAt: Date.now() })
        .where(eq(tables.projects.id, id))
        .run();
    },
    listRevisions(projectId: string) {
      return db
        .select()
        .from(tables.videoRevisions)
        .where(eq(tables.videoRevisions.projectId, projectId))
        .orderBy(asc(tables.videoRevisions.createdAt))
        .all();
    },
    conversationFor(projectId: string) {
      return db
        .select()
        .from(tables.conversations)
        .where(eq(tables.conversations.projectId, projectId))
        .get();
    },
    listMessages(conversationId: string) {
      return db
        .select()
        .from(tables.messages)
        .where(eq(tables.messages.conversationId, conversationId))
        .orderBy(asc(tables.messages.createdAt))
        .all();
    },
    listFeedback(projectId: string) {
      return db
        .select()
        .from(tables.feedback)
        .where(eq(tables.feedback.projectId, projectId))
        .orderBy(asc(tables.feedback.timestampMs))
        .all();
    },
    getFeedback(id: string) {
      return db.select().from(tables.feedback).where(eq(tables.feedback.id, id)).get();
    },
    listAssets(projectId: string) {
      return db.select().from(tables.assets).where(eq(tables.assets.projectId, projectId)).all();
    },
    renderJobsFor(revisionIds: string[]) {
      if (!revisionIds.length) return [];
      return db
        .select()
        .from(tables.renderJobs)
        .where(inArray(tables.renderJobs.revisionId, revisionIds))
        .orderBy(asc(tables.renderJobs.createdAt))
        .all();
    },
    reportsFor(revisionIds: string[]) {
      if (!revisionIds.length) return [];
      return db
        .select()
        .from(tables.qualityReports)
        .where(inArray(tables.qualityReports.revisionId, revisionIds))
        .orderBy(asc(tables.qualityReports.createdAt))
        .all()
        .map((row) => row.report);
    },
    plansFor(revisionIds: string[]) {
      if (!revisionIds.length) return [];
      return db
        .select()
        .from(tables.revisionPlans)
        .where(inArray(tables.revisionPlans.revisionId, revisionIds))
        .orderBy(asc(tables.revisionPlans.createdAt))
        .all()
        .map((row) => row.plan);
    },
    getPlan(id: string) {
      return db.select().from(tables.revisionPlans).where(eq(tables.revisionPlans.id, id)).get()
        ?.plan;
    },
    recentJobs(limit: number) {
      return db
        .select({ job: tables.renderJobs, projectId: tables.videoRevisions.projectId })
        .from(tables.renderJobs)
        .innerJoin(
          tables.videoRevisions,
          eq(tables.renderJobs.revisionId, tables.videoRevisions.id)
        )
        .orderBy(desc(tables.renderJobs.updatedAt))
        .limit(limit)
        .all();
    },
    createRevisionPlan(input: unknown) {
      const row = revisionPlanSchema.parse(input);
      const target = mutable(row.revisionId);
      for (const change of row.changes)
        if (
          change.sceneId &&
          !target.storyboard.scenes.some((scene) => scene.id === change.sceneId)
        )
          throw new Error('Plan scene must belong to revision');
      for (const id of row.feedbackIds) {
        const item = db.select().from(tables.feedback).where(eq(tables.feedback.id, id)).get();
        if (!item || item.revisionId !== row.revisionId)
          throw new Error('Feedback must belong to planned revision');
      }
      for (const change of row.changes)
        if (change.feedbackId && !row.feedbackIds.includes(change.feedbackId))
          throw new Error('Plan change must reference planned feedback');
      db.insert(tables.revisionPlans)
        .values({ id: row.id, revisionId: row.revisionId, plan: row, createdAt: row.createdAt })
        .run();
      return row;
    },
    // Correction batches: one logical AI request per group of comments.
    createBatch(input: unknown) {
      const row = correctionBatchSchema.parse(input);
      if (row.status !== 'queued') throw new Error('Batch must start queued');
      db.insert(tables.correctionBatches).values(row).run();
      return row;
    },
    getBatch: batch,
    batchByKey(submissionKey: string) {
      return db
        .select()
        .from(tables.correctionBatches)
        .where(eq(tables.correctionBatches.submissionKey, submissionKey))
        .get();
    },
    listBatches(projectId: string) {
      return db
        .select()
        .from(tables.correctionBatches)
        .where(eq(tables.correctionBatches.projectId, projectId))
        .orderBy(asc(tables.correctionBatches.createdAt))
        .all();
    },
    updateBatch(
      id: string,
      patch: Partial<
        Pick<CorrectionBatch, 'status' | 'planId' | 'resultRevisionId' | 'verification' | 'error'>
      >
    ) {
      return db.transaction(() => {
        const row = batch(id);
        if (patch.status && patch.status !== row.status)
          assertTransition('CorrectionBatch', row.status, patch.status);
        const next = correctionBatchSchema.parse({ ...row, ...patch, updatedAt: Date.now() });
        db.update(tables.correctionBatches)
          .set(next)
          .where(eq(tables.correctionBatches.id, id))
          .run();
        return next;
      });
    },
    attachFeedbackToBatch(ids: string[], batchId: string) {
      db.update(tables.feedback)
        .set({ batchId, updatedAt: Date.now() })
        .where(inArray(tables.feedback.id, ids))
        .run();
    },
    // Assisted-mode tasks (result produced outside Veyra, then imported).
    createTask(input: unknown) {
      const row = aiTaskSchema.parse(input);
      db.insert(tables.aiTasks).values(row).run();
      return row;
    },
    getTask: task,
    listTasks(projectId: string) {
      return db
        .select()
        .from(tables.aiTasks)
        .where(eq(tables.aiTasks.projectId, projectId))
        .orderBy(asc(tables.aiTasks.createdAt))
        .all();
    },
    updateTask(id: string, patch: Partial<Pick<AiTask, 'status' | 'error'>>) {
      return db.transaction(() => {
        const row = task(id);
        if (patch.status && patch.status !== row.status)
          assertTransition('AiTask', row.status, patch.status);
        const next = aiTaskSchema.parse({ ...row, ...patch, updatedAt: Date.now() });
        db.update(tables.aiTasks).set(next).where(eq(tables.aiTasks.id, id)).run();
        return next;
      });
    },
    createEvaluation(input: unknown) {
      const row = qualityEvaluationSchema.parse(input);
      if (row.status !== 'pending') throw new Error('Evaluation must start pending');
      db.insert(tables.qualityEvaluations).values(row).run();
      return row;
    },
    getEvaluation(id: string) {
      const row = db
        .select()
        .from(tables.qualityEvaluations)
        .where(eq(tables.qualityEvaluations.id, id))
        .get();
      if (!row) throw new Error('Évaluation introuvable');
      return row;
    },
    updateEvaluation(
      id: string,
      patch: Partial<
        Pick<
          QualityEvaluation,
          'status' | 'analysisMode' | 'verdicts' | 'findings' | 'imagesExamined' | 'error'
        >
      >
    ) {
      return db.transaction(() => {
        const row = this.getEvaluation(id);
        if (patch.status && patch.status !== row.status)
          assertTransition('QualityEvaluation', row.status, patch.status);
        const next = qualityEvaluationSchema.parse({ ...row, ...patch, updatedAt: Date.now() });
        db.update(tables.qualityEvaluations)
          .set(next)
          .where(eq(tables.qualityEvaluations.id, id))
          .run();
        return next;
      });
    },
    evaluationsFor(revisionIds: string[]) {
      if (!revisionIds.length) return [];
      return db
        .select()
        .from(tables.qualityEvaluations)
        .where(inArray(tables.qualityEvaluations.revisionId, revisionIds))
        .orderBy(asc(tables.qualityEvaluations.createdAt))
        .all();
    },
    getSetting(key: string) {
      return db.select().from(tables.appSettings).where(eq(tables.appSettings.key, key)).get()
        ?.value;
    },
    setSetting(key: string, value: string) {
      db.insert(tables.appSettings)
        .values({ key, value, updatedAt: Date.now() })
        .onConflictDoUpdate({
          target: tables.appSettings.key,
          set: { value, updatedAt: Date.now() }
        })
        .run();
    }
  };
}
