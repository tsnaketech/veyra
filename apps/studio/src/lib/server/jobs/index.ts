import { ProjectStorage } from '@veyra/storage';
import {
  checkClaudeSubscribe,
  checkCodexChatgpt,
  createProvider,
  providerIds,
  type CodexOptions,
  type Provider,
  type ProviderId
} from '@veyra/ai';
import { ANTHROPIC_API_KEY, OPENAI_API_KEY, VEYRA_AI_PROVIDER } from '$app/env/private';
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
/** Explicit user activation of codex-chatgpt (D023), stored in app_settings; off by default. */
export const codexEnabled = () => repo.getSetting('codexChatgptEnabled') === '1';
/** Codex child settings: HOME and CODEX_HOME only, never the server's environment. */
function codexOptions(): CodexOptions | null {
  const { command, codexHome, timeoutMs } = settings.models.codexChatgpt;
  if (!codexEnabled() || !command) return null;
  return {
    command,
    env: { HOME: process.env.HOME, CODEX_HOME: codexHome ?? undefined },
    timeoutMs
  };
}
const priced = (model: string) => Boolean(settings.models.pricing[model]);
function build(id: ProviderId | null): Provider | null {
  providerError = null;
  if (!id) return null;
  try {
    const { models, maxTokens, callTimeoutMs, openai } = settings.models;
    // Keys come from $app/env/private only and go straight to the SDK clients.
    return createProvider(
      id,
      { ANTHROPIC_API_KEY, OPENAI_API_KEY },
      models[0],
      { maxTokens, timeoutMs: callTimeoutMs },
      { openaiModel: openai.model, priced, codex: codexOptions() }
    );
  } catch (error) {
    // Unavailable stays unavailable: no other provider is substituted.
    providerError = error instanceof Error ? error.message : String(error);
    return null;
  }
}
export const selectedProviderId = () => selectedProvider();
/** Presence only, from the same source as the provider; never the value. */
export const apiKeyConfigured = Boolean(ANTHROPIC_API_KEY);
export const openaiKeyConfigured = Boolean(OPENAI_API_KEY);

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

export const claudeSubscribeStatus = () =>
  checkClaudeSubscribe({ command: settings.models.claudeSubscribe.command });
export const codexStatus = () => {
  const { command, codexHome } = settings.models.codexChatgpt;
  return checkCodexChatgpt({
    enabled: codexEnabled(),
    command,
    env: { HOME: process.env.HOME, CODEX_HOME: codexHome ?? undefined }
  });
};
/** Whether each provider can run now, and why not (T139); local is never available. */
export async function providerAvailability() {
  const { models, openai } = settings.models;
  const claude = await claudeSubscribeStatus();
  const codex = await codexStatus();
  const anthropic = !ANTHROPIC_API_KEY
    ? 'ANTHROPIC_API_KEY non définie.'
    : !priced(models[0])
      ? `Modèle ${models[0]} sans tarif local : appels refusés.`
      : null;
  const openaiWhy = !OPENAI_API_KEY
    ? 'OPENAI_API_KEY non définie.'
    : !openai.model
      ? 'Aucun modèle OpenAI configuré (openai.model de config/models.json).'
      : !priced(openai.model)
        ? `Aucun tarif sourcé pour ${openai.model} : fournisseur indisponible faute de tarif.`
        : null;
  const row = (ok: boolean, reason: string) => ({ ok, reason });
  return {
    fake: row(true, 'Toujours disponible. Résultats simulés, étiquetés comme tels.'),
    'anthropic-api': row(
      !anthropic,
      anthropic ?? 'ANTHROPIC_API_KEY définie (valeur masquée) ; non vérifiée par un appel.'
    ),
    'claude-subscribe': row(claude.available, claude.reason),
    'openai-api': row(
      !openaiWhy,
      openaiWhy ?? 'OPENAI_API_KEY définie (valeur masquée) ; non vérifiée par un appel.'
    ),
    'codex-chatgpt': row(codex.available, codex.reason),
    local: row(false, 'Non implémenté (T142).')
  };
}
/** A provider that cannot run now is refused here, never stored as the choice. */
export async function chooseProvider(id: ProviderId) {
  if (providerLocked) throw new Error('Fournisseur imposé par VEYRA_AI_PROVIDER');
  const status = (await providerAvailability())[id];
  if (!status.ok) throw new Error(`${id} indisponible : ${status.reason}`);
  repo.setSetting('aiProvider', id);
  studio.setProvider(build(id));
}
/** Explicit activation by the user (D023); disabling also drops it if it was active. */
export function setCodexEnabled(enabled: boolean) {
  repo.setSetting('codexChatgptEnabled', enabled ? '1' : '0');
  if (selectedProvider() === 'codex-chatgpt') studio.setProvider(build('codex-chatgpt'));
}

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
