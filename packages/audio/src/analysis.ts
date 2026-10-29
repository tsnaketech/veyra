import { resolve } from "node:path";
import { z } from "zod";
import { fixed } from "./mixing";
import { probeAudio, runAudioProcess } from "./validation";

export const silenceOptionsSchema = z.object({
  noiseDb: z.number().min(-120).max(0).default(-50),
  minSilenceMs: z.number().positive().max(600000).default(500),
});
export type SilenceOptions = z.input<typeof silenceOptionsSchema>;
export interface Silence {
  startMs: number;
  endMs: number;
}
export interface AudioAnalysis {
  codec: string;
  sampleRate: number;
  channels: number;
  durationMs: number;
  integratedLufs: number;
  truePeakDb: number;
  peakDb: number;
  clippedSamples: number;
  silences: Silence[];
}
const numeric = "([-+]?(?:\\d+(?:\\.\\d*)?(?:e[-+]?\\d+)?|inf))";
function measured(text: string | undefined, name: string): number {
  if (text === undefined) throw new Error(`Mesure audio illisible : ${name}`);
  const value = text.toLowerCase() === "-inf" ? -Infinity : Number(text);
  if (Number.isNaN(value) || value === Infinity)
    throw new Error(`Mesure audio illisible : ${name}`);
  return value;
}
export function parseSilences(
  lines: readonly string[],
  durationMs: number,
): Silence[] {
  const silences: Silence[] = [];
  let start: number | undefined;
  for (const line of lines) {
    if (!line.includes("silencedetect")) continue;
    const a = new RegExp(`silence_start:\\s*${numeric}`, "i").exec(line);
    const b = new RegExp(`silence_end:\\s*${numeric}`, "i").exec(line);
    if (
      (line.includes("silence_start:") && !a) ||
      (line.includes("silence_end:") && !b)
    )
      throw new Error("Mesure audio illisible : silence");
    if (a) start = Math.max(0, measured(a[1], "silence_start") * 1000);
    if (b) {
      if (start === undefined)
        throw new Error("Fin de silence sans début mesuré");
      const endMs = Math.min(durationMs, measured(b[1], "silence_end") * 1000);
      if (endMs < start) throw new Error("Intervalle de silence invalide");
      silences.push({ startMs: start, endMs });
      start = undefined;
    }
  }
  if (start !== undefined) silences.push({ startMs: start, endMs: durationMs });
  return silences;
}
/** Parse summaries, not per-frame ebur128 values; no fallback measurements. */
export function parseAudioMeasurements(
  lines: readonly string[],
  durationMs: number,
): Pick<
  AudioAnalysis,
  "integratedLufs" | "truePeakDb" | "peakDb" | "clippedSamples" | "silences"
> {
  const text = lines.join("\n");
  const summary = text.slice(text.lastIndexOf("Summary:"));
  const integratedLufs = measured(
    new RegExp(`I:\\s*${numeric}\\s+LUFS`, "i").exec(summary)?.[1],
    "LUFS intégré",
  );
  const truePeakDb = measured(
    new RegExp(`Peak:\\s*${numeric}\\s+dBFS`, "i").exec(summary)?.[1],
    "true peak",
  );
  const astats = lines.filter((l) => l.includes("astats"));
  const overallIndex = astats
    .map((line) => line.includes("Overall"))
    .lastIndexOf(true);
  if (overallIndex < 0)
    throw new Error("Mesure audio illisible : résumé astats");
  const overall = astats.slice(overallIndex).join("\n");
  const peakDb = measured(
    new RegExp(`Peak level dB:\\s*${numeric}`, "i").exec(overall)?.[1],
    "crête",
  );
  const clipped = /Number[_ ]of[_ ]clipped[_ ]samples:\s*(\d+)/i.exec(overall);
  let clippedSamples: number;
  if (clipped) clippedSamples = measured(clipped[1], "échantillons écrêtés");
  else {
    // Peak count is meaningful as a clipping estimate only at or above 0 dBFS.
    const channelBlocks = astats
      .join("\n")
      .split(/Channel:\s*\d+/)
      .slice(1)
      .map((b) => b.split("Overall")[0]);
    if (!channelBlocks.length)
      throw new Error("Mesure audio illisible : canaux astats");
    clippedSamples = channelBlocks.reduce((sum, block) => {
      const peak = measured(
        new RegExp(`Peak level dB:\\s*${numeric}`, "i").exec(block)?.[1],
        "crête par canal",
      );
      const count = measured(
        new RegExp(`Peak count:\\s*${numeric}`, "i").exec(block)?.[1],
        "peak_count",
      );
      if (!Number.isFinite(count) || count < 0)
        throw new Error("Mesure audio illisible : peak_count");
      return sum + (peak >= 0 ? count : 0);
    }, 0);
  }
  return {
    integratedLufs,
    truePeakDb,
    peakDb,
    clippedSamples,
    silences: parseSilences(lines, durationMs),
  };
}
async function filterLines(path: string, filters: string): Promise<string[]> {
  const lines: string[] = [];
  await runAudioProcess(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-nostats",
      "-v",
      "info",
      "-protocol_whitelist",
      "file",
      "-i",
      resolve(path),
      "-map",
      "0:a:0",
      "-af",
      filters,
      "-f",
      "null",
      "-",
    ],
    {},
    (line) => {
      lines.push(line);
    },
  );
  return lines;
}
const silenceFilter = (s: z.infer<typeof silenceOptionsSchema>) =>
  `silencedetect=noise=${fixed(s.noiseDb)}dB:d=${fixed(s.minSilenceMs / 1000)}`;
export async function analyzeAudio(
  path: string,
  options: SilenceOptions = {},
): Promise<AudioAnalysis> {
  const s = silenceOptionsSchema.parse(options),
    meta = await probeAudio(path);
  const lines = await filterLines(
    path,
    `ebur128=peak=true,astats=metadata=0:reset=0,${silenceFilter(s)}`,
  );
  return {
    codec: meta.codec,
    sampleRate: meta.sampleRate,
    channels: meta.channels,
    durationMs: meta.durationMs,
    ...parseAudioMeasurements(lines, meta.durationMs),
  };
}
export async function detectOnsets(
  path: string,
  options: SilenceOptions = {},
): Promise<number[]> {
  const s = silenceOptionsSchema.parse(options),
    meta = await probeAudio(path);
  const silences = parseSilences(
    await filterLines(path, silenceFilter(s)),
    meta.durationMs,
  );
  // A silence beginning at the first sample suppresses the initial onset.
  const startsLoud =
    !silences.length || silences[0].startMs > 1000 / meta.sampleRate;
  return [
    ...(startsLoud ? [0] : []),
    ...silences
      .filter((s) => s.endMs < meta.durationMs - 1000 / meta.sampleRate)
      .map((s) => s.endMs),
  ];
}
export async function meanVolumeDb(
  path: string,
  startMs: number,
  endMs: number,
): Promise<number> {
  const range = z
    .object({ start: z.number().nonnegative(), end: z.number().positive() })
    .refine((r) => r.end > r.start)
    .parse({ start: startMs, end: endMs });
  const metadata = await probeAudio(path);
  if (range.end > metadata.durationMs)
    throw new Error("Plage de mesure hors du média");
  const lines = await filterLines(
    path,
    `atrim=start=${fixed(range.start / 1000)}:end=${fixed(range.end / 1000)},volumedetect`,
  );
  return measured(
    new RegExp(`mean_volume:\\s*${numeric}\\s+dB`, "i").exec(
      lines.join("\n"),
    )?.[1],
    "volume moyen",
  );
}
