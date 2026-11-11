/**
 * T129b-2: real Director demonstration with codex-chatgpt (the user's ChatGPT login).
 * Skipped unless the three variables are set: it launches the installed Codex and
 * consumes the plan's quota. Never run by CI or `pnpm test` without them.
 *   VEYRA_CODEX_REAL=1 VEYRA_CODEX_COMMAND=/abs/codex VEYRA_CODEX_HOME=/abs/codex-home \
 *     pnpm --filter studio exec vitest run --project server src/lib/server/director.real.test.ts
 * Reference project: storyboard from the simulated provider (no quota spent), a simulated
 * voice-off on scene 1, renders by colorEngine (real ffmpeg H.264, not HyperFrames). Only the
 * Director's decisions come from Codex. The journal (decisions, tools, artefacts) is
 * written to VEYRA_DIRECTOR_REAL_OUT (default: a kept temporary folder).
 */
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexExecProvider, FakeAiProvider } from '@veyra/ai';
import { ProjectStorage } from '@veyra/storage';
import { createRepository } from './db/repo';
import * as schema from './db/schema';
import { defaultConfigDir, loadRenderSettings, RenderJobRunner } from './jobs/runner';
import { loadStudioSettings, Studio } from './studio';
import { colorEngine } from './test-engines';

const COMMAND = process.env.VEYRA_CODEX_COMMAND ?? '';
const CODEX_HOME = process.env.VEYRA_CODEX_HOME ?? '';
const REAL = Boolean(
  process.env.VEYRA_CODEX_REAL && COMMAND.startsWith('/') && CODEX_HOME.startsWith('/')
);
const goal =
  'Rends la scène 2 plus dynamique, conserve les autres scènes ainsi que la voix off, puis vérifie le résultat';

it.skipIf(!REAL)(
  '[réel codex-chatgpt] Director in the Studio: model decisions, real tools, rendered child, QA',
  async () => {
    const out =
      process.env.VEYRA_DIRECTOR_REAL_OUT ?? mkdtempSync(join(tmpdir(), 'veyra-director-real-'));
    mkdirSync(out, { recursive: true });
    const client = new Database(join(out, 'demo.db'));
    client.pragma('foreign_keys = ON');
    const db = drizzle(client, { schema });
    migrate(db, { migrationsFolder: './drizzle' });
    const repo = createRepository(db);
    const settings = loadStudioSettings(loadRenderSettings(), defaultConfigDir());
    const storage = new ProjectStorage(join(out, 'projects'));
    const app = new Studio(
      repo,
      new RenderJobRunner(
        repo,
        storage,
        colorEngine((id) => repo.getRevision(id).storyboard),
        settings
      ),
      new FakeAiProvider(),
      settings,
      storage
    );
    const projectId = app.createProject('Démo Director réelle').id;
    await app.sendPrompt(
      projectId,
      'Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.'
    );
    const v1 = repo.listRevisions(projectId)[0];
    await app.setNarration(
      v1.id,
      v1.storyboard.scenes[0].id,
      'Voici Pilot, pour les petites équipes.'
    );
    const v2 = repo.listRevisions(projectId).at(-1)!;
    await app.generateVoice(v2.id, v2.storyboard.scenes[0].id, 'fake');
    const parent = repo.listRevisions(projectId).at(-1)!;

    // Only the Director changes provider: the real Codex, its own CODEX_HOME, no API key.
    app.setProvider(
      new CodexExecProvider({
        command: COMMAND,
        env: { HOME: process.env.HOME, CODEX_HOME },
        timeoutMs: settings.models.codexChatgpt.timeoutMs
      })
    );
    const started = Date.now();
    await app.sendPrompt(projectId, goal);
    const run = repo.listRuns(projectId).at(-1)!;
    const final = repo.getRun(run.id);
    const phases = repo.phasesFor([run.id]);
    const steps = repo.loopSteps(phases.find((p) => p.phase === 'plan')!.id);
    const childId = final.revisionId;
    const child = childId ? repo.getRevision(childId) : null;
    const journal = {
      goal,
      durationMs: Date.now() - started,
      run: { id: run.id, status: final.status, error: final.error, aiCalls: final.aiCalls },
      modelDecisions: steps
        .filter((s) => s.origin === 'source')
        .map((s) => ({
          step: s.step,
          action: s.action,
          request: s.request,
          status: s.status,
          tool: s.invocation?.toolId ?? null,
          output: s.result?.ok ? s.result.output : null,
          error: s.error,
          durationMs: s.durationMs,
          artefacts: s.result?.artefacts ?? []
        })),
      loopForcedStops: steps.filter((s) => s.origin === 'engine').map((s) => s.request),
      fixedSteps: phases
        .filter((p) => p.phase !== 'plan')
        .map((p) => ({
          phase: p.phase,
          status: p.status,
          error: p.error,
          payload: (p.result as { payload?: unknown } | null)?.payload ?? null
        })),
      artefacts: {
        parentRevisionId: parent.id,
        childRevisionId: childId,
        childStatus: child?.status ?? null,
        video: child?.videoPath ?? null,
        qa: childId ? (repo.reportsFor([childId]).at(-1)?.checks ?? null) : null
      }
    };
    writeFileSync(join(out, 'journal.json'), JSON.stringify(journal, null, 2));
    console.log(`[director réel] journal : ${join(out, 'journal.json')}`);
    for (const d of journal.modelDecisions)
      console.log(`[décision du modèle] #${d.step} ${d.action} ${d.tool ?? ''} → ${d.status}`);
    for (const f of journal.fixedSteps) console.log(`[étape fixe] ${f.phase} → ${f.status}`);
    client.close();

    // Acceptance of the demo: real tools ran; a child awaiting the human keeps the rest.
    expect(
      journal.modelDecisions.filter((d) => d.tool && d.status === 'done').length
    ).toBeGreaterThanOrEqual(2);
    expect(child?.status).toBe('awaiting_approval');
    child!.storyboard.scenes.forEach((scene, i) => {
      if (i !== 1) expect(scene).toEqual(parent.storyboard.scenes[i]);
      expect(scene.narration ?? null).toEqual(parent.storyboard.scenes[i].narration ?? null);
    });
    expect(child!.audio).toEqual(parent.audio);
  },
  1_800_000
);
