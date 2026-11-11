import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine, type VideoEngine } from '@veyra/hyperframes-adapter';
import { runProcess } from '@veyra/video';
import { ProjectStorage } from '@veyra/storage';
import { AssistedProvider, FakeAiProvider, type AiProvider } from '@veyra/ai';
import {
  captionRulesSchema,
  captionStyleSchema,
  captionTrackSchema,
  groupCaptions,
  sceneFallbackWords,
  type Storyboard
} from '@veyra/schemas';
import { createRepository } from './db/repo';
import { colorEngine as sharedColorEngine } from './test-engines';
import * as schema from './db/schema';
import { defaultConfigDir, loadRenderSettings, RenderJobRunner } from './jobs/runner';
import { loadStudioSettings, Studio } from './studio';

const prompt =
  "Crée une vidéo de 20 secondes présentant un service de création de sites web et d'infogérance pour petites entreprises.";
const slowDown = "À 12 secondes, ralentis l'animation du texte.";

type Repo = ReturnType<typeof createRepository>;
let client: Database.Database, root: string, repo: Repo;

const colorEngine = () => sharedColorEngine((id) => repo.getRevision(id).storyboard);
// Test-only engine whose probe is reported as a real measurement, so deterministic QA applies.
function measuredEngine(durationMs: number, constantFrameRate = true): VideoEngine {
  const fake = new FakeEngine({
    probe: {
      durationMs,
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'h264',
      audioStreams: [],
      size: 100,
      blackSegments: [],
      constantFrameRate
    }
  });
  return {
    kind: 'hyperframes',
    validate: (dir) => fake.validate(dir),
    preview: (dir) => fake.preview(dir),
    render: async (dir, opts, onProgress) => ({
      ...(await fake.render(dir, opts, onProgress)),
      engine: 'hyperframes'
    }),
    inspect: (file) => fake.inspect(file),
    check: (dir) => fake.check(dir)
  };
}
/** Fake provider that counts every AI call. */
function spyAi(base: AiProvider = new FakeAiProvider()) {
  const calls = { generate: 0, plan: 0, review: 0 };
  const ai: AiProvider = {
    kind: base.kind,
    mode: 'direct',
    generateStoryboard: (...args) => (calls.generate++, base.generateStoryboard(...args)),
    planRevision: (...args) => (calls.plan++, base.planRevision(...args)),
    reviewFrames: (...args) => (calls.review++, base.reviewFrames(...args)),
    qualityEvaluator: () => base.qualityEvaluator()
  };
  return { ai, calls };
}
// The reviewer extracts real frames, so it is only wired for engines producing real files.
function studio(ai: ConstructorParameters<typeof Studio>[2], engine?: VideoEngine): Studio {
  const settings = loadStudioSettings(loadRenderSettings(), defaultConfigDir());
  const storage = new ProjectStorage(root);
  const runner: RenderJobRunner = new RenderJobRunner(
    repo,
    storage,
    engine ?? colorEngine(),
    settings,
    engine ? undefined : (revision, path) => app.review(revision, path)
  );
  const app: Studio = new Studio(repo, runner, ai, settings, storage);
  return app;
}
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 600 && !condition(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(condition()).toBe(true);
};
// Real 1080p encodes and frame comparisons: slower than pure unit tests.
vi.setConfig({ testTimeout: 120_000 });
const key = () => `key-${crypto.randomUUID()}`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'veyra-studio-'));
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

it('saves frame annotations without any AI call or render, and edits/deletes drafts', async () => {
  const { ai, calls } = spyAi();
  const app = studio(ai);
  const project = app.createProject('Annotations');
  await app.sendPrompt(project.id, prompt);
  const [v1] = repo.listRevisions(project.id);
  expect(v1.media).toMatchObject({
    fpsNum: 30,
    fpsDen: 1,
    frameCount: 600,
    constantFrameRate: true
  });
  const jobsBefore = repo.renderJobsFor([v1.id]).length;
  const before = { ...calls };

  const note = await app.addAnnotation({
    revisionId: v1.id,
    frameIndex: 360,
    text: slowDown,
    author: 'u'
  });
  await app.addAnnotation({ revisionId: v1.id, frameIndex: 30, text: 'À supprimer', author: 'u' });

  expect(calls).toEqual(before);
  expect(repo.renderJobsFor([v1.id])).toHaveLength(jobsBefore);
  const stored = repo.getFeedback(note.id)!;
  expect(stored).toMatchObject({
    status: 'draft',
    frameIndex: 360,
    timestampMs: 12000,
    fpsNum: 30,
    fpsDen: 1,
    sceneId: v1.storyboard.scenes.find((s) => s.start <= 12000 && 12000 < s.start + s.duration)!.id
  });
  // The capture is the exact decoded frame, stored next to the revision.
  expect(stored.capturePath && readFileSync(stored.capturePath).subarray(1, 4).toString()).toBe(
    'PNG'
  );

  app.editAnnotation(note.id, `${slowDown} Merci.`);
  expect(repo.getFeedback(note.id)!.text).toMatch(/Merci\.$/);
  const doomed = repo.listFeedback(project.id).find((f) => f.text === 'À supprimer')!;
  app.deleteAnnotation(doomed.id);
  expect(repo.getFeedback(doomed.id)).toBeUndefined();
  expect(existsSync(doomed.capturePath!)).toBe(false);
  await expect(
    app.addAnnotation({ revisionId: v1.id, frameIndex: 600, text: 'x', author: 'u' })
  ).rejects.toThrow(/Frame hors/);
});

it('sends one idempotent batch, plans, applies, verifies before/after and waits for a human', async () => {
  const { ai, calls } = spyAi();
  const app = studio(ai);
  const project = app.createProject('Lot');
  await app.sendPrompt(project.id, prompt);
  const [v1] = repo.listRevisions(project.id);
  const slow = await app.addAnnotation({
    revisionId: v1.id,
    frameIndex: 360,
    text: slowDown,
    author: 'u'
  });
  const vague = await app.addAnnotation({
    revisionId: v1.id,
    frameIndex: 60,
    text: "Mets plus d'émotion",
    author: 'u'
  });

  const submissionKey = key();
  const first = app.submitBatch({
    revisionId: v1.id,
    feedbackIds: [slow.id, vague.id],
    submissionKey
  });
  const again = app.submitBatch({
    revisionId: v1.id,
    feedbackIds: [slow.id, vague.id],
    submissionKey
  });
  expect(again.id).toBe(first.id);
  await until(() => repo.getBatch(first.id).status === 'planned');
  expect(calls.plan).toBe(1);
  expect(() =>
    app.submitBatch({ revisionId: v1.id, feedbackIds: [slow.id], submissionKey: key() })
  ).toThrow(/déjà envoyé/);

  const batch = repo.getBatch(first.id);
  const plan = repo.getPlan(batch.planId!)!;
  expect(plan.changes.find((c) => c.feedbackId === slow.id)?.patch).toEqual({ animationMs: 800 });
  await app.applyPlan(plan.id);

  const [source, v2] = repo.listRevisions(project.id);
  expect(source.status).toBe('changes_requested');
  expect(source.storyboard).toEqual(v1.storyboard);
  expect(v2).toMatchObject({ parentRevisionId: v1.id, status: 'awaiting_approval' });
  const done = repo.getBatch(first.id);
  expect(done).toMatchObject({ status: 'applied', resultRevisionId: v2.id });
  expect(done.verification).toEqual([
    expect.objectContaining({ feedbackId: slow.id, verdict: 'applied' }),
    expect.objectContaining({ feedbackId: vague.id, verdict: 'not_applied' })
  ]);
  const report = repo.reportsFor([v2.id]).at(-1)!;
  expect(report.checks.filter((c) => c.name.startsWith('Correction'))).toHaveLength(2);
  // Untouched scenes rendered identically: no regression reported.
  expect(report.checks.some((c) => c.name === 'Régression possible')).toBe(false);
  expect(repo.getFeedback(slow.id)?.status).toBe('applied');

  // QA never approves: export stays blocked until a human validates.
  expect(repo.getRevision(v2.id).status).toBe('awaiting_approval');
  app.approve(v2.id);
  expect(repo.getRevision(v2.id).status).toBe('approved');
});

it('keeps comments added during analysis out of the running batch', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const base = new FakeAiProvider();
  const slowPlanner: AiProvider = {
    ...spyAi(base).ai,
    planRevision: async (...args) => (await gate, base.planRevision(...args))
  };
  const app = studio(slowPlanner);
  const project = app.createProject('Pendant');
  await app.sendPrompt(project.id, prompt);
  const [v1] = repo.listRevisions(project.id);
  const a = await app.addAnnotation({
    revisionId: v1.id,
    frameIndex: 360,
    text: slowDown,
    author: 'u'
  });
  const batch = app.submitBatch({ revisionId: v1.id, feedbackIds: [a.id], submissionKey: key() });
  const late = await app.addAnnotation({
    revisionId: v1.id,
    frameIndex: 10,
    text: 'Plus tard',
    author: 'u'
  });
  release();
  await until(() => repo.getBatch(batch.id).status === 'planned');
  expect(repo.getBatch(batch.id).feedbackIds).toEqual([a.id]);
  expect(repo.getFeedback(late.id)).toMatchObject({ status: 'draft', batchId: null });
});

it('keeps comments when the provider fails, retries the same batch, never switches provider', async () => {
  let failing = true;
  const base = new FakeAiProvider();
  const flaky: AiProvider = {
    ...spyAi(base).ai,
    planRevision: async (...args) => {
      if (failing) throw new Error('quota dépassé');
      return base.planRevision(...args);
    }
  };
  const app = studio(flaky);
  const project = app.createProject('Erreur');
  await app.sendPrompt(project.id, prompt);
  const [v1] = repo.listRevisions(project.id);
  const a = await app.addAnnotation({
    revisionId: v1.id,
    frameIndex: 360,
    text: slowDown,
    author: 'u'
  });
  const batch = app.submitBatch({ revisionId: v1.id, feedbackIds: [a.id], submissionKey: key() });
  await until(() => repo.getBatch(batch.id).status === 'failed');
  expect(repo.getBatch(batch.id).error).toMatch(/quota/);
  expect(repo.getFeedback(a.id)).toMatchObject({ status: 'failed', text: slowDown });

  // Another provider is never used for a batch, even when the user switches.
  app.setProvider(new AssistedProvider());
  await app.retryBatch(batch.id);
  expect(repo.getBatch(batch.id)).toMatchObject({ status: 'failed' });
  expect(repo.getBatch(batch.id).error).toMatch(/non actif/);

  app.setProvider(flaky);
  failing = false;
  await app.retryBatch(batch.id);
  await until(() => repo.getBatch(batch.id).status === 'planned');
  expect(repo.getFeedback(a.id)?.status).toBe('submitted');
});

it('claude-subscribe exports requests and only accepts a valid imported result', async () => {
  const app = studio(new AssistedProvider());
  const project = app.createProject('Assisté');
  await app.sendPrompt(project.id, prompt);
  const [storyTask] = repo.listTasks(project.id);
  expect(storyTask).toMatchObject({ kind: 'storyboard', status: 'awaiting_import' });
  const request = JSON.parse(readFileSync(join(storyTask.dir, 'request.json'), 'utf8'));
  expect(request).toMatchObject({ format: 'veyra-ai-task/v1', kind: 'storyboard' });
  expect(repo.listRevisions(project.id)).toHaveLength(0);

  expect(() => app.importTask(storyTask.id)).toThrow(/illisible/);
  writeFileSync(join(storyTask.dir, 'result.json'), '{"title":"x","scenes":[]}');
  expect(() => app.importTask(storyTask.id)).toThrow(/non conforme/);
  expect(repo.getTask(storyTask.id).status).toBe('awaiting_import');
  const draft = await new FakeAiProvider().generateStoryboard(prompt, {
    targetDurationMs: 20000,
    styleInstructions: ''
  });
  writeFileSync(join(storyTask.dir, 'result.json'), JSON.stringify(draft));
  await app.importTask(storyTask.id);
  const [v1] = repo.listRevisions(project.id);
  expect(v1).toMatchObject({ status: 'awaiting_approval' });
  expect(v1.resolvedConfig.aiProvider).toBe('claude-subscribe');

  const a = await app.addAnnotation({
    revisionId: v1.id,
    frameIndex: 360,
    text: slowDown,
    author: 'u'
  });
  const batch = app.submitBatch({ revisionId: v1.id, feedbackIds: [a.id], submissionKey: key() });
  expect(repo.getBatch(batch.id).status).toBe('awaiting_import');
  const planTask = repo.listTasks(project.id).find((t) => t.kind === 'plan')!;
  expect(existsSync(join(planTask.dir, 'frames', `${a.id}.png`))).toBe(true);
  const sceneId = v1.storyboard.scenes.find(
    (s) => s.start <= 12000 && 12000 < s.start + s.duration
  )!.id;
  writeFileSync(
    join(planTask.dir, 'result.json'),
    JSON.stringify({
      summary: 'Ralentir la scène 3',
      changes: [
        { feedbackId: a.id, sceneId, instruction: 'Ralentir', patch: { animationMs: 900 } },
        // Unknown ids from the file are dropped, never trusted.
        { feedbackId: 'fdb_unknown', sceneId: 'scn_unknown', instruction: 'x', patch: {} }
      ],
      conflicts: []
    })
  );
  const plan = app.importTask(planTask.id) as { id: string; changes: { sceneId: string | null }[] };
  expect(plan.changes.map((c) => c.sceneId)).toEqual([sceneId, null]);
  expect(repo.getBatch(batch.id)).toMatchObject({ status: 'planned', planId: plan.id });
});

it('retries a failed deterministic check at most twice, then waits for a human', async () => {
  const app = studio(new FakeAiProvider(), measuredEngine(1000)); // every render measures 1 s instead of 20 s
  const project = app.createProject('Auto-fix');
  await app.sendPrompt(project.id, prompt);
  const revisions = repo.listRevisions(project.id);
  expect(revisions.map((r) => r.status)).toEqual([
    'changes_requested',
    'changes_requested',
    'awaiting_approval'
  ]);
  expect(revisions[2].parentRevisionId).toBe(revisions[1].id);
  const messages = repo.listMessages(repo.conversationFor(project.id)!.id).map((m) => m.text);
  expect(messages.filter((text) => text.includes('Correction automatique'))).toHaveLength(2);
  expect(messages.at(-1)).toMatch(/contrôle\(s\) en échec/);
});

// Real H.264 render that flashes at 5 Hz around a fixed low-contrast box (#9a9a9a bars on #808080).
function flashingEngine(): VideoEngine {
  const base = colorEngine();
  return {
    ...base,
    async render(_dir, opts) {
      const { width, height, scenes } = repo.getRevision(
        /revisions\/(rev_[^/]+)\//.exec(opts.outputPath)![1]
      ).storyboard;
      const seconds = Math.max(...scenes.map((s) => s.start + s.duration)) / 1000;
      const bars = [0, 1, 2]
        .map((i) => `drawbox=x=${140 + i * 120}:y=140:w=40:h=120:color=0x9a9a9a:t=fill`)
        .join(',');
      await runProcess(
        'ffmpeg',
        [
          '-nostdin',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `color=c=white:s=${width}x${height}:r=30:d=${seconds},drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='lt(mod(n\\,6)\\,3)',drawbox=x=100:y=100:w=400:h=200:color=0x808080:t=fill,${bars}`,
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          opts.outputPath
        ],
        { timeoutMs: 60000 }
      );
      return { path: opts.outputPath, engine: 'hyperframes', stderrTail: '' };
    },
    check: async () => ({
      ok: false,
      engine: 'hyperframes',
      sections: {
        contrast: {
          ok: false,
          errorCount: 1,
          warningCount: 0,
          checked: 10,
          passed: 9,
          findings: [
            {
              code: 'contrast_aa_failure',
              severity: 'error',
              message: 'Contrast is 1.4:1; WCAG AA requires 4.5:1.',
              text: 'Bars',
              fg: 'rgb(154,154,154)',
              ratio: 1.4,
              requiredRatio: 4.5,
              large: false,
              bbox: { x: 100, y: 100, width: 400, height: 200 },
              time: 1
            }
          ]
        }
      }
    })
  };
}
it('reports flash and rendered-contrast measurements without any automatic correction', async () => {
  const app = studio(new FakeAiProvider(), flashingEngine());
  const project = app.createProject('Flashes');
  await app.sendPrompt(project.id, prompt);
  const revisions = repo.listRevisions(project.id);
  // Both checks fail, yet no new render is attempted: only a human can decide.
  expect(revisions.map((r) => r.status)).toEqual(['awaiting_approval']);
  const messages = repo.listMessages(repo.conversationFor(project.id)!.id).map((m) => m.text);
  expect(messages.some((text) => text.includes('Correction automatique'))).toBe(false);
  const checks = repo.reportsFor([revisions[0].id]).at(-1)!.checks;
  const flashes = checks.find((c) => c.name === 'Photosensibilité (flashs, mesure technique)');
  const contrast = checks.find((c) => c.name === "Contraste mesuré sur l'image rendue");
  expect(flashes).toMatchObject({
    passed: false,
    severity: 'major',
    analysisMode: 'deterministic'
  });
  expect(JSON.parse(flashes!.evidence).maxFlashsParSeconde).toBe(5);
  expect(contrast).toMatchObject({
    passed: false,
    severity: 'minor',
    analysisMode: 'deterministic'
  });
  const zone = JSON.parse(contrast!.evidence).zones[0];
  expect(zone).toMatchObject({ frame: 30, ratioHyperFrames: 1.4, requis: 4.5, statut: 'mesuré' });
  expect(Math.abs(zone.ratioMesure - 1.4)).toBeLessThan(0.1);
  // Deterministic output checks still pass: the failures above are not retryable.
  expect(
    checks
      .filter((c) => !c.passed && c.analysisMode === 'deterministic')
      .map((c) => c.name)
      .sort()
  ).toEqual([
    "Contraste mesuré sur l'image rendue",
    'Lisibilité (contraste WCAG AA)',
    'Photosensibilité (flashs, mesure technique)'
  ]);
});

it('refuses work without AI and rejects comments outside the video', async () => {
  const offline = studio(null, measuredEngine(20000));
  const project = offline.createProject('Sans IA');
  expect(() => offline.sendPrompt(project.id, prompt)).toThrow(/IA non configurée/);

  const app = studio(new FakeAiProvider(), measuredEngine(20000));
  await app.sendPrompt(project.id, prompt);
  const [revision] = repo.listRevisions(project.id);
  await expect(
    app.addAnnotation({ revisionId: revision.id, timestampMs: 25000, text: 'x', author: 'u' })
  ).rejects.toThrow(/hors de la vidéo/);
});

it('refuses frame annotations on a variable frame rate render', async () => {
  const app = studio(new FakeAiProvider(), measuredEngine(20000, false));
  const project = app.createProject('VFR');
  await app.sendPrompt(project.id, prompt);
  const [revision] = repo.listRevisions(project.id);
  expect(revision.media?.constantFrameRate).toBe(false);
  await expect(
    app.addAnnotation({ revisionId: revision.id, frameIndex: 10, text: 'x', author: 'u' })
  ).rejects.toThrow(/fréquence variable/);
});

function captionTrack(board: Storyboard) {
  const words = sceneFallbackWords(
    board.scenes.map((s) => ({ ...s, narration: { text: 'Une phrase lue dans la scène.' } }))
  );
  return captionTrackSchema.parse({
    schemaVersion: 1,
    id: 'cap_test',
    words,
    cues: groupCaptions(words, captionStyleSchema.parse({}), captionRulesSchema.parse({})),
    provenance: { provider: 'script' }
  });
}
it('carries captions to correction children, checks cue comments, starts a new prompt without', async () => {
  const app = studio(new FakeAiProvider());
  const project = app.createProject('Sous-titres');
  await app.sendPrompt(project.id, prompt);
  const [v1] = repo.listRevisions(project.id);
  expect(v1.captions).toBeNull();
  // No Studio API writes captions yet (T121): seed the rendered revision directly.
  const captions = captionTrack(v1.storyboard);
  client
    .prepare('update video_revisions set captions = ? where id = ?')
    .run(JSON.stringify(captions), v1.id);
  const raw = () =>
    client
      .prepare('select storyboard, audio, captions from video_revisions where id = ?')
      .get(v1.id);
  const before = raw();

  await expect(
    app.addAnnotation({
      revisionId: v1.id,
      frameIndex: 360,
      captionCueId: 'cue_unknown',
      text: slowDown,
      author: 'u'
    })
  ).rejects.toThrow(/Sous-titre introuvable/);
  const cueId = captions.cues[0].id;
  const comment = await app.addAnnotation({
    revisionId: v1.id,
    frameIndex: 360,
    captionCueId: cueId,
    text: slowDown,
    author: 'u'
  });
  expect(repo.getFeedback(comment.id)?.captionCueId).toBe(cueId);

  const batch = app.submitBatch({
    revisionId: v1.id,
    feedbackIds: [comment.id],
    submissionKey: key()
  });
  await until(() => repo.getBatch(batch.id).status === 'planned');
  await app.applyPlan(repo.getBatch(batch.id).planId!);
  const v2 = repo.listRevisions(project.id).at(-1)!;
  expect(v2.parentRevisionId).toBe(v1.id);
  expect(v2.captions).toEqual(captions);
  expect(raw()).toEqual(before);

  // v2 awaits approval: without « nouvelle vidéo » the message would go to the Director (T129b-2).
  await app.sendPrompt(project.id, prompt, 0, { fresh: true });
  const fresh = repo.listRevisions(project.id).at(-1)!;
  expect(fresh.id).not.toBe(v2.id);
  expect(fresh.captions).toBeNull();
});
