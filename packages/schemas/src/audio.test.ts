import { expect, it } from "vitest";
import {
  audioCompositionSchema,
  audioMixPatchSchema,
  audioTrackSchema,
  newId,
} from "./index";
const track = {
  id: newId("atr"),
  assetId: newId("ast"),
  category: "music",
  label: "Fond",
  anchor: { type: "absolute", atMs: 0 },
};
it("parses composition and track defaults without inventing source duration", () => {
  const c = audioCompositionSchema.parse({
    schemaVersion: 1,
    tracks: [track],
    master: {},
  });
  expect(c.master).toEqual({ targetLufs: -16, truePeakDb: -1 });
  expect(c.tracks[0]).toMatchObject({
    sourceInMs: 0,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    loop: false,
    duck: [],
  });
  expect(c.tracks[0].durationMs).toBeUndefined();
  expect(audioMixPatchSchema.parse({ gainDb: -4 })).toEqual({ gainDb: -4 });
});
it.each([
  { id: "ast_x" },
  { assetId: "atr_x" },
  { category: "other" },
  { category: "sfx", loop: true },
  { category: "music", loop: true, sourceInMs: 500 },
  { durationMs: 0 },
  { sourceInMs: -1 },
  { gainDb: 13 },
  { gainDb: -61 },
  { fadeInMs: -1 },
  { fadeOutMs: -1 },
  { duck: [{ startMs: 20, endMs: 10, gainDb: -3 }] },
  { duck: [{ startMs: 0, endMs: 10, gainDb: 1 }] },
])("rejects invalid track %j", (patch) =>
  expect(audioTrackSchema.safeParse({ ...track, ...patch }).success).toBe(
    false,
  ),
);
it("allows loops only for music and bounded loudness", () => {
  expect(audioTrackSchema.parse({ ...track, loop: true }).loop).toBe(true);
  expect(
    audioCompositionSchema.safeParse({
      schemaVersion: 1,
      tracks: [],
      master: { targetLufs: -31 },
    }).success,
  ).toBe(false);
});
