import { resolve } from "node:path";
import {
  newId,
  parseFrameRate,
  qualityCheckSchema,
  type QualityCheck,
} from "@veyra/schemas";
import { probeVideoStream, streamFrames } from "./stream";

/**
 * Technical flash detection (independent method, loosely inspired by the
 * ITU-R BT.1702 flash guidelines; no conformity claim, saturated red flashes
 * are not evaluated).
 */
export type ColorRange = "limited" | "full";
export const FLASH_THRESHOLDS = {
  /** Assumed display peak luminance (cd/m²). */
  displayNits: 200,
  gamma: 2.2,
  /** Minimum luminance swing of a transition (cd/m²). */
  minDeltaNits: 20,
  /** The darker side of a transition must be below this (cd/m²). */
  darkerBelowNits: 160,
  /** Screen share for a flash to count (major above maxFlashesPerSecond). */
  area: 0.25,
  /** Smaller screen share that still warrants a human check. */
  smallArea: 0.1,
  /** Same-direction transitions are pooled over this window (non-uniform fades). */
  poolingWindowS: 0.1,
  maxFlashesPerSecond: 3,
  /** Above this (and up to the max) on a large area: borderline, human check. */
  borderlineFlashesPerSecond: 2,
} as const;

export interface FlashOptions {
  fps: number;
  width: number;
  height: number;
  colorRange: ColorRange;
  displayNits?: number;
  gamma?: number;
}
export interface FlashEvent {
  frameIndex: number;
  timeMs: number;
  direction: "up" | "down";
  /** Share of the screen that transitioned in this direction over the pooling window. */
  area: number;
}
export interface FlashWindow {
  frameIndex: number;
  startMs: number;
  endMs: number;
  flashesPerSecond: number;
  /** Area threshold of the event series this window comes from. */
  areaThreshold: number;
}
export interface FlashMeasurement {
  measured: true;
  fps: number;
  width: number;
  height: number;
  colorRange: ColorRange;
  framesAnalyzed: number;
  /** Max flashes in any 1 s window, transitions covering ≥ 25 % of the screen. */
  maxFlashesPerSecond: number;
  /** Same, transitions covering ≥ 10 % of the screen. */
  maxFlashesPerSecondSmallArea: number;
  /** Largest share of the screen that transitioned in one direction over the pooling window. */
  maxArea: number;
  worstWindow: FlashWindow | null;
  events: FlashEvent[];
  smallAreaEvents: FlashEvent[];
  severity: "info" | "minor" | "major";
  /** Source colour range as tagged in the file (analyzeFlashes only). */
  sourceColorRange?: string;
  analysisMs?: number;
}
export interface FlashNotMeasured {
  measured: false;
  reason: string;
  fps?: number;
}
export type FlashResult = FlashMeasurement | FlashNotMeasured;

/** Luminance (cd/m²) of an 8-bit luma code under the documented display model. */
export function lumaToNits(
  code: number,
  range: ColorRange,
  displayNits: number = FLASH_THRESHOLDS.displayNits,
  gamma: number = FLASH_THRESHOLDS.gamma,
): number {
  const v = range === "limited" ? (code - 16) / 219 : code / 255;
  return displayNits * Math.min(1, Math.max(0, v)) ** gamma;
}

const MAX_EVENTS = 500;

/** Incremental detector: one frame at a time, memory O(pixels). */
class FlashDetector {
  private readonly pixels: number;
  private readonly lut: Float32Array;
  private readonly ext: Float32Array;
  private readonly low: Float32Array;
  // 0 = no transition yet, 1 = last transition up (tracking max), -1 = down (tracking min)
  private readonly dir: Int8Array;
  private readonly pooling: number;
  private readonly ring: { frame: number; up: number; down: number }[] = [];
  private frame = 0;
  private maxArea = 0;
  private readonly series = [
    FLASH_THRESHOLDS.area,
    FLASH_THRESHOLDS.smallArea,
  ].map((threshold) => ({
    threshold,
    last: 0,
    // Frame of the last event, and per direction the frame up to which transitions are consumed.
    lastFrame: -1,
    sinceUp: -1,
    sinceDown: -1,
    events: [] as FlashEvent[],
  }));

  constructor(private readonly options: FlashOptions) {
    const { fps, width, height, colorRange } = options;
    if (!(fps > 0) || !Number.isInteger(width) || !Number.isInteger(height))
      throw new Error("Invalid flash detection options");
    this.pixels = width * height;
    if (this.pixels <= 0) throw new Error("Invalid frame size");
    this.lut = Float32Array.from({ length: 256 }, (_, code) =>
      lumaToNits(code, colorRange, options.displayNits, options.gamma),
    );
    this.ext = new Float32Array(this.pixels);
    this.low = new Float32Array(this.pixels);
    this.dir = new Int8Array(this.pixels);
    this.pooling = Math.max(
      1,
      Math.round(FLASH_THRESHOLDS.poolingWindowS * fps),
    );
  }

  push(frame: Uint8Array) {
    if (frame.length !== this.pixels)
      throw new Error(`Frame ${this.frame} has ${frame.length} pixels`);
    const { lut, ext, low, dir } = this;
    const delta = FLASH_THRESHOLDS.minDeltaNits,
      dark = FLASH_THRESHOLDS.darkerBelowNits;
    let up = 0,
      down = 0;
    if (this.frame === 0)
      for (let p = 0; p < this.pixels; p++) ext[p] = low[p] = lut[frame[p]];
    else
      for (let p = 0; p < this.pixels; p++) {
        const l = lut[frame[p]];
        const d = dir[p];
        if (d === 1) {
          if (l > ext[p]) ext[p] = l;
          else if (ext[p] - l >= delta && l < dark) {
            down++;
            dir[p] = -1;
            ext[p] = l;
          }
        } else if (d === -1) {
          if (l < ext[p]) ext[p] = l;
          else if (l - ext[p] >= delta && ext[p] < dark) {
            up++;
            dir[p] = 1;
            ext[p] = l;
          }
        } else {
          // Before the first transition, track both extremes (ext = max, low = min).
          if (l > ext[p]) ext[p] = l;
          if (l < low[p]) low[p] = l;
          if (l - low[p] >= delta && low[p] < dark) {
            up++;
            dir[p] = 1;
            ext[p] = l;
          } else if (ext[p] - l >= delta && l < dark) {
            down++;
            dir[p] = -1;
            ext[p] = l;
          }
        }
      }
    this.ring.push({ frame: this.frame, up, down });
    if (this.ring.length > this.pooling) this.ring.shift();
    // Pooled transitions of one direction after `since`, and the part from frame `old`.
    const pooled = (key: "up" | "down", since: number, old: number) => {
      let all = 0,
        early = 0;
      for (const r of this.ring)
        if (r.frame > since) {
          all += r[key];
          if (r.frame === old) early += r[key];
        }
      return { area: Math.min(1, all / this.pixels), early: early / all || 0 };
    };
    this.maxArea = Math.max(
      this.maxArea,
      pooled("up", -1, -1).area,
      pooled("down", -1, -1).area,
    );
    for (const s of this.series) {
      // A transition feeds at most one event (else one white frame or one cut is
      // recounted on each frame of the window). An event made mostly of transitions
      // from the previous event's frame is the opposite change of another region at
      // the same instant (cut between complementary shots): not a new flash half.
      const up = pooled("up", s.sinceUp, s.lastFrame),
        down = pooled("down", s.sinceDown, s.lastFrame);
      const areaUp = up.early >= 0.5 ? 0 : up.area,
        areaDown = down.early >= 0.5 ? 0 : down.area;
      // Only alternating events count: a flash is a pair of opposite transitions.
      const direction =
        s.last !== 1 && areaUp >= s.threshold
          ? 1
          : s.last !== -1 && areaDown >= s.threshold
            ? -1
            : 0;
      if (!direction) continue;
      s.last = direction;
      s.lastFrame = this.frame;
      if (direction === 1) s.sinceUp = this.frame;
      else s.sinceDown = this.frame;
      s.events.push({
        frameIndex: this.frame,
        timeMs: this.timeMs(this.frame),
        direction: direction === 1 ? "up" : "down",
        area: round(direction === 1 ? areaUp : areaDown),
      });
    }
    this.frame++;
  }

  finish(): FlashMeasurement {
    const [large, small] = this.series.map((s) => ({
      ...s,
      worst: worstWindow(s.events, s.threshold),
    }));
    const maxLarge = large.worst?.flashesPerSecond ?? 0,
      maxSmall = small.worst?.flashesPerSecond ?? 0;
    const t = FLASH_THRESHOLDS;
    const severity =
      maxLarge > t.maxFlashesPerSecond
        ? "major"
        : maxLarge > t.borderlineFlashesPerSecond ||
            maxSmall > t.maxFlashesPerSecond
          ? "minor"
          : "info";
    // The window that drove the verdict: large-area series unless only the small one fires.
    const worst =
      maxLarge > t.borderlineFlashesPerSecond || maxSmall <= maxLarge
        ? large.worst
        : small.worst;
    return {
      measured: true,
      fps: this.options.fps,
      width: this.options.width,
      height: this.options.height,
      colorRange: this.options.colorRange,
      framesAnalyzed: this.frame,
      maxFlashesPerSecond: maxLarge,
      maxFlashesPerSecondSmallArea: maxSmall,
      maxArea: round(this.maxArea),
      worstWindow: worst,
      events: large.events.slice(0, MAX_EVENTS),
      smallAreaEvents: small.events.slice(0, MAX_EVENTS),
      severity,
    };
  }

  private timeMs(frame: number) {
    return Math.round((frame * 1000) / this.options.fps);
  }
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Densest 1 s window of alternating events; flashes = transitions / 2. */
function worstWindow(
  events: FlashEvent[],
  areaThreshold: number,
): FlashWindow | null {
  let best: FlashWindow | null = null;
  for (let i = 0, j = 0; j < events.length; j++) {
    while (events[j].timeMs - events[i].timeMs >= 1000) i++;
    const flashesPerSecond = (j - i + 1) / 2;
    if (!best || flashesPerSecond > best.flashesPerSecond)
      best = {
        frameIndex: events[i].frameIndex,
        startMs: events[i].timeMs,
        endMs: events[j].timeMs,
        flashesPerSecond,
        areaThreshold,
      };
  }
  return best;
}

/** Pure flash detection on 8-bit grayscale (luma) frames, row-major, width × height each. */
export function detectFlashes(
  frames: Iterable<Uint8Array>,
  options: FlashOptions,
): FlashMeasurement {
  const detector = new FlashDetector(options);
  for (const frame of frames) detector.push(frame);
  return detector.finish();
}

export interface AnalyzeFlashesOptions {
  timeoutMs?: number;
  /** Decoded frame cap (output size limit); exceeding it fails the analysis. */
  maxFrames?: number;
  /** Pixel budget of the reduced decode (aspect ratio kept). */
  pixelBudget?: number;
}

/** Decodes a reduced grayscale copy with FFmpeg and streams it into the detector. */
export async function analyzeFlashes(
  file: string,
  options: AnalyzeFlashesOptions = {},
): Promise<FlashResult> {
  const started = performance.now();
  const path = resolve(file);
  const timeoutMs = options.timeoutMs ?? 120000;
  const stream = await probeVideoStream(path, timeoutMs);
  if (!stream) return { measured: false, reason: "No video stream" };
  const nominal = parseFrameRate(stream.r_frame_rate ?? "");
  const average = parseFrameRate(stream.avg_frame_rate ?? "");
  // Same CFR criterion as probe(): flash rates need a proven constant frame rate.
  if (
    !nominal ||
    !average ||
    nominal.num * average.den !== average.num * nominal.den
  )
    return {
      measured: false,
      reason: `Constant frame rate not proven (r_frame_rate ${stream.r_frame_rate ?? "?"}, avg_frame_rate ${stream.avg_frame_rate ?? "?"})`,
      ...(average ? { fps: average.num / average.den } : {}),
    };
  const fps = nominal.num / nominal.den;
  const budget = options.pixelBudget ?? 160 * 90;
  const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
  const scale = Math.min(1, Math.sqrt(budget / (stream.width * stream.height)));
  const width = even(stream.width * scale),
    height = even(stream.height * scale);
  const detector = new FlashDetector({
    fps,
    width,
    height,
    // format=gray makes FFmpeg expand limited (or untagged) luma to full range.
    colorRange: "full",
  });
  await streamFrames(
    path,
    [
      "-nostdin",
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-i",
      path,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-vf",
      `scale=${width}:${height}:flags=area,format=gray`,
      "-fps_mode",
      "passthrough",
      "-threads",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    width * height,
    options.maxFrames ?? 60 * 60 * 30,
    timeoutMs,
    (frame) => detector.push(frame),
  );
  return {
    ...detector.finish(),
    sourceColorRange: stream.color_range ?? "unknown",
    analysisMs: Math.round(performance.now() - started),
  };
}

export const PHOTOSENSITIVITY_CHECK_NAME =
  "Photosensibilité (flashs, mesure technique)";
const DISCLAIMER =
  "Méthode inspirée des lignes directrices sur les flashs (ITU-R BT.1702), sans validation de conformité ; flashs rouges saturés non évalués.";

/** Quality check built from a flash analysis (never auto-corrected). */
export function photosensitivityCheck(result: FlashResult): QualityCheck {
  const name = PHOTOSENSITIVITY_CHECK_NAME;
  if (!result.measured)
    return qualityCheckSchema.parse({
      id: newId("qck"),
      name,
      passed: false,
      severity: "minor",
      timestamp: 0,
      evidence: JSON.stringify({
        mesure: "non effectuée",
        raison: result.reason,
        fps: result.fps,
        avertissement: DISCLAIMER,
      }),
      recommendation:
        "Flashs non mesurés : vérifier la vidéo à l'œil ou la ré-encoder à fréquence d'images constante.",
      analysisMode: "not-performed",
    });
  const w = result.worstWindow;
  const events = (
    result.severity === "info" || result.maxFlashesPerSecond > 2
      ? result.events
      : result.smallAreaEvents
  ).slice(0, 20);
  return qualityCheckSchema.parse({
    id: newId("qck"),
    name,
    passed: result.severity === "info",
    severity: result.severity,
    timestamp: w && result.severity !== "info" ? w.startMs : 0,
    evidence: JSON.stringify({
      fps: result.fps,
      imagesAnalysees: result.framesAnalyzed,
      resolutionAnalyse: `${result.width}x${result.height}`,
      maxFlashsParSeconde: result.maxFlashesPerSecond,
      maxFlashsParSecondePetiteSurface: result.maxFlashesPerSecondSmallArea,
      surfaceMax: result.maxArea,
      pireFenetre: w && {
        frame: w.frameIndex,
        debutMs: w.startMs,
        finMs: w.endMs,
        flashsParSeconde: w.flashesPerSecond,
        seuilSurface: w.areaThreshold,
      },
      transitions: events.map((e) => ({
        frame: e.frameIndex,
        ms: e.timeMs,
        sens: e.direction === "up" ? "montée" : "descente",
        surface: e.area,
      })),
      seuils:
        "défaut si > 3 flashs/s sur ≥ 25 % de l'écran ; à vérifier si > 2 flashs/s sur ≥ 25 % ou > 3 flashs/s sur ≥ 10 % ; transition ≥ 20 cd/m² avec côté sombre < 160 cd/m² (affichage supposé 200 cd/m², gamma 2,2)",
      avertissement: DISCLAIMER,
    }),
    recommendation:
      result.severity === "major"
        ? "Réduire les flashs à 3 par seconde au plus (ou sous 25 % de l'écran) puis refaire vérifier par un humain."
        : result.severity === "minor"
          ? "Cas limite : à vérifier par un humain."
          : "No action required",
    analysisMode: "deterministic",
  });
}
