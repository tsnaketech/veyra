import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStorage } from '@veyra/storage';
import { runProcess } from '@veyra/video';
import { captionBandRect } from '@veyra/hyperframes-adapter';
import {
  FakeAiProvider,
  revisionProposalSchema,
  type AiProvider,
  type RevisionProposalInput
} from '@veyra/ai';
import {
  captionPrecisionSummary,
  captionStyleSchema,
  type CaptionTrack,
  type Storyboard
} from '@veyra/schemas';
import { createRepository } from './db/repo';
import * as schema from './db/schema';
import { defaultConfigDir, loadRenderSettings, RenderJobRunner } from './jobs/runner';
import {
  buildFallbackCaptions,
  fittedCharsPerLine,
  loadStudioSettings,
  refreshCaptions,
  Studio
} from './studio';
import { colorEngine } from './test-engines';

vi.setConfig({ testTimeout: 180_000 });

const narration = (text: string) => ({ narration: { text } });
const board = (scenes: [number, number, string | null][]) => ({
  scenes: scenes.map(([start, duration, text], i) => ({
    id: `scn_${i}`,
    start,
    duration,
    text: `Titre ${i}`,
    animation: {},
    ...(text ? narration(text) : {})
  }))
});
const LONG =
  'Pilot réunit les tâches, les échéances et les échanges de votre équipe dans un seul espace clair, partagé et toujours à jour.';

describe('fallback captions', () => {
  it('fits the default style in portrait 1080×1920 and keeps 42 characters in landscape', () => {
    const style = captionStyleSchema.parse({});
    const portrait = { width: 1080, height: 1920 };
    const chars = fittedCharsPerLine(style, portrait);
    expect(chars).toBeLessThan(42);
    expect(fittedCharsPerLine(style, { width: 1920, height: 1080 })).toBe(42);
    const track = buildFallbackCaptions(board([[0, 6000, LONG]]), portrait);
    const font = Math.round((style.sizePct * portrait.height) / 100);
    const rect = captionBandRect(style, portrait, 1);
    for (const cue of track.cues)
      for (const line of cue.lines) {
        expect([...line].length).toBeLessThanOrEqual(chars);
        // Estimated text width plus padding stays inside the caption box.
        expect([...line].length * 0.6 * font + 2 * Math.round(font / 2)).toBeLessThanOrEqual(
          rect.width
        );
      }
  });

  it('is script-only, monotonic and inside each scene, flagged approximate', () => {
    const scenes = board([
      [0, 3000, 'Bonjour à toutes et à tous.'],
      [3000, 2000, null],
      [5000, 4000, LONG]
    ]);
    const track = buildFallbackCaptions(scenes, { width: 1920, height: 1080 });
    expect(track.provenance.provider).toBe('script');
    expect(new Set(track.words.map((w) => w.timing))).toEqual(new Set(['scene']));
    expect(captionPrecisionSummary(track).approximateShare).toBe(1);
    track.words.forEach((w, i) => {
      if (i) expect(w.startMs).toBeGreaterThanOrEqual(track.words[i - 1].endMs);
      const scene = scenes.scenes.find((s) => s.id === w.sceneId)!;
      expect(w.startMs).toBeGreaterThanOrEqual(scene.start);
      expect(w.endMs).toBeLessThanOrEqual(scene.start + scene.duration);
    });
    expect(track.words.some((w) => w.sceneId === 'scn_1')).toBe(false);
  });
});

describe('refreshCaptions', () => {
  const format = { width: 1920, height: 1080 };
  const parent = board([
    [0, 3000, 'Première scène racontée.'],
    [3000, 3000, 'Deuxième scène racontée.'],
    [6000, 3000, 'Troisième scène.']
  ]);
  it('keeps unchanged scenes, rebuilds changed ones and warns about replaced manual times', () => {
    const base = buildFallbackCaptions(parent, format);
    // The user retimed the second scene's first word by hand.
    const words = base.words.map((w, i) =>
      w.sceneId === 'scn_1' && i === base.words.findIndex((x) => x.sceneId === 'scn_1')
        ? { ...w, timing: 'manual' as const }
        : w
    );
    const captions: CaptionTrack = { ...base, words };
    expect(refreshCaptions(parent, parent, captions, format)).toEqual({ captions, warnings: [] });
    // Scene 2 grows: its own words and the shifted scene 3 are rebuilt; scene 1 is kept.
    const child = board([
      [0, 3000, 'Première scène racontée.'],
      [3000, 4000, 'Deuxième scène racontée.'],
      [7000, 3000, 'Troisième scène.']
    ]);
    const { captions: next, warnings } = refreshCaptions(parent, child, captions, format);
    const of = (t: CaptionTrack, id: string) => t.words.filter((w) => w.sceneId === id);
    expect(of(next!, 'scn_0')).toEqual(of(captions, 'scn_0'));
    expect(of(next!, 'scn_1').every((w) => w.timing === 'scene')).toBe(true);
    expect(of(next!, 'scn_1').at(-1)!.endMs).toBe(7000);
    expect(of(next!, 'scn_2')[0].startMs).toBe(7000);
    expect(warnings).toEqual([expect.stringMatching(/scène 2 : 1 mot\(s\) aux temps manual/)]);
    expect(next!.cues.at(-1)!.endMs).toBeLessThanOrEqual(10000 + 800);
  });
  it('rebuilds a re-narrated scene and leaves no captions when there are none', () => {
    const captions = buildFallbackCaptions(parent, format);
    const child = board([
      [0, 3000, 'Première scène racontée.'],
      [3000, 3000, 'Un tout autre texte.'],
      [6000, 3000, 'Troisième scène.']
    ]);
    const { captions: next } = refreshCaptions(parent, child, captions, format);
    expect(
      next!.words
        .filter((w) => w.sceneId === 'scn_1')
        .map((w) => w.text)
        .join(' ')
    ).toBe('Un tout autre texte.');
    expect(refreshCaptions(parent, child, null, format)).toEqual({
      captions: null,
      warnings: []
    });
  });
});

// --- Studio flows (FakeEngine-based colour renders, real FFmpeg audio).

const saas =
  'Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.';
let client: Database.Database, root: string, fixtures: string;
let repo: ReturnType<typeof createRepository>;
let renders = 0;

async function wav(name: string, seconds: number) {
  const path = join(fixtures, name);
  await runProcess('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    String(seconds),
    '-ac',
    '2',
    path
  ]);
  const data = new Uint8Array(readFileSync(path));
  return { file: new File([data], name, { type: 'audio/wav' }), data };
}
function scripted(plan: (board: Storyboard, ids: string[]) => RevisionProposalInput): AiProvider {
  const base = new FakeAiProvider();
  return {
    kind: 'fake',
    mode: 'direct',
    generateStoryboard: (...args) => base.generateStoryboard(...args),
    reviewFrames: (...args) => base.reviewFrames(...args),
    planRevision: async (b, feedback) =>
      revisionProposalSchema.parse(
        plan(
          b,
          feedback.map((f) => f.id)
        )
      ),
    qualityEvaluator: () => base.qualityEvaluator()
  };
}
function studio(ai: AiProvider = new FakeAiProvider()) {
  const settings = loadStudioSettings(loadRenderSettings(), defaultConfigDir());
  const storage = new ProjectStorage(root);
  const engine = colorEngine((id) => repo.getRevision(id).storyboard);
  const counted = {
    ...engine,
    render: (...args: Parameters<typeof engine.render>) => (renders++, engine.render(...args))
  };
  return new Studio(
    repo,
    new RenderJobRunner(repo, storage, counted, settings),
    ai,
    settings,
    storage
  );
}
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 900 && !condition(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(condition()).toBe(true);
};
const latest = (projectId: string) => repo.listRevisions(projectId).at(-1)!;
const texts = (projectId: string) => {
  const conversation = repo.conversationFor(projectId)!;
  return repo.listMessages(conversation.id).map((m) => m.text);
};
async function narrated(app: Studio) {
  const project = app.createProject('Voix');
  await app.sendPrompt(project.id, saas);
  const v1 = latest(project.id);
  const scene = v1.storyboard.scenes[0];
  await app.setNarration(v1.id, scene.id, 'Voici Pilot, la gestion simple des petites équipes.');
  return { project, v1, scene, v2: latest(project.id) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'veyra-voice-'));
  fixtures = mkdtempSync(join(tmpdir(), 'veyra-voice-fx-'));
  client = new Database(':memory:');
  client.pragma('foreign_keys = ON');
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  repo = createRepository(db);
  renders = 0;
});
afterEach(() => {
  client.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(fixtures, { recursive: true, force: true });
});

it('setNarration creates a child revision with fallback captions; the parent is untouched', async () => {
  const app = studio();
  const { v1, scene, v2 } = await narrated(app);
  expect(v2).toMatchObject({ parentRevisionId: v1.id, status: 'awaiting_approval' });
  expect(v2.storyboard.scenes[0].narration?.text).toMatch(/^Voici Pilot/);
  // New captions are burned by default: the picture is rendered again (narration alone is not drawn).
  expect(renders).toBe(2);
  expect(v2.captions!.provenance.provider).toBe('script');
  expect(v2.captions!.words.every((w) => w.timing === 'scene' && w.sceneId === scene.id)).toBe(
    true
  );
  expect(v2.captions!.words.at(-1)!.endMs).toBe(scene.start + scene.duration);
  const parent = repo.getRevision(v1.id);
  expect(parent).toMatchObject({ status: 'changes_requested', captions: null });
  expect(parent.storyboard).toEqual(v1.storyboard);
  expect(() => app.setNarration(v1.id, scene.id, 'x')).toThrow(/en attente de validation/);
  expect(() => app.setNarration(v2.id, 'scn_absent', 'x')).toThrow(/Scène introuvable/);
});

it('fake voice is labelled [Simulé]; replacing it by an imported voice keeps storyboard and comments', async () => {
  const app = studio();
  const { project, scene, v2 } = await narrated(app);
  await app.generateVoice(v2.id, scene.id, 'fake');
  const v3 = latest(project.id);
  expect(v3.parentRevisionId).toBe(v2.id);
  expect(v3.storyboard).toEqual(v2.storyboard);
  expect(renders).toBe(2); // the voice only remixes the sound
  const fakeTrack = v3.audio!.tracks.find((t) => t.category === 'voiceover')!;
  expect(fakeTrack.label).toBe('[Simulé] Voix scène 1');
  expect(fakeTrack.anchor).toMatchObject({ type: 'event', sceneId: scene.id, event: 'scene' });
  expect(texts(project.id).some((t) => t.startsWith('[Simulé] Voix simulée'))).toBe(true);
  expect(v3.videoPath).toBeTruthy();

  const comment = await app.addAnnotation({
    revisionId: v3.id,
    frameIndex: 10,
    text: 'Voix trop aiguë',
    author: 'u'
  });
  const before = structuredClone(repo.getRevision(v3.id));
  const videoBytes = readFileSync(before.videoPath!);
  const recorded = await wav('voix.wav', 1.5);
  await app.importVoice(v3.id, scene.id, recorded.file, recorded.data);
  const v4 = latest(project.id);
  expect(v4).toMatchObject({ parentRevisionId: v3.id, status: 'awaiting_approval' });
  expect(v4.storyboard).toEqual(v3.storyboard);
  const voices = v4.audio!.tracks.filter((t) => t.category === 'voiceover');
  expect(voices).toHaveLength(1);
  expect(voices[0].label).toBe('Voix scène 1');
  expect(repo.getAsset(voices[0].assetId)!.audio).toMatchObject({
    status: 'valid',
    category: 'voiceover'
  });
  expect(v4.captions!.words.filter((w) => w.sceneId === scene.id).length).toBeGreaterThan(0);
  expect(captionPrecisionSummary(v4.captions!).approximateShare).toBe(1);
  // Parent and its comment unchanged, apart from the review status.
  const after = repo.getRevision(v3.id);
  expect({ ...after, status: before.status, updatedAt: before.updatedAt }).toEqual(before);
  expect(readFileSync(after.videoPath!).equals(videoBytes)).toBe(true);
  expect(repo.getFeedback(comment.id)).toEqual(comment);
  // Picture reused: voice changes never re-render (storyboard identical).
  expect(repo.renderJobsFor([v4.id]).at(-1)!.resolvedConfig).toMatchObject({
    videoReusedFrom: v3.id
  });
});

it('local-tts is reported as not installed and never replaced by a simulated voice', async () => {
  const app = studio();
  const { project, scene, v2 } = await narrated(app);
  const assets = repo.listAssets(project.id).length;
  await expect(app.generateVoice(v2.id, scene.id, 'local-tts')).rejects.toThrow(
    /Moteur non installé — Aucun moteur de synthèse locale/
  );
  expect(latest(project.id).id).toBe(v2.id);
  expect(repo.getRevision(v2.id).status).toBe('awaiting_approval');
  expect(repo.listAssets(project.id)).toHaveLength(assets);
  const silent = v2.storyboard.scenes[1];
  await expect(app.generateVoice(v2.id, silent.id, 'fake')).rejects.toThrow(/pas de narration/);
});

it('warns when a voice is longer than its scene, without changing the storyboard', async () => {
  const app = studio();
  const { project, scene, v2 } = await narrated(app);
  const long = await wav('long.wav', scene.duration / 1000 + 1);
  await app.importVoice(v2.id, scene.id, long.file, long.data);
  const v3 = latest(project.id);
  expect(v3.storyboard).toEqual(v2.storyboard);
  expect(texts(project.id).at(-2)).toMatch(/Attention : La voix .* dépasse la scène de 1\.0 s/);
  const planPhase = repo
    .phasesFor(repo.listRuns(project.id).map((r) => r.id))
    .filter((p) => p.phase === 'plan')
    .at(-1)!;
  expect(planPhase.result).toMatchObject({ validation: 'needs-human' });
});

it('stores the caption delivery and carries it to later children', async () => {
  const app = studio();
  const { project, v2 } = await narrated(app);
  await app.setCaptionDelivery(v2.id, 'both');
  const v3 = latest(project.id);
  expect(v3.resolvedConfig).toMatchObject({
    captionDelivery: 'both',
    origin: { edit: 'caption-delivery' }
  });
  expect(v3.captions).toEqual(v2.captions);
  expect(() => app.setCaptionDelivery(v3.id, 'x' as never)).toThrow(/inconnue/);
  await app.setNarration(v3.id, v3.storyboard.scenes[1].id, 'Deuxième scène.');
  expect(latest(project.id).resolvedConfig.captionDelivery).toBe('both');
});

it('a motion correction rebuilds the captions of resized and shifted scenes only', async () => {
  const app = studio(
    scripted((b, [id]) => ({
      summary: 'longer first scene',
      changes: [
        { feedbackId: id, sceneId: b.scenes[0].id, instruction: 'x', patch: { durationMs: 6000 } }
      ],
      conflicts: []
    }))
  );
  const { project, scene, v2 } = await narrated(app);
  await app.setNarration(v2.id, v2.storyboard.scenes.at(-1)!.id, 'Essayez Pilot dès aujourd’hui.');
  const v3 = latest(project.id);
  const comment = await app.addAnnotation({
    revisionId: v3.id,
    frameIndex: 10,
    text: 'Plus long',
    author: 'u'
  });
  const batch = app.submitBatch({
    revisionId: v3.id,
    feedbackIds: [comment.id],
    submissionKey: `key-${crypto.randomUUID()}`
  });
  await until(() => repo.getBatch(batch.id).status === 'planned');
  await app.applyPlan(repo.getBatch(batch.id).planId!);
  const v4 = latest(project.id);
  expect(v4.parentRevisionId).toBe(v3.id);
  const first = v4.captions!.words.filter((w) => w.sceneId === scene.id);
  expect(first.at(-1)!.endMs).toBe(scene.start + 6000);
  const last = v4.storyboard.scenes.at(-1)!;
  const lastWords = v4.captions!.words.filter((w) => w.sceneId === last.id);
  expect(lastWords[0].startMs).toBe(last.start);
  expect(lastWords.at(-1)!.endMs).toBe(last.start + last.duration);
});

it('clean delivery: a narration change reuses the clean picture (narration is never drawn)', async () => {
  const app = studio();
  const { project, v2 } = await narrated(app);
  await app.setCaptionDelivery(v2.id, 'clean');
  const v3 = latest(project.id);
  const before = renders;
  await app.setNarration(v3.id, v3.storyboard.scenes[0].id, 'Un autre texte lu.');
  const v4 = latest(project.id);
  expect(v4.parentRevisionId).toBe(v3.id);
  expect(v4.captions).not.toEqual(v3.captions);
  expect(renders).toBe(before);
});
