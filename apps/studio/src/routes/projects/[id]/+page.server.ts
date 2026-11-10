import { aiProviderIdSchema, audioCategorySchema } from '@veyra/schemas';
import { error, fail } from '@sveltejs/kit';
import {
  chooseProjectProvider,
  knownAvailability,
  providerAvailability,
  providerError,
  providerLocked,
  studio,
  settings
} from '#lib/server/jobs/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const snapshot = studio.snapshot(params.id);
  if (!snapshot) error(404, 'Projet introuvable');
  const provider = studio.providerFor(params.id);
  // The page polls: availability is probed once, then refreshed by /settings or a new choice.
  const availability = providerLocked
    ? null
    : (knownAvailability ?? (await providerAvailability()));
  return {
    ...snapshot,
    aiKind: provider.kind,
    // Project provider unavailable, or the global one when the project has none.
    providerError: provider.error ?? (provider.kind ? null : providerError),
    providerChoice: providerLocked
      ? null
      : aiProviderIdSchema.options.map((id) => ({ id, ...availability![id] })),
    estimate: studio.storyboardEstimate(params.id),
    maxBudgetUsd: settings.models.maxBudgetUsd
  };
};

const str = (data: FormData, key: string) => String(data.get(key) ?? '');
// Background work is started, not awaited: the page polls for progress.
const attempt = (work: () => unknown) => {
  try {
    const result = work();
    if (result instanceof Promise) void result;
    return { ok: true };
  } catch (cause) {
    return fail(400, { error: cause instanceof Error ? cause.message : 'Action impossible' });
  }
};

const parseEnd = (value: string) => {
  if (!value.trim()) return null;
  if (!/^(?:\d+:)?\d+(?:[.,]\d+)?$/.test(value.trim()))
    throw new Error('Fin de plage : secondes ou mm:ss attendus');
  const parts = value.replace(',', '.').split(':').map(Number);
  if (parts.length === 2 && parts[1] >= 60) throw new Error('Secondes limitées à 59 dans mm:ss');
  return Math.round((parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0]) * 1000);
};
// Decimal USD amount from a form field; validated again as micro-dollars by the repository.
const usd = (value: string) => {
  const amount = Number(value.replace(',', '.'));
  if (!value.trim() || !Number.isFinite(amount) || amount < 0)
    throw new Error('Enveloppe : montant en USD positif attendu');
  return amount;
};
const ownedRun = (projectId: string, runId: string) => {
  if (!studio.snapshot(projectId)?.runs.some((r) => r.id === runId))
    throw new Error('Production introuvable');
  return runId;
};
export const actions: Actions = {
  setProvider: async ({ params, request }) => {
    try {
      const value = str(await request.formData(), 'provider');
      await chooseProjectProvider(params.id, value ? aiProviderIdSchema.parse(value) : null);
      return { ok: true };
    } catch (cause) {
      return fail(400, { error: cause instanceof Error ? cause.message : 'Choix impossible' });
    }
  },
  stopProduction: async ({ params, request }) => {
    const data = await request.formData();
    return attempt(() => studio.stopProduction(ownedRun(params.id, str(data, 'runId'))));
  },
  resumeProduction: async ({ params, request }) => {
    const data = await request.formData();
    return attempt(() => studio.resumeProduction(ownedRun(params.id, str(data, 'runId'))));
  },
  raiseBudget: async ({ params, request }) => {
    const data = await request.formData();
    return attempt(() =>
      studio.raiseBudget(ownedRun(params.id, str(data, 'runId')), usd(str(data, 'budgetUsd')))
    );
  },
  importAudio: async ({ params, request }) => {
    try {
      const data = await request.formData();
      const file = data.get('file');
      if (!(file instanceof File) || !file.size) return fail(400, { error: 'Aucun fichier audio' });
      if (file.size > settings.audio.maxFileBytes)
        return fail(400, {
          error: `Fichier limité à ${Math.floor(settings.audio.maxFileBytes / 1048576)} Mio`
        });
      const category = audioCategorySchema.parse(str(data, 'category'));
      await studio.importAudio(params.id, file, new Uint8Array(await file.arrayBuffer()), category);
      return { ok: true };
    } catch (cause) {
      return fail(400, { error: cause instanceof Error ? cause.message : 'Import impossible' });
    }
  },
  reviseAudio: async ({ params, request }) => {
    const data = await request.formData();
    return attempt(() => {
      const id = str(data, 'revisionId');
      if (!studio.snapshot(params.id)?.revisions.some((r) => r.id === id))
        throw new Error('Révision introuvable');
      return studio.reviseAudio(id, JSON.parse(str(data, 'composition')));
    });
  },
  prompt: async ({ params, request }) => {
    const data = await request.formData();
    return attempt(() =>
      studio.sendPrompt(params.id, str(data, 'prompt'), usd(str(data, 'budgetUsd') || '0'))
    );
  },
  upload: async ({ params, request }) => {
    const file = (await request.formData()).get('file');
    if (!(file instanceof File) || file.size === 0) return fail(400, { error: 'Aucun fichier' });
    if (file.size > 50 * 1024 * 1024) return fail(400, { error: 'Fichier limité à 50 Mo' });
    const bytes = new Uint8Array(await file.arrayBuffer());
    return attempt(() => studio.addAsset(params.id, file, bytes));
  },
  // Saving a comment never calls the AI and never starts a render.
  comment: async ({ request }) => {
    const data = await request.formData();
    try {
      await studio.addAnnotation({
        revisionId: str(data, 'revisionId'),
        frameIndex: data.has('frameIndex') ? Number(str(data, 'frameIndex')) : null,
        timestampMs: data.has('timestampMs') ? Number(str(data, 'timestampMs')) : null,
        rangeEndMs: parseEnd(str(data, 'rangeEnd')),
        audioTrackId: str(data, 'audioTrackId') || null,
        text: str(data, 'text'),
        author: 'Utilisateur'
      });
      return { ok: true };
    } catch (cause) {
      return fail(400, { error: cause instanceof Error ? cause.message : 'Action impossible' });
    }
  },
  editComment: async ({ request }) => {
    const data = await request.formData();
    return attempt(() => studio.editAnnotation(str(data, 'id'), str(data, 'text')));
  },
  deleteComment: async ({ request }) => {
    const data = await request.formData();
    return attempt(() => studio.deleteAnnotation(str(data, 'id')));
  },
  submitBatch: async ({ request }) => {
    const data = await request.formData();
    return attempt(() =>
      studio.submitBatch({
        revisionId: str(data, 'revisionId'),
        feedbackIds: data.getAll('feedbackIds').map(String),
        submissionKey: str(data, 'submissionKey')
      })
    );
  },
  retryBatch: async ({ request }) => {
    const data = await request.formData();
    return attempt(() => studio.retryBatch(str(data, 'batchId')));
  },
  rejectPlan: async ({ request }) => {
    const data = await request.formData();
    return attempt(() => studio.rejectPlan(str(data, 'batchId')));
  },
  evaluate: async ({ request }) => {
    const data = await request.formData();
    return attempt(() => studio.requestEvaluation(str(data, 'revisionId')));
  },
  importTask: async ({ request }) => {
    const data = await request.formData();
    return attempt(() => studio.importTask(str(data, 'taskId')));
  },
  apply: async ({ request }) => {
    const data = await request.formData();
    return attempt(() => studio.applyPlan(str(data, 'planId')));
  },
  approve: async ({ request }) => {
    const data = await request.formData();
    return attempt(() => studio.approve(str(data, 'revisionId')));
  }
};
