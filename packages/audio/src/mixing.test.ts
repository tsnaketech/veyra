import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { join } from "node:path";
import { link, readdir, writeFile } from "node:fs/promises";
import { buildMixArgs, mixToWav, muxAudio } from "./mixing";
import { detectOnsets, meanVolumeDb } from "./analysis";
import { probeAudio, readMediaProbe } from "./validation";
import { fixtures, hash, track } from "./fixtures.test-utils";
// Real FFmpeg measurements share CPU with the other workspace integration tests.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
let f: Awaited<ReturnType<typeof fixtures>>,
  music: string,
  voice: string,
  sfx: string;
beforeAll(async () => {
  f = await fixtures();
  music = await f.tone("music.wav", 0.5);
  voice = await f.tone("voice.wav", 1);
  sfx = await f.tone("sfx.wav", 0.15);
});
afterAll(async () => {
  await f.clean();
});
it("builds a numeric-only graph with loop inputs and absolute duck conversion", () => {
  const t = {
    ...track(music, {
      category: "music",
      loop: true,
      startMs: 500,
      playMs: 2500,
      fadeInMs: 100,
      fadeOutMs: 200,
      duck: [{ startMs: 1500, endMs: 2000, gainDb: -12 }],
    }),
    label: "x];[evil",
  };
  const args = buildMixArgs([t], join(f.dir, "out.wav"), {
    videoDurationMs: 3000,
  });
  expect(args.join(" ")).not.toContain(t.label);
  expect(args.indexOf("-stream_loop")).toBeLessThan(args.indexOf("-i"));
  const graph = args[args.indexOf("-filter_complex") + 1];
  expect(graph).toContain("between(t,1.000000,1.500000)");
  expect(graph).toContain("afade=t=out:st=2.300000:d=0.200000");
  expect(graph).toContain("adelay=500.000000:all=1");
  expect(() =>
    buildMixArgs([{ ...t, gainDb: NaN }], "out.wav", { videoDurationMs: 3000 }),
  ).toThrow();
  expect(() =>
    buildMixArgs([{ ...t, gainDb: "0;evil" as unknown as number }], "out.wav", {
      videoDurationMs: 3000,
    }),
  ).toThrow();
});
it("mixes looping music, voiceover and two effects without modifying originals", async () => {
  const originals = await Promise.all([music, voice, sfx].map(hash));
  const out = join(f.dir, "mix.wav");
  await mixToWav(
    [
      track(music, { category: "music", loop: true, playMs: 3000, gainDb: -6 }),
      track(voice, { category: "voiceover", startMs: 500, playMs: 1000 }),
      track(sfx, { startMs: 300, playMs: 150 }),
      track(sfx, { startMs: 2000, playMs: 150 }),
    ],
    out,
    {},
    3000,
  );
  const metadata = await probeAudio(out);
  expect(Math.abs(metadata.durationMs - 3000)).toBeLessThan(1000 / 30);
  expect(metadata).toMatchObject({ sampleRate: 48000, channels: 2 });
  expect(await Promise.all([music, voice, sfx].map(hash))).toEqual(originals);
  expect(await meanVolumeDb(out, 2500, 2800)).toBeGreaterThan(-50);
});
it("places sfx onsets within 40 ms and generates silence for empty compositions", async () => {
  const out = join(f.dir, "effects.wav");
  await mixToWav(
    [
      track(sfx, { startMs: 500, playMs: 150 }),
      track(sfx, { startMs: 1800, playMs: 150 }),
    ],
    out,
    {},
    3000,
  );
  const onsets = await detectOnsets(out, { noiseDb: -45, minSilenceMs: 100 });
  expect(onsets).toHaveLength(2);
  expect(Math.abs(onsets[0] - 500)).toBeLessThanOrEqual(40);
  expect(Math.abs(onsets[1] - 1800)).toBeLessThanOrEqual(40);
  const silent = join(f.dir, "silent.wav");
  await mixToWav([], silent, {}, 3000);
  expect((await probeAudio(silent)).durationMs).toBe(3000);
  expect(await detectOnsets(silent)).toEqual([]);
});
it("applies fade-in/out and lowers absolute duck windows by at least 6 dB", async () => {
  const fade = join(f.dir, "fade.wav");
  await mixToWav(
    [
      track(music, {
        category: "music",
        loop: true,
        playMs: 3000,
        fadeInMs: 1000,
        fadeOutMs: 500,
      }),
    ],
    fade,
    {},
    3000,
  );
  expect(await meanVolumeDb(fade, 0, 200)).toBeLessThan(
    (await meanVolumeDb(fade, 1200, 1800)) - 10,
  );
  expect(await meanVolumeDb(fade, 2800, 3000)).toBeLessThan(
    (await meanVolumeDb(fade, 1200, 1800)) - 6,
  );
  const duck = join(f.dir, "duck.wav");
  await mixToWav(
    [
      track(music, {
        category: "music",
        loop: true,
        startMs: 250,
        playMs: 2750,
        duck: [{ startMs: 1000, endMs: 2000, gainDb: -12 }],
      }),
    ],
    duck,
    {},
    3000,
  );
  expect(await meanVolumeDb(duck, 1200, 1800)).toBeLessThanOrEqual(
    (await meanVolumeDb(duck, 400, 800)) - 6,
  );
});
it("muxes h264 copy + AAC stereo at video duration and preserves all sources", async () => {
  const video = await f.video(),
    wav = join(f.dir, "mux-source.wav"),
    out = join(f.dir, "mux.mp4");
  await mixToWav(
    [track(music, { category: "music", loop: true, playMs: 3000 })],
    wav,
    {},
    3000,
  );
  const before = await Promise.all([video, wav].map(hash));
  await muxAudio(video, wav, out, {});
  const result = await readMediaProbe(out);
  expect(result.streams.find((s) => s.codec_type === "video")?.codec_name).toBe(
    "h264",
  );
  expect(result.streams.find((s) => s.codec_type === "audio")).toMatchObject({
    codec_name: "aac",
    sample_rate: 48000,
    channels: 2,
  });
  expect(Math.abs(result.format.duration * 1000 - 3000)).toBeLessThan(
    1000 / 30,
  );
  expect(await Promise.all([video, wav].map(hash))).toEqual(before);
  await expect(muxAudio(video, wav, video)).rejects.toThrow(/source/);
  await expect(muxAudio(video, wav, wav)).rejects.toThrow(/source/);
});
it("refuses input aliases and keeps prior output intact after a failed render", async () => {
  const before = await hash(music);
  await expect(mixToWav([track(music)], music, {}, 500)).rejects.toThrow(
    /source/,
  );
  const alias = join(f.dir, "hardlink.wav");
  await link(music, alias);
  await expect(mixToWav([track(music)], alias, {}, 500)).rejects.toThrow(
    /source/,
  );
  const out = join(f.dir, "existing.wav");
  await writeFile(out, "prior output");
  const previous = await hash(out);
  await expect(
    mixToWav([track(music)], out, { maxOutputBytes: 128 }, 500),
  ).rejects.toThrow();
  expect(await hash(out)).toBe(previous);
  expect(await hash(music)).toBe(before);
  expect((await readdir(f.dir)).filter((n) => n.includes(".tmp."))).toEqual([]);
});
