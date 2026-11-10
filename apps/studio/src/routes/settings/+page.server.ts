import { fail } from '@sveltejs/kit';
import { providerCapabilities, providerIds, type ProviderId } from '@veyra/ai';
import {
  apiKeyConfigured,
  chooseProvider,
  claudeSubscribeStatus,
  codexEnabled,
  openaiKeyConfigured,
  providerAvailability,
  setCodexEnabled,
  providerError,
  providerLocked,
  selectedProviderId,
  settings,
  studio
} from '#lib/server/jobs/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({
  engine: { kind: 'HyperFrames (CLI, bac à sable bwrap)', ...settings.engine },
  ai: {
    active: studio.aiKind,
    selected: selectedProviderId(),
    locked: providerLocked,
    error: providerError,
    models: settings.models.models,
    // Only presence is exposed, never the value.
    apiKeyEnv: settings.models.apiKeyEnv,
    apiKeyConfigured,
    // Local price list used for the spend envelope (D022).
    pricing: settings.models.pricing,
    // Local read-only check through Claude Code itself; no identity is returned.
    claude: await claudeSubscribeStatus(),
    openaiKeyConfigured,
    openaiModel: settings.models.openai.model,
    codex: {
      enabled: codexEnabled(),
      command: settings.models.codexChatgpt.command
    },
    // Declared capabilities (static) and whether each provider can run now (T139).
    capabilities: providerCapabilities,
    availability: await providerAvailability()
  },
  formats: settings.formats.formats,
  maxDurationSeconds: settings.app.maxDurationSeconds,
  storageRoot: settings.storageRoot,
  snapshot: settings.snapshot
});

export const actions: Actions = {
  provider: async ({ request }) => {
    const id = String((await request.formData()).get('provider') ?? '');
    if (!(providerIds as readonly string[]).includes(id))
      return fail(400, { error: 'Fournisseur inconnu' });
    try {
      await chooseProvider(id as ProviderId);
    } catch (cause) {
      return fail(400, { error: cause instanceof Error ? cause.message : 'Choix impossible' });
    }
    return { ok: true };
  },
  // Explicit activation of codex-chatgpt by the user (D023); nothing runs before it.
  codex: async ({ request }) => {
    setCodexEnabled((await request.formData()).get('enabled') === '1');
    return { ok: true };
  },
  // Re-runs the load, which re-checks availability.
  check: async () => ({ ok: true })
};
