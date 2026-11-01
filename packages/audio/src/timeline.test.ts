import { expect, it } from "vitest";
import { createTimelineEvent, type AudioComposition } from "@veyra/schemas";
import { resolveAudioComposition } from "./timeline";
const metadata = {
  format: "wav",
  codec: "pcm_s16le",
  sampleRate: 48000,
  channels: 2,
  durationMs: 2000,
  sizeBytes: 1000,
};
const assets = new Map([["ast_tone", { path: "/tmp/tone.wav", metadata }]]);
const composition: AudioComposition = {
  schemaVersion: 1,
  master: { targetLufs: -16, truePeakDb: -1 },
  tracks: [
    {
      id: "atr_event",
      assetId: "ast_tone",
      label: "Effet",
      category: "sfx",
      anchor: {
        type: "event",
        sceneId: "scn_title",
        event: "title-reveal",
        index: 0,
        edge: "start",
        offsetMs: 0,
      },
      sourceInMs: 0,
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      loop: false,
      duck: [],
    },
    {
      id: "atr_absolute",
      assetId: "ast_tone",
      label: "Fixe",
      category: "sfx",
      anchor: { type: "absolute", atMs: 500 },
      sourceInMs: 0,
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      loop: false,
      duck: [],
    },
  ],
};
const event = (startMs: number) =>
  createTimelineEvent(
    {
      id: "scn_title:title-reveal:0",
      name: "title-reveal",
      kind: "visual",
      sceneId: "scn_title",
      startMs,
      endMs: startMs + 500,
      source: "motion",
    },
    { num: 30, den: 1 },
    120,
  );
it("moves event cues with scenes while absolute cues remain fixed", () => {
  expect(
    resolveAudioComposition(composition, [event(500)], assets, 4000).tracks.map(
      (t) => t.startMs,
    ),
  ).toEqual([500, 500]);
  expect(
    resolveAudioComposition(
      composition,
      [event(1500)],
      assets,
      4000,
    ).tracks.map((t) => t.startMs),
  ).toEqual([1500, 500]);
});
it("skips missing events without an absolute fallback and reports missing assets", () => {
  const result = resolveAudioComposition(composition, [], assets, 4000);
  expect(result.issues).toMatchObject([
    { trackId: "atr_event", code: "event-missing" },
  ]);
  expect(result.tracks.map((t) => t.trackId)).toEqual(["atr_absolute"]);
  expect(
    resolveAudioComposition(
      composition,
      [event(500)],
      new Map(),
      4000,
    ).issues.map((i) => i.code),
  ).toEqual(["asset-missing", "asset-missing"]);
});
it("clips to source/video ends, fills looped music and preserves absolute duck times", () => {
  const base = composition.tracks[1];
  const result = resolveAudioComposition(
    {
      ...composition,
      tracks: [
        { ...base, sourceInMs: 500, durationMs: 5000 },
        {
          ...base,
          id: "atr_music",
          category: "music",
          loop: true,
          durationMs: 100,
          fadeOutMs: 9000,
          duck: [{ startMs: 1000, endMs: 2000, gainDb: -12 }],
        },
      ],
    },
    [],
    assets,
    3000,
  );
  // 2000 ms source from 500 ms: 1500 ms left, even if durationMs asks for more.
  expect(result.tracks.map((t) => t.playMs)).toEqual([1500, 2500]);
  expect(result.tracks[1].fadeOutMs).toBe(2500);
  expect(result.tracks[1].duck[0].startMs).toBe(1000);
});
it("reports negative anchors, end-of-video starts and exhausted sources", () => {
  for (const [patch, code] of [
    [
      { anchor: { ...composition.tracks[0].anchor, offsetMs: -1000 } },
      "before-zero",
    ],
    [{ anchor: { type: "absolute", atMs: 4000 } }, "after-end"],
    [{ anchor: { type: "absolute", atMs: 5000 } }, "after-end"],
    [{ sourceInMs: 2000 }, "source-exhausted"],
  ] as const) {
    const input = {
      ...composition,
      tracks: [{ ...composition.tracks[0], ...patch }],
    } as AudioComposition;
    const result = resolveAudioComposition(input, [event(500)], assets, 4000);
    expect(result.tracks).toEqual([]);
    expect(result.issues[0].code).toBe(code);
  }
});
