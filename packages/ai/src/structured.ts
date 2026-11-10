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
import { providerCapabilities } from "./capabilities";

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
  /** Declared capability (T145): without it, no image is ever sent to the model. */
  get images() {
    return providerCapabilities[this.kind].images;
  }
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
  async planRevision(
    storyboard: Storyboard,
    feedback: FeedbackInput[],
    audio: AudioComposition | null = null,
    call?: CallOptions,
  ) {
    const dropped = !this.images && feedback.some((item) => item.capturePath);
    if (dropped)
      feedback = feedback.map((item) => ({ ...item, capturePath: null }));
    const images = feedback.flatMap((item) =>
      item.capturePath
        ? [{ label: `Image annotée par ${item.id}`, path: item.capturePath }]
        : [],
    );
    const proposal = await this.ask(
      revisionProposalSchema,
      instructions.plan,
      JSON.stringify(planInput(storyboard, feedback, audio)),
      images,
      call,
    );
    return dropped
      ? {
          ...proposal,
          summary: `${proposal.summary} (Analyse en texte seul : captures non transmises, fournisseur sans images.)`,
        }
      : proposal;
  }
  async reviewFrames(
    storyboard: Storyboard,
    frames: Frame[],
    call?: CallOptions,
  ): Promise<ReviewFinding[]> {
    if (!this.images)
      return [
        {
          name: "Revue qualitative",
          passed: false,
          severity: "info",
          timestampMs: 0,
          sceneId: null,
          evidence: `Revue IA non effectuée : ${this.kind} n'analyse pas d'images (capacité non déclarée).`,
          recommendation: "Vérifier visuellement le rendu avant validation.",
          analysisMode: "not-performed",
        },
      ];
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
    const images = this.images;
    const ask = this.ask.bind(this);
    return {
      kind,
      async evaluate(input): Promise<QualityEvaluation> {
        // Text-only without the image capability: analysisMode then says so.
        const sentImages = images ? input.images : [];
        const review = await ask(
          expertReviewSchema,
          evaluationInstructions(input.language),
          JSON.stringify(
            publicEvaluationInput({ ...input, images: sentImages }),
          ),
          sentImages.map((image) => ({
            label: `Image ${image.file}`,
            path: image.path,
          })),
          call,
        );
        // What was sent is known for certain; the model's own list is not trusted here.
        const sent = sentImages.map((image) => image.file);
        return {
          review: { ...review, imagesExamined: sent },
          analysisMode: sent.length ? "multimodal" : "text-only",
        };
      },
    };
  }
}
