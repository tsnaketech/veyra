import { statSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  newId,
  parseFrameRate,
  qualityCheckSchema,
  type QualityCheck,
} from "@veyra/schemas";
import {
  fileInput,
  IMAGE_FORMATS,
  mediaPath,
  runProcess,
  VIDEO_FORMATS,
  type ProcessOptions,
} from "./process";
export {
  runProcess,
  childEnv,
  isSecretEnvKey,
  mediaPath,
  fileInput,
  MEDIA_LIMITS,
  MEDIA_FORMATS,
  VIDEO_FORMATS,
  IMAGE_FORMATS,
  systemBinary,
  SYSTEM_BIN_DIRS,
  CHILD_ENV_KEYS,
  ProcessError,
  type ProcessOptions,
  type ProcessLimits,
} from "./process";
export * from "./photosensitivity";
export * from "./text-contrast";
export const probeSchema = z.object({
  durationMs: z.number().nonnegative(),
  codec: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  audioStreams: z.array(
    z.object({
      index: z.number().int(),
      codec: z.string(),
      channels: z.number().int().nonnegative(),
    }),
  ),
  size: z.number().int().nonnegative(),
  // Exact rate and timing of the video stream, used for frame indexing.
  frameRate: z
    .object({
      num: z.number().int().positive(),
      den: z.number().int().positive(),
    })
    .optional(),
  startMs: z.number().optional(),
  frameCount: z.number().int().nonnegative().optional(),
  constantFrameRate: z.boolean().optional(),
  blackSegments: z.array(
    z.object({
      startMs: z.number().nonnegative(),
      endMs: z.number().nonnegative(),
    }),
  ),
});
export type VideoProbe = z.infer<typeof probeSchema>;
/** Caller controls of a media helper: abort (kills the process group) and prlimit bounds. */
export type MediaRunOptions = Pick<ProcessOptions, "signal" | "limits">;
export async function probe(
  file: string,
  run: MediaRunOptions = {},
): Promise<VideoProbe> {
  const path = mediaPath(file);
  const { stdout } = await runProcess(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      VIDEO_FORMATS,
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      path,
    ],
    run,
  );
  const raw = z
    .object({
      streams: z.array(
        z.object({
          index: z.number(),
          codec_type: z.string(),
          codec_name: z.string().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
          avg_frame_rate: z.string().optional(),
          r_frame_rate: z.string().optional(),
          start_time: z.string().optional(),
          nb_frames: z.string().optional(),
          channels: z.number().optional(),
        }),
      ),
      format: z.object({ duration: z.string() }),
    })
    .parse(JSON.parse(stdout));
  const video = raw.streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("No video stream");
  const [num, den = 1] = (video.avg_frame_rate ?? "0/1").split("/").map(Number);
  const average = parseFrameRate(video.avg_frame_rate ?? "");
  const nominal = parseFrameRate(video.r_frame_rate ?? "");
  const blackSegments: VideoProbe["blackSegments"] = [];
  await runProcess(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-threads",
      "1",
      ...fileInput(path),
      "-an",
      "-vf",
      "blackdetect=d=0.05:pix_th=0.10:pic_th=0.98",
      "-f",
      "null",
      "-",
    ],
    {
      ...run,
      timeoutMs: 120000,
      onLine: (line) => {
        const match = /black_start:([\d.]+)\s+black_end:([\d.]+)/.exec(line);
        if (match)
          blackSegments.push({
            startMs: Number(match[1]) * 1000,
            endMs: Number(match[2]) * 1000,
          });
      },
    },
  );
  return probeSchema.parse({
    durationMs: Number(raw.format.duration) * 1000,
    codec: video.codec_name ?? "unknown",
    width: video.width,
    height: video.height,
    fps: num / den,
    audioStreams: raw.streams
      .filter((stream) => stream.codec_type === "audio")
      .map((stream) => ({
        index: stream.index,
        codec: stream.codec_name ?? "unknown",
        channels: stream.channels ?? 0,
      })),
    size: statSync(path).size,
    frameRate: nominal ?? average ?? undefined,
    startMs: video.start_time ? Number(video.start_time) * 1000 : 0,
    frameCount: video.nb_frames ? Number(video.nb_frames) : undefined,
    // Equal nominal and average rates: treat as constant frame rate (CFR).
    constantFrameRate: Boolean(
      nominal &&
      average &&
      nominal.num * average.den === average.num * nominal.den,
    ),
    blackSegments,
  });
}
export const expectedVideoSchema = z.object({
  durationMs: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
});
export const qualityConfigSchema = z.object({
  durationToleranceMs: z.number().nonnegative(),
  minResolution: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  fpsTolerance: z.number().nonnegative().default(0.01),
});
export function deterministicChecks(
  input: VideoProbe,
  expectedInput: z.input<typeof expectedVideoSchema>,
  configInput: z.input<typeof qualityConfigSchema>,
): QualityCheck[] {
  const data = probeSchema.parse(input),
    expected = expectedVideoSchema.parse(expectedInput),
    config = qualityConfigSchema.parse(configInput);
  const check = (
    name: string,
    passed: boolean,
    evidence: unknown,
    recommendation: string,
    timestamp = 0,
  ): QualityCheck =>
    qualityCheckSchema.parse({
      id: newId("qck"),
      name,
      passed,
      severity: passed ? "info" : "major",
      timestamp: Math.round(timestamp),
      evidence: JSON.stringify(evidence),
      recommendation: passed ? "No action required" : recommendation,
      analysisMode: "deterministic",
    });
  return [
    check(
      "duration",
      Math.abs(data.durationMs - expected.durationMs) <=
        config.durationToleranceMs,
      {
        actualMs: data.durationMs,
        expectedMs: expected.durationMs,
        toleranceMs: config.durationToleranceMs,
      },
      "Render the expected duration",
    ),
    check(
      "resolution",
      data.width === expected.width &&
        data.height === expected.height &&
        data.width >= config.minResolution.width &&
        data.height >= config.minResolution.height,
      {
        width: data.width,
        height: data.height,
        expected,
        minimum: config.minResolution,
      },
      "Render the requested dimensions",
    ),
    check(
      "fps",
      Math.abs(data.fps - expected.fps) <= config.fpsTolerance,
      { actual: data.fps, expected: expected.fps },
      "Render the requested frame rate",
    ),
    check(
      "codec",
      data.codec === "h264",
      { codec: data.codec },
      "Encode using h264",
    ),
    check(
      "non-empty",
      data.size > 0,
      { bytes: data.size },
      "Produce a non-empty video",
    ),
    check(
      "black-frames",
      data.blackSegments.length === 0,
      { segments: data.blackSegments },
      "Inspect and remove black segments",
      data.blackSegments[0]?.startMs ?? 0,
    ),
  ];
}
export async function extractFrames(
  file: string,
  timestampsMs: number[],
): Promise<string[]> {
  const times = z
    .array(z.number().finite().nonnegative())
    .min(1)
    .max(60)
    .parse(timestampsMs);
  const path = resolve(file);
  const info = await probe(path);
  if (times.some((time) => time >= info.durationMs))
    throw new Error("Frame timestamp outside video");
  const dir = mkdtempSync(join(dirname(path), "frames-"));
  const frames: string[] = [];
  for (const [index, ms] of times.entries()) {
    const output = join(dir, `${index}-${ms}.png`);
    await runProcess("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-ss",
      String(ms / 1000),
      ...fileInput(path),
      "-frames:v",
      "1",
      "-threads",
      "1",
      output,
    ]);
    if (statSync(output).size === 0) throw new Error("Empty extracted frame");
    frames.push(output);
  }
  return frames;
}
/** Decodes up to frame `index` and writes exactly that frame (no seek approximation). */
export async function extractFrameByIndex(
  file: string,
  index: number,
  output: string,
  run: MediaRunOptions = {},
): Promise<string> {
  const frame = z.number().int().nonnegative().parse(index);
  // shortcut: decodes from the start (fine for ≤ 60 s renders); seek near the frame for long media.
  await runProcess(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-y",
      ...fileInput(file),
      "-vf",
      `select=eq(n\\,${frame})`,
      "-fps_mode",
      "passthrough",
      "-frames:v",
      "1",
      "-threads",
      "1",
      resolve(output),
    ],
    { ...run, timeoutMs: 60000 },
  );
  if (!statSync(output, { throwIfNoEntry: false })?.size)
    throw new Error(`Frame ${frame} not found`);
  return output;
}
/** PSNR in dB between two same-size images; Infinity when identical. */
export async function compareFrames(a: string, b: string): Promise<number> {
  const { stderr } = await runProcess("ffmpeg", [
    "-nostdin",
    "-hide_banner",
    ...fileInput(a, IMAGE_FORMATS),
    ...fileInput(b, IMAGE_FORMATS),
    "-lavfi",
    "psnr",
    "-f",
    "null",
    "-",
  ]);
  const match = /average:(inf|[\d.]+)/.exec(stderr);
  if (!match) throw new Error("PSNR not reported");
  return match[1] === "inf" ? Infinity : Number(match[1]);
}
/**
 * Writes the frames with the given indices (exact, one decode pass) into `dir`.
 * Returns one path per requested index, in the order requested.
 */
export async function extractFramesByIndex(
  file: string,
  indices: number[],
  dir: string,
): Promise<string[]> {
  const wanted = z
    .array(z.number().int().nonnegative())
    .min(1)
    .max(200)
    .parse(indices);
  const unique = [...new Set(wanted)].sort((a, b) => a - b);
  // Fresh sub-directory: stale files from an earlier call can never pass for output.
  const out = mkdtempSync(join(resolve(dir), "frames-"));
  const pattern = join(out, "frame-%04d.png");
  await runProcess(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-y",
      ...fileInput(file),
      "-vf",
      `select='${unique.map((n) => `eq(n\\,${n})`).join("+")}'`,
      "-fps_mode",
      "passthrough",
      "-threads",
      "1",
      pattern,
    ],
    { timeoutMs: 120000 },
  );
  // ffmpeg numbers outputs 1..k in decode order, i.e. ascending frame index.
  const byIndex = new Map(
    unique.map((n, i) => [
      n,
      join(out, `frame-${String(i + 1).padStart(4, "0")}.png`),
    ]),
  );
  for (const [n, path] of byIndex)
    if (!statSync(path, { throwIfNoEntry: false })?.size)
      throw new Error(`Frame ${n} not found`);
  return wanted.map((n) => byIndex.get(n)!);
}
