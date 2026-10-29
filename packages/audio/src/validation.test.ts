import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readFile, symlink, writeFile } from "node:fs/promises";
import * as video from "@veyra/video";
import { AudioMediaError, probeAudio, runAudioProcess } from "./validation";
import { fixtures } from "./fixtures.test-utils";
// Real FFmpeg measurements share CPU with the other workspace integration tests.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
let f: Awaited<ReturnType<typeof fixtures>>, wav: string;
beforeAll(async () => {
  f = await fixtures();
  wav = await f.tone("source.wav");
});
afterAll(async () => {
  await f.clean();
});
it("probes and fully decodes WAV and MP3", async () => {
  expect(await probeAudio(wav)).toMatchObject({
    format: "wav",
    codec: "pcm_s16le",
    sampleRate: 48000,
    channels: 2,
    durationMs: 500,
  });
  const mp3 = await f.tone("source.mp3");
  const meta = await probeAudio(mp3);
  expect(meta.codec).toBe("mp3");
  expect(meta.durationMs).toBeGreaterThanOrEqual(500);
  expect(meta.sizeBytes).toBeGreaterThan(0);
});
it("rejects missing paths, directories and symlinks", async () => {
  await expect(probeAudio(join(f.dir, "absent"))).rejects.toMatchObject({
    code: "missing",
  });
  await expect(probeAudio(f.dir)).rejects.toMatchObject({ code: "missing" });
  const link = join(f.dir, "link.wav");
  await symlink(wav, link);
  await expect(probeAudio(link)).rejects.toMatchObject({ code: "missing" });
});
it("rejects fake media and damaged PCM with an explicit decode error", async () => {
  const fake = join(f.dir, "fake.wav");
  await writeFile(fake, "not audio");
  await expect(probeAudio(fake)).rejects.toBeInstanceOf(AudioMediaError);
  await expect(probeAudio(fake)).rejects.toMatchObject({
    code: "decode-failed",
  });
  const broken = join(f.dir, "broken.wav"),
    data = await readFile(wav);
  await writeFile(broken, data.subarray(0, data.length - 1));
  await expect(probeAudio(broken)).rejects.toMatchObject({
    code: "decode-failed",
    stderrTail: expect.stringMatching(/Invalid|Error|invalid/),
  });
});
it("enforces byte/duration/container limits and requires an audio stream", async () => {
  await expect(probeAudio(wav, { maxFileBytes: 10 })).rejects.toMatchObject({
    code: "too-large",
  });
  await expect(probeAudio(wav, { maxDurationMs: 100 })).rejects.toMatchObject({
    code: "too-long",
  });
  await expect(
    probeAudio(wav, { allowedFormats: ["mp3"] }),
  ).rejects.toMatchObject({ code: "unsupported-format" });
  await expect(probeAudio(await f.video())).rejects.toMatchObject({
    code: "no-audio-stream",
  });
  await expect(
    probeAudio(await f.tone("unsupported.mka")),
  ).rejects.toMatchObject({ code: "unsupported-format" });
});
it("wraps subprocesses in prlimit with argv, whitelists and bounded logs", async () => {
  const spy = vi.spyOn(video, "runProcess");
  try {
    await probeAudio(wav, {
      cpuSeconds: 3,
      timeoutMs: 4000,
      maxOutputBytes: 4096,
      maxLogBytes: 65536,
    });
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [binary, args, options] of spy.mock.calls) {
      expect(binary).toBe("/usr/bin/prlimit");
      expect(args.slice(0, 3)).toEqual(["--cpu=3", "--fsize=4096", "--"]);
      expect(args).toContain("-protocol_whitelist");
      expect(options).toMatchObject({ timeoutMs: 4000, maxLogBytes: 65536 });
    }
  } finally {
    spy.mockRestore();
  }
});
it("kills work at the wall timeout", async () => {
  await expect(
    runAudioProcess(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "anullsrc",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: 30 },
    ),
  ).rejects.toThrow(/timeout/);
});
