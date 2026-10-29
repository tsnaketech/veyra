import { z } from "zod";
import {
  audioCategorySchema,
  audioTrackSchema,
  idSchema,
} from "@veyra/schemas";
export {
  audioTrackSchema,
  audioCompositionSchema,
  anchorSchema,
  type Anchor,
  type AnchorResolution,
  type AudioTrack,
  type AudioComposition,
} from "@veyra/schemas";

export const audioFormatSchema = z.enum([
  "wav",
  "mp3",
  "flac",
  "ogg",
  "mov",
  "mp4",
  "m4a",
  "3gp",
  "3g2",
  "mj2",
  "aiff",
]);
export const audioLimitsSchema = z.object({
  allowedFormats: z
    .array(audioFormatSchema)
    .min(1)
    .default(["wav", "mp3", "flac", "ogg", "mov", "mp4", "m4a", "aiff"]),
  maxFileBytes: z.number().int().positive().default(104857600),
  maxDurationMs: z.number().positive().default(600000),
  cpuSeconds: z.number().int().positive().max(600).default(60),
  timeoutMs: z.number().int().positive().max(600000).default(120000),
  maxOutputBytes: z.number().int().positive().default(268435456),
  maxLogBytes: z.number().int().positive().default(2097152),
});
export type AudioLimits = z.input<typeof audioLimitsSchema>;
export const audioMetadataSchema = z.object({
  format: z.string().min(1),
  codec: z.string().min(1),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  durationMs: z.number().positive(),
  bitRate: z.number().positive().optional(),
  sizeBytes: z.number().int().nonnegative(),
});
export type AudioMetadata = z.infer<typeof audioMetadataSchema>;
export const resolvedTrackSchema = z
  .object({
    trackId: idSchema("atr"),
    category: audioCategorySchema,
    assetPath: z.string().min(1),
    startMs: z.number().nonnegative(),
    sourceInMs: z.number().nonnegative(),
    playMs: z.number().positive(),
    gainDb: audioTrackSchema.shape.gainDb,
    fadeInMs: audioTrackSchema.shape.fadeInMs,
    fadeOutMs: audioTrackSchema.shape.fadeOutMs,
    loop: audioTrackSchema.shape.loop,
    // Duck intervals are absolute composition times, not source times.
    duck: audioTrackSchema.shape.duck,
  })
  .refine(
    (t) => !t.loop || t.category === "music",
    "Seule la musique peut boucler",
  );
export type ResolvedTrack = z.infer<typeof resolvedTrackSchema>;
export interface SyncIssue {
  trackId: string;
  code:
    | "event-missing"
    | "before-zero"
    | "after-end"
    | "asset-missing"
    | "source-exhausted";
  message: string;
}
export const mixSettingsSchema = z.object({
  sampleRate: z.literal(48000).default(48000),
  channels: z.literal(2).default(2),
  codec: z.literal("aac").default("aac"),
  bitrateKbps: z.number().int().min(8).max(512).default(192),
  // alimiter accepts an amplitude limit between 1/16 and 1.
  truePeakDb: z.number().min(-24).max(0).default(-1),
  cpuSeconds: audioLimitsSchema.shape.cpuSeconds,
  timeoutMs: audioLimitsSchema.shape.timeoutMs,
  maxOutputBytes: audioLimitsSchema.shape.maxOutputBytes,
  maxLogBytes: audioLimitsSchema.shape.maxLogBytes,
});
export type MixSettings = z.input<typeof mixSettingsSchema>;
