import { fail } from '@sveltejs/kit';
import { providerIds, type ProviderId } from '@veyra/ai';
import {
  chooseProvider,
  claudeSubscribeStatus,
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
    apiKeyConfigured: Boolean(process.env[settings.models.apiKeyEnv]),
    // Local read-only check through Claude Code itself; no identity is returned.
    claude: await claudeSubscribeStatus()
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
      chooseProvider(id as ProviderId);
    } catch (cause) {
      return fail(400, { error: cause instanceof Error ? cause.message : 'Choix impossible' });
    }
    return { ok: true };
  },
  // Re-runs the load, which re-checks availability.
  check: async () => ({ ok: true })
};
