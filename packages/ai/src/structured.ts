import type { z } from "zod";
import type {
  AnalysisMode,
  AudioComposition,
  Storyboard,
} from "@veyra/schemas";
import {
  instructions,
  planInput,
  revisionProposalSchema,
  reviewSchema,
  storyboardDraftSchema,
  type CallOptions,
  type FeedbackInput,
  type Frame,
  type ReviewFinding,
} from "./index";
import {
  evaluationInstructions,
  expertReviewSchema,
  publicEvaluationInput,
  type QualityEvaluation,
  type QualityEvaluator,
} from "./evaluation";

/** A PNG sent to the model, introduced by a text label. */
export type AskImage = { label: string; path: string };

/**
 * Shared shape of providers that answer one Zod schema from text plus PNG files
 * (openai-api, codex-chatgpt). Only call-time bindings of ./index are used here:
 * index.ts imports the subclasses, so nothing from it may run at load time.
 */
export abstract class StructuredProvider {
  abstract readonly kind: "openai-api" | "codex-chatgpt";
  readonly mode = "direct" as const;
  abstract ask<T extends z.ZodType>(
    schema: T,
    system: string,
    text: string,
    images: AskImage[],
    call?: CallOptions,
  ): Promise<z.infer<T>>;

  generateStoryboard(
    prompt: string,
    options: { targetDurationMs: number; styleInstructions: string },
    call?: CallOptions,
  ) {
    return this.ask(
      storyboardDraftSchema,
      instructions.storyboard(options),
      prompt,
      [],
      call,
    );
  }
  planRevision(
    storyboard: Storyboard,
    feedback: FeedbackInput[],
    audio: AudioComposition | null = null,
    call?: CallOptions,
  ) {
    const images = feedback.flatMap((item) =>
      item.capturePath
        ? [{ label: `Image annotée par ${item.id}`, path: item.capturePath }]
        : [],
    );
    return this.ask(
      revisionProposalSchema,
      instructions.plan,
      JSON.stringify(planInput(storyboard, feedback, audio)),
      images,
      call,
    );
  }
  async reviewFrames(
    storyboard: Storyboard,
    frames: Frame[],
    call?: CallOptions,
  ): Promise<ReviewFinding[]> {
    const { findings } = await this.ask(
      reviewSchema,
      "Tu es le contrôle qualité vidéo de Veyra. Évalue lisibilité, cohérence graphique, respect du storyboard et des contraintes de marque à partir des images fournies uniquement. Cite le timestamp de l'image comme preuve.",
      JSON.stringify({ storyboard }),
      frames.map((frame) => ({
        label: `Image à ${frame.timestampMs} ms`,
        path: frame.path,
      })),
      call,
    );
    const mode: AnalysisMode = frames.length ? "multimodal" : "text-only";
    return findings.map((finding) => ({ ...finding, analysisMode: mode }));
  }
  qualityEvaluator(call?: CallOptions): QualityEvaluator {
    const kind = this.kind;
    const ask = this.ask.bind(this);
    return {
      kind,
      async evaluate(input): Promise<QualityEvaluation> {
        const review = await ask(
          expertReviewSchema,
          evaluationInstructions(input.language),
          JSON.stringify(publicEvaluationInput(input)),
          input.images.map((image) => ({
            label: `Image ${image.file}`,
            path: image.path,
          })),
          call,
        );
        // What was sent is known for certain; the model's own list is not trusted here.
        const sent = input.images.map((image) => image.file);
        return {
          review: { ...review, imagesExamined: sent },
          analysisMode: sent.length ? "multimodal" : "text-only",
        };
      },
    };
  }
}
