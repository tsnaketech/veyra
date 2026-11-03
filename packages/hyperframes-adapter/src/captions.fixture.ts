import {
  captionTrackSchema,
  frameCount,
  quantizeCues,
  type CaptionTrack,
  type FrameRate,
} from "@veyra/schemas";

/** Test data: a track whose words are spread evenly inside each cue. */
export function captionFixture(
  cues: { startMs: number; endMs: number; lines: string[] }[],
  style: Record<string, unknown> = {},
): CaptionTrack {
  const words: CaptionTrack["words"] = [];
  const out = cues.map((cue, i) => {
    const texts = cue.lines.flatMap((line) => line.split(" "));
    const step = (cue.endMs - cue.startMs) / texts.length;
    const wordStart = words.length;
    texts.forEach((text, k) =>
      words.push({
        text,
        startMs: Math.round(cue.startMs + k * step),
        endMs: Math.round(cue.startMs + (k + 1) * step),
        confidence: null,
        timing: "manual",
        sceneId: null,
      }),
    );
    return {
      id: `cue_${i + 1}`,
      wordStart,
      wordEnd: words.length,
      startMs: cue.startMs,
      endMs: cue.endMs,
      lines: cue.lines,
    };
  });
  return captionTrackSchema.parse({
    schemaVersion: 1,
    id: "cap_test",
    words,
    cues: out,
    style,
    provenance: { provider: "manual" },
  });
}
export const layerFor = (
  track: CaptionTrack,
  rate: FrameRate,
  durationMs: number,
) => ({
  track,
  rate,
  cues: quantizeCues(track.cues, rate, frameCount(durationMs, rate)),
});
