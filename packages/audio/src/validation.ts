import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { ProcessError, runProcess, type ProcessOptions } from "@veyra/video";
import { z } from "zod";
import {
  audioLimitsSchema,
  audioMetadataSchema,
  type AudioLimits,
  type AudioMetadata,
} from "./schemas";

export type AudioMediaErrorCode =
  | "missing"
  | "unsupported-format"
  | "no-audio-stream"
  | "too-large"
  | "too-long"
  | "decode-failed";
const messages: Record<AudioMediaErrorCode, string> = {
  missing: "Fichier audio absent, non régulier ou lien symbolique",
  "unsupported-format": "Format audio non pris en charge",
  "no-audio-stream": "Aucun flux audio dans le fichier",
  "too-large": "Fichier audio trop volumineux",
  "too-long": "Durée audio supérieure à la limite",
  "decode-failed": "Échec du décodage ou de la lecture des métadonnées audio",
};
export class AudioMediaError extends Error {
  constructor(
    public readonly code: AudioMediaErrorCode,
    public readonly stderrTail = "",
  ) {
    super(messages[code]);
    this.name = "AudioMediaError";
  }
}
/** All media subprocesses share the existing argv-only runner and hard limits. */
export function runAudioProcess(
  command: "ffmpeg" | "ffprobe",
  args: string[],
  limits: AudioLimits = {},
  onLine?: ProcessOptions["onLine"],
) {
  const l = audioLimitsSchema.parse(limits);
  return runProcess(
    "/usr/bin/prlimit",
    [
      `--cpu=${l.cpuSeconds}`,
      `--fsize=${l.maxOutputBytes}`,
      "--",
      command,
      ...args,
    ],
    {
      timeoutMs: l.timeoutMs,
      maxLogBytes: l.maxLogBytes,
      onLine,
      label: command,
      // The executor adds PATH and LANG=C and never inherits the parent env.
      env: { LC_ALL: "C" },
    },
  );
}
export async function regularFile(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Not a regular file");
    return info;
  } catch {
    throw new AudioMediaError("missing");
  }
}
const numericString = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .transform(Number)
  .pipe(z.number().finite().nonnegative());
export const mediaProbeSchema = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      codec_name: z.string().optional(),
      sample_rate: numericString.optional(),
      channels: z.number().int().positive().optional(),
      duration: numericString.optional(),
      bit_rate: numericString.optional(),
    }),
  ),
  format: z.object({
    format_name: z.string(),
    duration: numericString,
    bit_rate: numericString.optional(),
  }),
});
export async function readMediaProbe(path: string, limits: AudioLimits = {}) {
  const { stdout } = await runAudioProcess(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      resolve(path),
    ],
    limits,
  );
  return mediaProbeSchema.parse(JSON.parse(stdout));
}
export async function probeAudio(
  path: string,
  limits: AudioLimits = {},
): Promise<AudioMetadata> {
  const l = audioLimitsSchema.parse(limits);
  const file = resolve(path);
  const info = await regularFile(file);
  if (info.size > l.maxFileBytes) throw new AudioMediaError("too-large");
  try {
    const raw = await readMediaProbe(file, l);
    const formats = raw.format.format_name.split(",");
    if (!formats.some((f) => l.allowedFormats.some((a) => a === f)))
      throw new AudioMediaError("unsupported-format");
    const stream = raw.streams.find((s) => s.codec_type === "audio");
    if (!stream) throw new AudioMediaError("no-audio-stream");
    const metadata = audioMetadataSchema.parse({
      format: raw.format.format_name,
      codec: stream.codec_name,
      sampleRate: stream.sample_rate,
      channels: stream.channels,
      durationMs: (stream.duration ?? raw.format.duration) * 1000,
      bitRate: stream.bit_rate ?? raw.format.bit_rate,
      sizeBytes: info.size,
    });
    if (
      metadata.durationMs > l.maxDurationMs ||
      raw.format.duration * 1000 > l.maxDurationMs
    )
      throw new AudioMediaError("too-long");
    const { stderr } = await runAudioProcess(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-f",
        "null",
        "-",
      ],
      l,
    );
    if (stderr.trim()) throw new AudioMediaError("decode-failed", stderr);
    return metadata;
  } catch (error) {
    if (error instanceof AudioMediaError) throw error;
    // The executor's demuxer allow-list (T136b) refuses unlisted containers before probing.
    if (
      error instanceof ProcessError &&
      /Format not on whitelist/i.test(error.stderrTail)
    )
      throw new AudioMediaError("unsupported-format", error.stderrTail);
    throw new AudioMediaError(
      "decode-failed",
      error instanceof ProcessError ? error.stderrTail : "",
    );
  }
}
