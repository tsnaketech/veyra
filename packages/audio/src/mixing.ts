import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import {
  mixSettingsSchema,
  resolvedTrackSchema,
  type MixSettings,
  type ResolvedTrack,
} from "./schemas";
import { readMediaProbe, regularFile, runAudioProcess } from "./validation";

const durationSchema = z.number().positive().max(86400000);
export function fixed(value: number): string {
  return z.number().min(-1e10).max(1e10).parse(value).toFixed(6);
}
const seconds = (ms: number) => fixed(ms / 1000);
/** videoDurationMs is explicit so silence and trailing padding are deterministic. */
export function buildMixArgs(
  input: readonly ResolvedTrack[],
  outputWav: string,
  settings: MixSettings & { videoDurationMs: number },
): string[] {
  const tracks = z.array(resolvedTrackSchema).parse(input);
  const s = mixSettingsSchema.parse(settings);
  const duration = durationSchema.parse(settings.videoDurationMs);
  const args = [
    "-nostdin",
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-filter_complex_threads",
    "1",
  ];
  const graph: string[] = [];
  if (!tracks.length) {
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
    graph.push(`[0:a]atrim=duration=${seconds(duration)}[out]`);
  } else {
    tracks.forEach((t, i) => {
      if (t.loop) args.push("-stream_loop", "-1");
      args.push("-protocol_whitelist", "file", "-i", resolve(t.assetPath));
      const playMs = Math.min(t.playMs, duration - t.startMs);
      if (playMs <= 0) throw new Error("Piste hors de la durée vidéo");
      const filters = [
        `atrim=start=${seconds(t.sourceInMs)}:duration=${seconds(playMs)}`,
        "asetpts=PTS-STARTPTS",
        "aformat=sample_rates=48000:channel_layouts=stereo",
        `volume=${fixed(t.gainDb)}dB`,
      ];
      const fadeIn = Math.min(t.fadeInMs, playMs),
        fadeOut = Math.min(t.fadeOutMs, playMs);
      if (fadeIn > 0)
        filters.push(`afade=t=in:st=0.000000:d=${seconds(fadeIn)}`);
      if (fadeOut > 0)
        filters.push(
          `afade=t=out:st=${seconds(playMs - fadeOut)}:d=${seconds(fadeOut)}`,
        );
      for (const duck of t.duck) {
        const start = Math.max(0, duck.startMs - t.startMs),
          end = Math.min(playMs, duck.endMs - t.startMs);
        if (end > start)
          filters.push(
            `volume=enable='between(t,${seconds(start)},${seconds(end)})':volume=${fixed(duck.gainDb)}dB`,
          );
      }
      filters.push(`adelay=${fixed(t.startMs)}:all=1`);
      graph.push(`[${i}:a:0]${filters.join(",")}[a${i}]`);
    });
    // Disable alimiter auto-level and compensate its lookahead; no mastering gain.
    graph.push(
      `${tracks.map((_, i) => `[a${i}]`).join("")}amix=inputs=${tracks.length}:normalize=0:duration=longest,apad,atrim=duration=${seconds(duration)},aresample=192000,alimiter=limit=${fixed(10 ** (s.truePeakDb / 20))}:level=false:latency=true,aresample=48000,apad,atrim=duration=${seconds(duration)}[out]`,
    );
  }
  return [
    ...args,
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[out]",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    resolve(outputWav),
  ];
}
/** Refuse lexical, symlink and hard-link aliases before creating any output. */
async function assertSeparateOutput(inputs: readonly string[], output: string) {
  const out = resolve(output);
  const canonicalOut = resolve(await realpath(dirname(out)), basename(out));
  const outInfo = await lstat(out).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (outInfo?.isSymbolicLink() || (outInfo && !outInfo.isFile()))
    throw new Error("Sortie non régulière refusée");
  for (const input of inputs) {
    const file = resolve(input);
    if (file === out || (await realpath(file)) === canonicalOut)
      throw new Error("La sortie ne peut pas remplacer une source");
    const info = await stat(file);
    if (outInfo && info.dev === outInfo.dev && info.ino === outInfo.ino)
      throw new Error("La sortie référence une source");
  }
}
async function atomicOutput(
  inputs: readonly string[],
  output: string,
  extension: string,
  write: (temporary: string) => Promise<void>,
) {
  await assertSeparateOutput(inputs, output);
  const out = resolve(output),
    temp = `${out}.${randomUUID()}.tmp.${extension}`;
  const handle = await open(temp, "wx", 0o600);
  await handle.close();
  try {
    await write(temp);
    await assertSeparateOutput(inputs, output);
    await rename(temp, out);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function mixToWav(
  tracks: readonly ResolvedTrack[],
  out: string,
  settings: MixSettings,
  videoDurationMs: number,
): Promise<void> {
  const parsed = z.array(resolvedTrackSchema).parse(tracks);
  const s = mixSettingsSchema.parse(settings);
  const duration = durationSchema.parse(videoDurationMs);
  for (const t of parsed) await regularFile(resolve(t.assetPath));
  await atomicOutput(
    parsed.map((t) => t.assetPath),
    out,
    "wav",
    async (temp) => {
      const { stderr } = await runAudioProcess(
        "ffmpeg",
        buildMixArgs(parsed, temp, { ...s, videoDurationMs: duration }),
        s,
      );
      if (stderr.trim()) throw new Error(`Échec du mixage audio : ${stderr}`);
    },
  );
}
export async function muxAudio(
  videoPath: string,
  wavPath: string,
  outputMp4: string,
  settings: MixSettings = {},
): Promise<void> {
  const s = mixSettingsSchema.parse(settings);
  const video = resolve(videoPath),
    audio = resolve(wavPath);
  await regularFile(video);
  await regularFile(audio);
  await assertSeparateOutput([video, audio], outputMp4);
  const probe = await readMediaProbe(video, s);
  const stream = probe.streams.find((v) => v.codec_type === "video");
  if (!stream) throw new Error("Aucun flux vidéo à multiplexer");
  const durationMs = durationSchema.parse(
    (stream.duration ?? probe.format.duration) * 1000,
  );
  await atomicOutput([video, audio], outputMp4, "mp4", async (temp) => {
    const { stderr } = await runAudioProcess(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-v",
        "error",
        "-y",
        "-protocol_whitelist",
        "file",
        "-i",
        video,
        "-protocol_whitelist",
        "file",
        "-i",
        audio,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-af",
        "apad",
        "-c:a",
        "aac",
        "-b:a",
        `${s.bitrateKbps}k`,
        "-ar",
        "48000",
        "-ac",
        "2",
        "-t",
        seconds(durationMs),
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        temp,
      ],
      s,
    );
    if (stderr.trim())
      throw new Error(`Échec du multiplexage audio : ${stderr}`);
  });
}
