import { z } from "zod";
import { idSchema } from "./ids";
import { anchorSchema } from "./timeline";

export const audioCategorySchema = z.enum([
  "music",
  "voiceover",
  "sfx",
  "ambience",
]);
const duckSchema = z
  .object({
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
    gainDb: z.number().min(-60).max(0),
  })
  .refine((d) => d.endMs >= d.startMs, "Invalid duck interval");
// Defaults belong to full tracks, never to patches (omitted fields stay omitted).
export const audioMixPatchSchema = z
  .object({
    gainDb: z.number().min(-60).max(12),
    fadeInMs: z.number().nonnegative(),
    fadeOutMs: z.number().nonnegative(),
    duck: z.array(duckSchema),
    anchor: anchorSchema,
  })
  .partial()
  .strict();
export const audioTrackSchema = z
  .object({
    id: idSchema("atr"),
    assetId: idSchema("ast"),
    category: audioCategorySchema,
    label: z.string(),
    anchor: anchorSchema,
    sourceInMs: z.number().nonnegative().default(0),
    durationMs: z.number().positive().optional(),
    gainDb: audioMixPatchSchema.shape.gainDb.unwrap().default(0),
    fadeInMs: audioMixPatchSchema.shape.fadeInMs.unwrap().default(0),
    fadeOutMs: audioMixPatchSchema.shape.fadeOutMs.unwrap().default(0),
    loop: z.boolean().default(false),
    duck: z.array(duckSchema).default([]),
  })
  .refine((t) => !t.loop || t.category === "music", "Only music can loop");
export const audioCompositionSchema = z.object({
  schemaVersion: z.literal(1),
  tracks: z.array(audioTrackSchema),
  master: z
    .object({
      targetLufs: z.number().min(-30).max(-5).default(-16),
      truePeakDb: z.number().default(-1),
    })
    .default({ targetLufs: -16, truePeakDb: -1 }),
});
export type AudioCategory = z.infer<typeof audioCategorySchema>;
export type AudioTrack = z.infer<typeof audioTrackSchema>;
export type AudioComposition = z.infer<typeof audioCompositionSchema>;
