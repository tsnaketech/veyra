import { readFileSync } from "node:fs";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  newId,
  sceneAt,
  scenePatchSchema,
  storyboardSchema,
  type AnalysisMode,
  type ScenePatch,
  type Storyboard,
  audioMixPatchSchema,
  type AudioComposition,
} from "@veyra/schemas";
import { AssistedProvider } from "./assisted";
import {
  checkTiming,
  componentCatalog,
  componentDraftSchema,
  componentLabel,
  getComponent,
  normalizeComponent,
} from "@veyra/motion";
import {
  AnthropicQualityEvaluator,
  FakeQualityEvaluator,
  type QualityEvaluator,
} from "./evaluation";

// What a model may produce: plain structured data, never HTML or code.
export const sceneDraftSchema = z
  .object({
    // Plain text scene, or a registered motion component (its label becomes the text).
    text: z.string().min(1).max(140).optional(),
    durationMs: z.number().int().min(1000).max(15000),
    enter: z.enum(["fade", "slide-up", "scale"]),
    animationMs: z.number().int().min(100).max(1500),
    component: componentDraftSchema.optional(),
  })
  .refine((scene) => scene.text || scene.component, {
    message: "Une scène a un texte ou un composant",
  });
export const storyboardDraftSchema = z.object({
  title: z.string().min(1).max(80),
  scenes: z.array(sceneDraftSchema).min(1).max(12),
});
export type StoryboardDraft = z.infer<typeof storyboardDraftSchema>;

export const revisionProposalSchema = z.object({
  summary: z.string().min(1),
  changes: z.array(
    z.object({
      feedbackId: z.string().nullable(),
      sceneId: z.string().nullable(),
      instruction: z.string().min(1),
      patch: scenePatchSchema,
    }),
  ),
  // Contradictory requests are reported for a human to arbitrate, never silently merged.
  conflicts: z.array(
    z.object({
      feedbackIds: z.array(z.string()).min(2),
      description: z.string().min(1),
    }),
  ),
  // Soundtrack edits: mix fields of an existing track only (ids filtered by the caller).
  audioChanges: z
    .array(
      z.object({
        trackId: z.string(),
        patch: audioMixPatchSchema,
        feedbackId: z.string().nullable(),
        instruction: z.string().min(1),
      }),
    )
    .default([]),
});
export type RevisionProposal = z.infer<typeof revisionProposalSchema>;
export type RevisionProposalInput = z.input<typeof revisionProposalSchema>;

export const reviewFindingSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  severity: z.enum(["info", "minor", "major", "critical"]),
  timestampMs: z.number().int().nonnegative(),
  sceneId: z.string().nullable(),
  evidence: z.string().min(1),
  recommendation: z.string().min(1),
});
export const reviewSchema = z.object({
  findings: z.array(reviewFindingSchema),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema> & {
  analysisMode: AnalysisMode;
};

export interface FeedbackInput {
  id: string;
  text: string;
  timestampMs: number;
  sceneId: string | null;
  frameIndex?: number | null;
  /** PNG of the exact annotated frame, when it could be extracted. */
  capturePath?: string | null;
  /** End of a commented time range, and the audio track it targets, if any. */
  rangeEndMs?: number | null;
  audioTrackId?: string | null;
}
export interface Frame {
  timestampMs: number;
  path: string;
}
export const providerIds = [
  "fake",
  "anthropic-api",
  "claude-subscribe",
] as const;
export type ProviderId = (typeof providerIds)[number];
/** Providers Veyra calls itself. "fake" must be surfaced to users as simulated output. */
export interface AiProvider {
  readonly kind: "fake" | "anthropic-api";
  readonly mode: "direct";
  generateStoryboard(
    prompt: string,
    options: { targetDurationMs: number; styleInstructions: string },
  ): Promise<StoryboardDraft>;
  planRevision(
    storyboard: Storyboard,
    feedback: FeedbackInput[],
    audio?: AudioComposition | null,
  ): Promise<RevisionProposal>;
  reviewFrames(
    storyboard: Storyboard,
    frames: Frame[],
  ): Promise<ReviewFinding[]>;
  /** Expert QA of corrections, with this provider's real capabilities. */
  qualityEvaluator(): QualityEvaluator;
}

export function toStoryboard(
  draft: StoryboardDraft,
  format: { width: number; height: number; fps: number },
): Storyboard {
  const parsed = storyboardDraftSchema.parse(draft);
  let start = 0;
  return storyboardSchema.parse({
    ...format,
    scenes: parsed.scenes.map((scene) => {
      const component = scene.component
        ? normalizeComponent(scene.component as { id: string; params: unknown })
        : undefined;
      if (component) checkTiming(component.id, scene.durationMs);
      const row = {
        id: newId("scn"),
        start,
        duration: scene.durationMs,
        text: component ? componentLabel(component) : scene.text!,
        animation: {
          enter: scene.enter,
          durationMs: scene.animationMs,
          easing: "power2.out",
        },
        ...(component ? { component } : {}),
      };
      start += scene.durationMs;
      return row;
    }),
  });
}

/** Applies structured patches to a copy; scene ids are kept so feedback stays traceable. */
export function applyProposal(
  storyboard: Storyboard,
  changes: { sceneId: string | null; patch: ScenePatch }[],
  maxDurationMs: number,
): Storyboard {
  const scenes = structuredClone(storyboard.scenes);
  for (const change of changes) {
    const patch = scenePatchSchema.parse(change.patch);
    if (!Object.keys(patch).length) continue;
    const scene = scenes.find((item) => item.id === change.sceneId);
    if (!scene) throw new Error(`Unknown scene in plan: ${change.sceneId}`);
    if (patch.params !== undefined && !scene.component)
      throw new Error(`La scène ${scene.id} n'a pas de composant à paramétrer`);
    if (scene.component && (patch.text !== undefined || patch.params)) {
      // A text replacement targets the component's primary field; the result is revalidated.
      const params = {
        ...scene.component.params,
        ...(patch.params ?? {}),
        ...(patch.text !== undefined
          ? { [getComponent(scene.component.id).primaryField]: patch.text }
          : {}),
      };
      scene.component = normalizeComponent({ ...scene.component, params });
      scene.text = componentLabel(scene.component);
    } else if (patch.text !== undefined) scene.text = patch.text;
    if (patch.durationMs !== undefined) scene.duration = patch.durationMs;
    if (patch.enter !== undefined)
      scene.animation = { ...scene.animation, enter: patch.enter };
    if (patch.animationMs !== undefined)
      scene.animation = { ...scene.animation, durationMs: patch.animationMs };
  }
  let start = 0;
  for (const scene of scenes) {
    scene.start = start;
    start += scene.duration;
  }
  if (start > maxDurationMs)
    throw new Error(`Revised video exceeds ${maxDurationMs / 1000} s`);
  for (const scene of scenes)
    if (scene.component) checkTiming(scene.component.id, scene.duration);
  return storyboardSchema.parse({ ...storyboard, scenes });
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));
const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Simulated product video: one scene per registered component, durations scaled
 * from 4/5/4/4/3 and checked against each component's limits. The example metrics
 * and features are placeholders the user must replace.
 */
function clipWords(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1).replace(/\s+\S*$/, "");
  return cut || text.slice(0, max);
}
function composeWithComponents(subject: string, prompt: string, total: number) {
  const order = [
    ["animated-title", 4],
    ["feature-cards", 5],
    ["product-mockup", 4],
    ["metrics-counter", 4],
    ["call-to-action", 3],
  ] as const;
  const name = /«\s*([^»]{1,24}?)\s*»|"([^"]{1,24})"/.exec(prompt);
  const appName = (name?.[1] ?? name?.[2] ?? "Votre application").trim();
  let used = 0;
  const durations = order.map(([, weight], i) => {
    const ms =
      i === order.length - 1
        ? total - used
        : Math.floor((total * weight) / 20 / 100) * 100;
    used += ms;
    return ms;
  });
  const fits = order.every(([id], i) => {
    const { minMs, maxMs } = getComponent(id).timing;
    return durations[i] >= minMs && durations[i] <= maxMs;
  });
  if (!fits) return null;
  // The app name goes in the kicker; the title keeps whole words only.
  const title = clipWords(
    capitalize(
      subject.replace(/«[^»]*»\s*,?\s*|"[^"]*"\s*,?\s*/g, "").trim() || subject,
    ),
    60,
  );
  const example = (id: string) =>
    structuredClone(getComponent(id).example) as Record<string, unknown>;
  const params: Record<string, Record<string, unknown>> = {
    "animated-title": {
      ...example("animated-title"),
      kicker: appName.slice(0, 40),
      title,
    },
    "feature-cards": example("feature-cards"),
    "product-mockup": {
      ...example("product-mockup"),
      appName: appName.slice(0, 24),
    },
    "metrics-counter": example("metrics-counter"),
    "call-to-action": { ...example("call-to-action"), detail: undefined },
  };
  return storyboardDraftSchema.parse({
    title: capitalize(subject).slice(0, 80),
    scenes: order.map(([id], i) => ({
      durationMs: durations[i],
      enter: "fade",
      animationMs: 800,
      component: { id, params: params[id] },
    })),
  });
}

/**
 * Deterministic rule-based stand-in used when no model is configured.
 * Everything it returns is simulated and labelled as such by callers.
 */
export class FakeAiProvider implements AiProvider {
  readonly kind = "fake" as const;
  readonly mode = "direct" as const;
  qualityEvaluator() {
    return new FakeQualityEvaluator();
  }
  async generateStoryboard(
    prompt: string,
    options: { targetDurationMs: number; styleInstructions: string },
  ): Promise<StoryboardDraft> {
    const seconds = /(\d{1,2})\s*(?:s\b|sec|secondes?|seconds?)/i.exec(prompt);
    const total = clamp(
      seconds ? Number(seconds[1]) * 1000 : options.targetDurationMs,
      3000,
      60000,
    );
    const subject =
      /(?:présentant|presentant|sur|about|for)\s+(.+?)[.!?]*$/i
        .exec(prompt.trim())?.[1]
        ?.replace(/^(un|une|le|la|les|a|an|the)\s+/i, "") ?? prompt.trim();
    const parts = subject
      .split(/\s+(?:et|and)\s+|,\s*/)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (/\b(saas|application|appli|app|logiciel|plateforme)\b/i.test(prompt)) {
      const composed = composeWithComponents(subject, prompt, total);
      if (composed) return composed;
    }
    // One scene per listed offer, framed by the full subject and a closing call to action.
    const texts = [
      capitalize(subject),
      ...(parts.length > 1 ? parts.map(capitalize) : []),
      "Contactez-nous",
    ]
      .map((text) => text.slice(0, 140))
      .slice(0, Math.max(1, Math.floor(total / 1000)));
    const each = Math.floor(total / texts.length / 100) * 100;
    const enters = ["fade", "slide-up", "scale"] as const;
    return storyboardDraftSchema.parse({
      title: capitalize(subject).slice(0, 80),
      scenes: texts.map((text, index) => ({
        text,
        durationMs: index === texts.length - 1 ? total - each * index : each,
        enter: enters[index % enters.length],
        animationMs: 500,
      })),
    });
  }
  async planRevision(
    storyboard: Storyboard,
    feedback: FeedbackInput[],
    audio: AudioComposition | null = null,
  ): Promise<RevisionProposal> {
    const audioChanges = feedback
      .filter((item) => isAudioFeedback(item))
      .map((item) => simulateAudioChange(item, audio));
    const changes = feedback
      .filter((item) => !isAudioFeedback(item))
      .map((item) => {
        const scene =
          storyboard.scenes.find((row) => row.id === item.sceneId) ??
          sceneAt(storyboard, item.timestampMs);
        const current = Number(scene?.animation.durationMs ?? 500);
        const text = item.text.toLowerCase();
        const quoted = /«\s*([^»]+?)\s*»|"([^"]+)"/.exec(item.text);
        const patch: ScenePatch = {};
        const notes: string[] = [];
        if (/ralenti|plus lent|lentement|slow/.test(text)) {
          patch.animationMs = clamp(current * 1.6, 100, 1500);
          notes.push(
            `ralentir l'animation (${current} → ${patch.animationMs} ms)`,
          );
        } else if (/accél|plus rapide|plus vite|faster/.test(text)) {
          patch.animationMs = clamp(current * 0.6, 100, 1500);
          notes.push(
            `accélérer l'animation (${current} → ${patch.animationMs} ms)`,
          );
        }
        if (
          quoted &&
          /bouton|button/.test(text) &&
          scene?.component?.id === "call-to-action"
        ) {
          patch.params = { buttonLabel: (quoted[1] ?? quoted[2]).slice(0, 28) };
          notes.push(`libellé du bouton : « ${patch.params.buttonLabel} »`);
        } else if (quoted && /texte|titre|remplace|écri|text/.test(text)) {
          patch.text = (quoted[1] ?? quoted[2]).slice(0, 140);
          notes.push(`remplacer le texte par « ${patch.text} »`);
        }
        return {
          feedbackId: item.id,
          sceneId: scene?.id ?? null,
          instruction: notes.length
            ? capitalize(notes.join(" ; "))
            : `Non interprété par le simulateur : « ${item.text} »`,
          patch: scene ? patch : {},
        };
      });
    // Two comments setting the same field of the same scene differently: keep neither.
    const conflicts: RevisionProposal["conflicts"] = [];
    for (const [i, a] of changes.entries())
      for (const b of changes.slice(i + 1)) {
        if (!a.sceneId || a.sceneId !== b.sceneId) continue;
        const fields = (Object.keys(a.patch) as (keyof ScenePatch)[]).filter(
          (key) => key in b.patch && a.patch[key] !== b.patch[key],
        );
        if (!fields.length) continue;
        for (const key of fields) {
          delete a.patch[key];
          delete b.patch[key];
        }
        conflicts.push({
          feedbackIds: [a.feedbackId, b.feedbackId],
          description: `Demandes contradictoires sur la même scène (${fields.join(", ")}) : à arbitrer, non appliquées.`,
        });
      }
    return revisionProposalSchema.parse({
      summary: `Plan simulé (règles déterministes, aucun modèle) pour ${feedback.length} commentaire(s).`,
      changes,
      conflicts,
      audioChanges: audioChanges.filter((c) => c !== null),
    });
  }
  async reviewFrames(
    storyboard: Storyboard,
    frames: Frame[],
  ): Promise<ReviewFinding[]> {
    return [
      {
        name: "Revue qualitative",
        passed: true,
        severity: "info",
        timestampMs: 0,
        sceneId: null,
        evidence: `Simulé : ${frames.length} image(s) extraite(s), aucune analysée par un modèle.`,
        recommendation:
          "Configurer un modèle multimodal pour une revue qualitative réelle.",
        analysisMode: "simulated",
      },
    ];
  }
}

/** Real provider. Unverified: no ANTHROPIC_API_KEY was available when it was written. */
export class AnthropicProvider implements AiProvider {
  readonly kind = "anthropic-api" as const;
  readonly mode = "direct" as const;
  qualityEvaluator() {
    return new AnthropicQualityEvaluator((schema, system, content) =>
      this.parse(schema, system, content),
    );
  }
  constructor(
    private readonly model: string,
    private readonly client = new Anthropic(),
  ) {}
  private async parse<T extends z.ZodType>(
    schema: T,
    system: string,
    content: Anthropic.Beta.BetaContentBlockParam[],
  ): Promise<z.infer<T>> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: zodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content }],
    });
    if (response.stop_reason === "refusal")
      throw new Error("Le modèle a refusé la demande");
    // Revalidate: the output format cannot express every bound in the schema.
    return schema.parse(response.parsed_output);
  }
  generateStoryboard(
    prompt: string,
    options: { targetDurationMs: number; styleInstructions: string },
  ) {
    return this.parse(storyboardDraftSchema, instructions.storyboard(options), [
      { type: "text", text: prompt },
    ]);
  }
  planRevision(
    storyboard: Storyboard,
    feedback: FeedbackInput[],
    audio: AudioComposition | null = null,
  ) {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      {
        type: "text",
        text: JSON.stringify(planInput(storyboard, feedback, audio)),
      },
    ];
    // Each annotated frame is sent as an image, labelled with its comment.
    for (const item of feedback)
      if (item.capturePath)
        content.push(
          { type: "text", text: `Image annotée par ${item.id}` },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: readFileSync(item.capturePath).toString("base64"),
            },
          },
        );
    return this.parse(revisionProposalSchema, instructions.plan, content);
  }
  async reviewFrames(
    storyboard: Storyboard,
    frames: Frame[],
  ): Promise<ReviewFinding[]> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const frame of frames)
      content.push(
        { type: "text", text: `Image à ${frame.timestampMs} ms` },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: readFileSync(frame.path).toString("base64"),
          },
        },
      );
    content.push({ type: "text", text: JSON.stringify({ storyboard }) });
    const { findings } = await this.parse(
      reviewSchema,
      "Tu es le contrôle qualité vidéo de Veyra. Évalue lisibilité, cohérence graphique, respect du storyboard et des contraintes de marque à partir des images fournies uniquement. Cite le timestamp de l'image comme preuve.",
      content,
    );
    // Only frames actually sent make the analysis multimodal.
    const mode: AnalysisMode = frames.length ? "multimodal" : "text-only";
    return findings.map((finding) => ({ ...finding, analysisMode: mode }));
  }
}

export const instructions = {
  storyboard: (options: {
    targetDurationMs: number;
    styleInstructions: string;
  }) =>
    `Tu conçois des storyboards de motion design pour Veyra. Chaque scène est soit un court texte animé (text ≤ 140 caractères), soit un composant du registre ci-dessous (component : id, params, style), dont tu respectes la durée et les paramètres ; aucun autre composant, aucun code, aucun HTML. Durée totale visée : ${options.targetDurationMs} ms, sans dépasser 60000 ms.\nComposants disponibles :\n${componentCatalog()}\nConsignes de marque :\n${options.styleInstructions}`,
  plan: "Tu proposes des corrections minimales à un storyboard Veyra à partir de commentaires posés sur des frames précises (frameIndex, timestampMs, image de la frame si fournie). Une entrée de changes par commentaire, avec son feedbackId. N'utilise que les champs de patch autorisés, sur des sceneId existants ; pour une scène à composant, text remplace son texte principal et params modifie ses paramètres (mêmes schémas que le registre, sans changer de composant) ; laisse patch vide si la demande n'est pas exprimable. Signale dans conflicts les commentaires contradictoires et ne les applique pas. Un commentaire sur le son (plage rangeEndMs, audioTrackId, musique, voix, effet) va dans audioChanges : trackId d'une piste existante de audio, patch limité à gainDb, fadeInMs, fadeOutMs, duck (liste complète des atténuations), anchor ; pas d'entrée changes pour lui.",
};
/** What a planner receives for a batch: storyboard plus each comment's frame context. */
export function planInput(
  storyboard: Storyboard,
  feedback: FeedbackInput[],
  audio: AudioComposition | null = null,
) {
  return {
    storyboard,
    audio,
    feedback: feedback.map((item) => ({
      id: item.id,
      text: item.text,
      frameIndex: item.frameIndex ?? null,
      timestampMs: item.timestampMs,
      rangeEndMs: item.rangeEndMs ?? null,
      audioTrackId: item.audioTrackId ?? null,
      sceneId:
        item.sceneId ?? sceneAt(storyboard, item.timestampMs)?.id ?? null,
      hasImage: Boolean(item.capturePath),
    })),
  };
}

export class ProviderUnavailableError extends Error {
  name = "ProviderUnavailableError";
}
export type Provider = AiProvider | AssistedProvider;
/**
 * Builds exactly the provider that was selected. An unavailable provider is an
 * error: there is never a fallback to another provider (in particular not to the paid API).
 */
export function createProvider(
  id: ProviderId,
  env: Record<string, string | undefined>,
  model: string,
): Provider {
  if (id === "fake") return new FakeAiProvider();
  if (id === "claude-subscribe") return new AssistedProvider();
  if (!env.ANTHROPIC_API_KEY)
    throw new ProviderUnavailableError(
      "anthropic-api indisponible : ANTHROPIC_API_KEY n'est pas définie.",
    );
  return new AnthropicProvider(model);
}
export * from "./assisted";
export * from "./evaluation";
export * from "./agents";
import { isAudioFeedback, simulateAudioChange } from "./agents";
