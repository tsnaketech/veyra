import { z } from "zod";
import {
  audioCompositionSchema,
  resolveAnchor,
  timelineEventSchema,
  type TimelineEvent,
} from "@veyra/schemas";
import {
  audioMetadataSchema,
  resolvedTrackSchema,
  type AudioMetadata,
  type ResolvedTrack,
  type SyncIssue,
} from "./schemas";

export function resolveAudioComposition(
  composition: z.input<typeof audioCompositionSchema>,
  events: readonly TimelineEvent[],
  assets: ReadonlyMap<string, { path: string; metadata: AudioMetadata }>,
  videoDurationMs: number,
): { tracks: ResolvedTrack[]; issues: SyncIssue[] } {
  const duration = z.number().positive().parse(videoDurationMs);
  const parsed = audioCompositionSchema.parse(composition);
  const timeline = z.array(timelineEventSchema).parse(events);
  // resolveAnchor requires a composition boundary, including for an empty visual timeline.
  const boundary: TimelineEvent = {
    id: "audio-composition-boundary",
    kind: "scene",
    sceneId: null,
    name: "composition-boundary",
    index: 0,
    startMs: 0,
    endMs: duration,
    startFrame: 0,
    endFrame: 0,
    source: "audio",
  };
  const tracks: ResolvedTrack[] = [],
    issues: SyncIssue[] = [];
  for (const track of parsed.tracks) {
    const anchor = resolveAnchor(track.anchor, [...timeline, boundary]);
    if ("error" in anchor) {
      issues.push({ trackId: track.id, ...anchor.error });
      continue;
    }
    const startMs = anchor.atMs;
    if (startMs >= duration) {
      issues.push({
        trackId: track.id,
        code: "after-end",
        message: "La piste commence à la fin ou après la vidéo",
      });
      continue;
    }
    const asset = assets.get(track.assetId);
    if (!asset) {
      issues.push({
        trackId: track.id,
        code: "asset-missing",
        message: `Asset audio absent : ${track.assetId}`,
      });
      continue;
    }
    const remaining =
      audioMetadataSchema.parse(asset.metadata).durationMs - track.sourceInMs;
    if (remaining <= 0) {
      issues.push({
        trackId: track.id,
        code: "source-exhausted",
        message: "Le point d'entrée dépasse la source audio",
      });
      continue;
    }
    const playMs = track.loop
      ? duration - startMs
      : Math.min(track.durationMs ?? remaining, duration - startMs);
    tracks.push(
      resolvedTrackSchema.parse({
        trackId: track.id,
        category: track.category,
        assetPath: asset.path,
        startMs,
        sourceInMs: track.sourceInMs,
        playMs,
        gainDb: track.gainDb,
        fadeInMs: Math.min(track.fadeInMs, playMs),
        fadeOutMs: Math.min(track.fadeOutMs, playMs),
        loop: track.loop,
        duck: track.duck,
      }),
    );
  }
  return { tracks, issues };
}
