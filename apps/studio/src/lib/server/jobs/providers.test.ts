import { afterAll, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../db/repo';
import * as schema from '../db/schema';

// Server wiring of the AI providers (T146): no key, no lock, Claude Code reported missing.
const env = vi.hoisted(() => ({ DATABASE_URL: '', root: '' }));
vi.mock('$app/env', () => ({ building: false }));
vi.mock('$app/env/private', () => ({
  DATABASE_URL: env.DATABASE_URL,
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
  VEYRA_AI_PROVIDER: ''
}));
const probe = vi.hoisted(() => vi.fn());
vi.mock('@veyra/ai', async (original) => ({
  ...(await original<typeof import('@veyra/ai')>()),
  checkClaudeSubscribe: probe
}));

env.root = mkdtempSync(join(tmpdir(), 'veyra-providers-'));
env.DATABASE_URL = join(env.root, 'veyra.db');
process.env.VEYRA_PROJECTS_ROOT = join(env.root, 'projects');
afterAll(() => rmSync(env.root, { recursive: true, force: true }));

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 250 && !condition(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(condition()).toBe(true);
};

it('re-checks the stored provider at startup and resolves providers per project', async () => {
  // A previous session chose claude-subscribe; Claude Code is gone since.
  const seed = new Database(env.DATABASE_URL);
  const seedDb = drizzle(seed, { schema });
  migrate(seedDb, { migrationsFolder: './drizzle' });
  createRepository(seedDb).setSetting('aiProvider', 'claude-subscribe');
  seed.close();
  let answer!: (status: object) => void;
  probe.mockReturnValue(new Promise((resolve) => (answer = resolve)));

  const jobs = await import('./index');
  try {
    // Startup is not blocked by the probe, and the unchecked provider is not used meanwhile.
    expect(jobs.studio.aiKind).toBeNull();
    answer({ available: false, reason: 'Claude Code non détecté.' });
    await until(
      () => jobs.providerError?.startsWith('Fournisseur enregistré indisponible') ?? false
    );
    expect(jobs.providerError).toBe(
      'Fournisseur enregistré indisponible : Claude Code non détecté.'
    );
    // No fallback, and the stored choice is kept.
    expect(jobs.studio.aiKind).toBeNull();
    expect(jobs.repo.getSetting('aiProvider')).toBe('claude-subscribe');

    // Per project (D024): its own provider wins over the global one.
    const project = jobs.studio.createProject('Par projet').id;
    expect(jobs.studio.providerFor(project)).toEqual({ kind: null, error: null });
    await jobs.chooseProjectProvider(project, 'fake');
    expect(jobs.studio.providerFor(project)).toEqual({ kind: 'fake', error: null });
    // An unavailable provider is refused, and never replaced when already stored.
    await expect(jobs.chooseProjectProvider(project, 'anthropic-api')).rejects.toThrow(
      'ANTHROPIC_API_KEY non définie'
    );
    jobs.repo.setProjectProvider(project, 'claude-subscribe');
    expect(jobs.studio.providerFor(project)).toEqual({
      kind: null,
      error: 'Fournisseur du projet indisponible : Claude Code non détecté.'
    });
    expect(() => jobs.studio.sendPrompt(project, 'Une vidéo')).toThrow(
      'Fournisseur du projet indisponible'
    );
    // Back to the global choice.
    await jobs.chooseProjectProvider(project, null);
    expect(jobs.repo.getProject(project)!.aiProvider).toBeNull();
    expect(jobs.studio.providerFor(project)).toEqual({ kind: null, error: null });
  } finally {
    jobs.stopAssistedWatch();
  }
});
