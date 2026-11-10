import { z } from "zod";
import { idSchema } from "./ids";
import { audioMixPatchSchema } from "./audio";
import { captionCueSchema } from "./captions";
import { sceneNarrationSchema, scenePatchSchema } from "./core";

// T128: typed edit operations (docs/ai/EDIT-OPERATIONS.md). Every variant targets precise
// ids and reuses the existing contracts; nothing here is free text applied as code.
const nonEmpty = (patch: object) => Object.keys(patch).length > 0;
const sceneId = idSchema("scn");
const patch = scenePatchSchema.shape;

export const editOperationSchema = z.discriminatedUnion("op", [
  // Scene content: text (or the component's primary field) and component params.
  z
    .object({
      op: z.literal("scene.update"),
      sceneId,
      patch: scenePatchSchema
        .pick({ text: true, params: true })
        .refine(nonEmpty, "Empty patch"),
    })
    .strict(),
  // Duration of the scene's entry animation.
  z
    .object({
      op: z.literal("scene.animation"),
      sceneId,
      animationMs: patch.animationMs.unwrap(),
    })
    .strict(),
  // Entry transition of the scene (the only transition the compositor has).
  z
    .object({
      op: z.literal("scene.transition"),
      sceneId,
      enter: patch.enter.unwrap(),
    })
    .strict(),
  // Later scenes move: applyProposal recomputes every start.
  z
    .object({
      op: z.literal("scene.duration"),
      sceneId,
      durationMs: patch.durationMs.unwrap(),
    })
    .strict(),
  // Every track of the revision playing `assetId` plays `withAssetId` instead.
  z
    .object({
      op: z.literal("media.replace"),
      assetId: idSchema("ast"),
      withAssetId: idSchema("ast"),
    })
    .strict()
    .refine((o) => o.assetId !== o.withAssetId, "Same asset"),
  z
    .object({
      op: z.literal("audio.track"),
      trackId: idSchema("atr"),
      patch: audioMixPatchSchema.refine(nonEmpty, "Empty patch"),
    })
    .strict(),
  // Narration text of a scene (null removes it); the voice file is swapped with media.replace.
  z
    .object({
      op: z.literal("voice.narration"),
      sceneId,
      text: sceneNarrationSchema.shape.text.nullable(),
    })
    .strict(),
  // Displayed lines of one cue: burned picture and/or SRT/VTT depending on the delivery.
  z
    .object({
      op: z.literal("captions.cue"),
      cueId: idSchema("cue"),
      lines: captionCueSchema.shape.lines,
    })
    .strict(),
  // Same values as captionDeliverySchema (Studio render runner).
  z
    .object({
      op: z.literal("captions.delivery"),
      mode: z.enum(["burned", "clean", "both"]),
    })
    .strict(),
]);
export type EditOperation = z.infer<typeof editOperationSchema>;

/** Artefacts of a rendered revision (render runner); `picture` holds burned captions if any. */
export const editArtefactSchema = z.enum([
  "picture",
  "picture-clean",
  "mix",
  "captions-sidecars",
  "video",
  "qa-report",
]);
export const invalidationPlanSchema = z
  .object({
    scenes: z.array(
      z
        .object({
          sceneId,
          // content: drawn differently; timing: moved; captions: only its burned cues changed.
          change: z.enum(["content", "timing", "captions", "unchanged"]),
        })
        .strict(),
    ),
    artefacts: z.array(
      z
        .object({
          artefact: editArtefactSchema,
          status: z.enum(["reused", "invalidated"]),
          // operation: changed by the edits; no-reuse-mechanism: rebuilt at every render;
          // parent-lacks-variant: the parent never produced this picture.
          cause: z
            .enum(["operation", "no-reuse-mechanism", "parent-lacks-variant"])
            .nullable(),
          reusedFrom: idSchema("rev").nullable(),
          // Scene, track or cue ids concerned.
          targets: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();
export type InvalidationPlan = z.infer<typeof invalidationPlanSchema>;
