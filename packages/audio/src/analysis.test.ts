import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { join } from "node:path";
import {
  analyzeAudio,
  detectOnsets,
  meanVolumeDb,
  parseAudioMeasurements,
  parseSilences,
} from "./analysis";
import { mixToWav } from "./mixing";
import { fixtures } from "./fixtures.test-utils";
// Real FFmpeg measurements share CPU with the other workspace integration tests.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
let f: Awaited<ReturnType<typeof fixtures>>;
beforeAll(async () => {
  f = await fixtures();
});
afterAll(async () => {
  await f.clean();
});
it("measures loudness, peaks and clipping on real audio", async () => {
  const tone = await f.tone("tone.wav", 2);
  const result = await analyzeAudio(tone);
  expect(result).toMatchObject({
    codec: "pcm_s16le",
    sampleRate: 48000,
    channels: 2,
    durationMs: 2000,
    clippedSamples: 0,
    silences: [],
  });
  expect(result.integratedLufs).toBeGreaterThan(-30);
  expect(result.integratedLufs).toBeLessThan(-10);
  expect(result.truePeakDb).toBeGreaterThan(-25);
  expect(result.peakDb).toBeLessThan(-15);
  expect(await detectOnsets(tone)).toEqual([0]);
  expect(await meanVolumeDb(tone, 0, 1000)).toBeLessThan(-15);
  const clipped = await f.tone("clipped.wav", 2, "volume=30");
  expect((await analyzeAudio(clipped)).clippedSamples).toBeGreaterThan(0);
});
it("measures silence without inventing finite peak levels", async () => {
  const file = join(f.dir, "silence.wav");
  await mixToWav([], file, {}, 2000);
  const result = await analyzeAudio(file);
  expect(result.silences).toEqual([{ startMs: 0, endMs: 2000 }]);
  expect(result.peakDb).toBe(-Infinity);
  expect(result.truePeakDb).toBe(-Infinity);
  expect(result.clippedSamples).toBe(0);
  await expect(meanVolumeDb(file, 100, 50)).rejects.toThrow();
  await expect(meanVolumeDb(file, 0, 3000)).rejects.toThrow();
});
it("rejects missing or malformed measurement values", () => {
  expect(() => parseAudioMeasurements([], 1000)).toThrow(/illisible/);
  expect(() =>
    parseSilences(["[silencedetect] silence_start: broken"], 1000),
  ).toThrow(/illisible/);
  expect(() => parseSilences(["[silencedetect] silence_end: 1"], 1000)).toThrow(
    /sans début/,
  );
  expect(parseSilences(["[silencedetect] silence_start: 0.5"], 1000)).toEqual([
    { startMs: 500, endMs: 1000 },
  ]);
});
