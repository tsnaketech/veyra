import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probe,
  extractFrames,
  extractFrameByIndex,
  extractFramesByIndex,
  compareFrames,
  deterministicChecks,
  runProcess,
} from "./index";
let root: string, clip: string, black: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "veyra-video-"));
  clip = join(root, "test.mp4");
  black = join(root, "black.mp4");
  for (const [path, source] of [
    [clip, "testsrc=size=160x90:rate=30"],
    [black, "color=black:size=160x90:rate=30"],
  ]) {
    await runProcess("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      source,
      "-t",
      "0.6",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
it("probes a tiny real h264 video and checks deterministic properties", async () => {
  const info = await probe(clip);
  expect(info).toMatchObject({
    durationMs: 600,
    width: 160,
    height: 90,
    codec: "h264",
    fps: 30,
    audioStreams: [],
    blackSegments: [],
  });
  const checks = deterministicChecks(
    info,
    { durationMs: 600, width: 160, height: 90, fps: 30 },
    { durationToleranceMs: 50, minResolution: { width: 160, height: 90 } },
  );
  expect(checks).toHaveLength(6);
  expect(
    checks.every(
      (check) => check.passed && check.analysisMode === "deterministic",
    ),
  ).toBe(true);
});
it("detects black segments with timestamps and fails QA", async () => {
  const info = await probe(black);
  expect(info.blackSegments[0].startMs).toBe(0);
  expect(info.blackSegments[0].endMs).toBeGreaterThan(500);
  const checks = deterministicChecks(
    info,
    { durationMs: 1500, width: 1920, height: 1080, fps: 25 },
    { durationToleranceMs: 50, minResolution: { width: 1920, height: 1080 } },
  );
  expect(
    checks.filter((check) => !check.passed).map((check) => check.name),
  ).toEqual(["duration", "resolution", "fps", "black-frames"]);
});
it("extracts PNG frames and rejects out-of-range times", async () => {
  const frames = await extractFrames(clip, [0, 300]);
  expect(frames).toHaveLength(2);
  expect(readFileSync(frames[0]).subarray(1, 4).toString()).toBe("PNG");
  await expect(extractFrames(clip, [600])).rejects.toThrow("outside");
});
it("persists subprocess stderr and enforces timeout and log limits", async () => {
  await expect(
    runProcess(process.execPath, [
      "-e",
      'require("node:fs").writeSync(2,"failure-tail\\n");process.exitCode=1',
    ]),
  ).rejects.toMatchObject({ stderrTail: "failure-tail\n" });
  await expect(
    runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 50,
    }),
  ).rejects.toThrow("timeout");
  await expect(
    runProcess(
      process.execPath,
      ["-e", 'require("node:fs").writeSync(1,"x".repeat(10000))'],
      { maxLogBytes: 100 },
    ),
  ).rejects.toThrow("size");
});
it("measures the exact frame rate and extracts a frame by index", async () => {
  const info = await probe(clip);
  expect(info).toMatchObject({
    frameRate: { num: 30, den: 1 },
    frameCount: 18,
    constantFrameRate: true,
  });
  const first = await extractFrameByIndex(clip, 3, join(root, "f3.png"));
  const again = await extractFrameByIndex(clip, 3, join(root, "f3b.png"));
  const other = await extractFrameByIndex(clip, 12, join(root, "f12.png"));
  expect(await compareFrames(first, again)).toBe(Infinity);
  expect(await compareFrames(first, other)).toBeLessThan(40);
  await expect(
    extractFrameByIndex(clip, 500, join(root, "none.png")),
  ).rejects.toThrow(/not found/);
});
it("extracts several exact frames in one pass, matching single extraction", async () => {
  const dir = join(root, "multi");
  await runProcess("mkdir", ["-p", dir]);
  const paths = await extractFramesByIndex(clip, [12, 3, 12], dir);
  expect(paths).toHaveLength(3);
  expect(paths[0]).toBe(paths[2]);
  const single = await extractFrameByIndex(clip, 3, join(root, "single3.png"));
  expect(await compareFrames(paths[1], single)).toBe(Infinity);
  await expect(extractFramesByIndex(clip, [999], dir)).rejects.toThrow(
    /not found/,
  );
});
