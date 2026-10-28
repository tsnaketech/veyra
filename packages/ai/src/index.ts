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
} from "@veyra/schemas";
import { AssistedProvider } from "./assisted";
import {
  AnthropicQualityEvaluator,
  FakeQualityEvaluator,
  type QualityEvaluator,
} from "./evaluation";

// What a model may produce: plain structured data, never HTML or code.
export const sceneDraftSchema = z.object({
  text: z.string().min(1).max(140),
  durationMs: z.number().int().min(1000).max(15000),
  enter: z.enum(["fade", "slide-up", "scale"]),
  animationMs: z.number().int().min(100).max(1500),
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
});
export type RevisionProposal = z.infer<typeof revisionProposalSchema>;

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
      const row = {
        id: newId("scn"),
        start,
        duration: scene.durationMs,
        text: scene.text,
        animation: {
          enter: scene.enter,
          durationMs: scene.animationMs,
          easing: "power2.out",
        },
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
    if (patch.text !== undefined) scene.text = patch.text;
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
  return storyboardSchema.parse({ ...storyboard, scenes });
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));
const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

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
  ): Promise<RevisionProposal> {
    const changes = feedback.map((item) => {
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
      if (quoted && /texte|remplace|écri|text/.test(text)) {
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
  planRevision(storyboard: Storyboard, feedback: FeedbackInput[]) {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      { type: "text", text: JSON.stringify(planInput(storyboard, feedback)) },
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
    `Tu conçois des storyboards de motion design typographique pour Veyra. Une scène = un court texte animé (≤ 140 caractères). Durée totale visée : ${options.targetDurationMs} ms, sans dépasser 60000 ms. Consignes de marque :\n${options.styleInstructions}`,
  plan: "Tu proposes des corrections minimales à un storyboard Veyra à partir de commentaires posés sur des frames précises (frameIndex, timestampMs, image de la frame si fournie). Une entrée de changes par commentaire, avec son feedbackId. N'utilise que les champs de patch autorisés, sur des sceneId existants ; laisse patch vide si la demande n'est pas exprimable. Signale dans conflicts les commentaires contradictoires et ne les applique pas.",
};
/** What a planner receives for a batch: storyboard plus each comment's frame context. */
export function planInput(storyboard: Storyboard, feedback: FeedbackInput[]) {
  return {
    storyboard,
    feedback: feedback.map((item) => ({
      id: item.id,
      text: item.text,
      frameIndex: item.frameIndex ?? null,
      timestampMs: item.timestampMs,
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
