import { ProjectStorage } from '@veyra/storage';
import {
  checkClaudeSubscribe,
  createProvider,
  providerIds,
  type Provider,
  type ProviderId
} from '@veyra/ai';
import { ANTHROPIC_API_KEY, VEYRA_AI_PROVIDER } from '$app/env/private';
import { db } from '../db';
import { createRepository } from '../db/repo';
import { loadStudioSettings, Studio } from '../studio';
import { createRenderJobRunner, defaultConfigDir, loadRenderSettings } from './runner';

const configDir = defaultConfigDir();
export const repo = createRepository(db);
export const settings = loadStudioSettings(loadRenderSettings(configDir), configDir);

/** The environment variable locks the choice; otherwise /settings decides. */
export const providerLocked = Boolean(VEYRA_AI_PROVIDER);
export let providerError: string | null = null;
function selectedProvider(): ProviderId | null {
  if (VEYRA_AI_PROVIDER) return VEYRA_AI_PROVIDER;
  const stored = repo.getSetting('aiProvider');
  if (stored && (providerIds as readonly string[]).includes(stored)) return stored as ProviderId;
  return settings.models.defaultProvider;
}
function build(id: ProviderId | null): Provider | null {
  providerError = null;
  if (!id) return null;
  try {
    return createProvider(id, { ANTHROPIC_API_KEY }, settings.models.models[0]);
  } catch (error) {
    // Unavailable stays unavailable: no other provider is substituted.
    providerError = error instanceof Error ? error.message : String(error);
    return null;
  }
}
export const selectedProviderId = () => selectedProvider();

// One runner and one Studio per server process; nothing renders until an action enqueues.
export const renderJobRunner = createRenderJobRunner(repo, settings, (revision, path) =>
  studio.review(revision, path)
);
export const storage = new ProjectStorage(settings.storageRoot);
export const studio = new Studio(
  repo,
  renderJobRunner,
  build(selectedProvider()),
  settings,
  storage
);

export function chooseProvider(id: ProviderId) {
  if (providerLocked) throw new Error('Fournisseur imposé par VEYRA_AI_PROVIDER');
  repo.setSetting('aiProvider', id);
  studio.setProvider(build(id));
}
export const claudeSubscribeStatus = () =>
  checkClaudeSubscribe({ command: settings.models.claudeSubscribe.command });

// Assisted mode: import result.json as soon as the user's Claude Code session wrote it.
const assistedWatch = setInterval(() => {
  try {
    studio.watchAssistedTasks();
  } catch (error) {
    console.error('Surveillance du mode assisté :', error instanceof Error ? error.message : error);
  }
}, 2000);
assistedWatch.unref();
export const stopAssistedWatch = () => clearInterval(assistedWatch);
