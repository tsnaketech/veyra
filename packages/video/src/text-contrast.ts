import { resolve } from "node:path";
import {
  frameAt,
  frameSeekSeconds,
  newId,
  parseFrameRate,
  qualityCheckSchema,
  type QualityCheck,
} from "@veyra/schemas";
import { VIDEO_FORMATS } from "./process";
import { probeVideoStream, streamFrames } from "./stream";

/**
 * Contrast re-measured on the rendered picture, only inside the DOM boxes that
 * `hyperframes check` reports as failing (`contrast_aa_failure`). Zones are never
 * guessed from pixels. Independent method: WCAG 2.x luminance, Otsu split.
 */
export const CONTRAST_LIMITS = {
  minHeightPx: 6,
  minAreaPx: 40,
  /** Accepted share of "ink" pixels in the box. */
  minInkShare: 0.02,
  maxInkShare: 0.7,
  /** Between-class / total variance below this: no clear text/background split. */
  minSeparation: 0.5,
  /** Background p90/p10 contrast above this: heterogeneous background, low confidence. */
  maxBackgroundSpread: 1.5,
  maxZones: 20,
} as const;

/** Subset of a HyperFrames contrast finding (structurally compatible). */
export interface ContrastZone {
  code?: string;
  severity?: string;
  text?: string;
  selector?: string;
  fg?: string;
  bg?: string;
  ratio?: number;
  requiredRatio?: number;
  large?: boolean;
  /** Seconds; the box is only valid at this instant. */
  time?: number;
  times?: number[];
  /** Composition CSS pixels. */
  bbox?: { x: number; y: number; width: number; height: number };
}
export interface ContrastSection {
  checked?: number;
  passed?: number;
  findings?: ContrastZone[];
}
export type PixelContrast =
  | {
      status: "measured";
      ratio: number;
      inkLuminance: number;
      backgroundLuminance: number;
      inkShare: number;
      separation: number;
      backgroundSpread: number;
      confidence: "normal" | "low";
      notes: string[];
    }
  | { status: "unmeasurable"; reason: string };
export interface ContrastSample {
  timeMs: number;
  frameIndex?: number;
  result: PixelContrast;
}
export interface ZoneMeasurement {
  text?: string;
  selector?: string;
  timeMs?: number;
  frameIndex?: number;
  hfRatio?: number;
  requiredRatio: number;
  transient: boolean;
  crop?: { x: number; y: number; width: number; height: number };
  /** Chosen sample (best reliable ratio); `timeMs`/`frameIndex` are its instant. */
  result: PixelContrast;
  /** Every instant measured for this box. */
  samples: ContrastSample[];
  /** Reliable ratios differ by more than 20 %. */
  variable: boolean;
}

const channel = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
/** WCAG 2.x relative luminance of an sRGB colour (0–255 channels). */
export function relativeLuminance(r: number, g: number, b: number) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
export const contrastRatio = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
/** `rgb(r,g,b)` / `rgba(r,g,b,a)` / `#rrggbb` → [r, g, b], or null. */
export function parseCssColor(value: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(
    value.trim(),
  );
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

const round = (value: number, digits = 3) =>
  Math.round(value * 10 ** digits) / 10 ** digits;
const quantile = (sorted: Float64Array, q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/**
 * Pure measurement on an RGB24 crop: Otsu split of WCAG luminance; the ink class is
 * the one whose median is closest to the DOM text colour; ratio of class medians.
 */
export function contrastFromPixels(
  rgb: Uint8Array,
  width: number,
  height: number,
  fgHint?: string,
): PixelContrast {
  const n = width * height;
  if (rgb.length !== n * 3) throw new Error("RGB buffer size mismatch");
  if (height < CONTRAST_LIMITS.minHeightPx || n < CONTRAST_LIMITS.minAreaPx)
    return {
      status: "unmeasurable",
      reason: `boîte trop petite (${width}×${height} px)`,
    };
  const lum = new Float64Array(n);
  const bins = 4096;
  const hist = new Float64Array(bins);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const l = relativeLuminance(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]);
    lum[i] = l;
    sum += l;
    hist[Math.min(bins - 1, Math.floor(l * bins))]++;
  }
  const mean = sum / n;
  let total = 0;
  for (const l of lum) total += (l - mean) ** 2;
  total /= n;
  if (total < 1e-8)
    return { status: "unmeasurable", reason: "boîte uniforme (aucun texte)" };
  // Otsu on the histogram (bin centres).
  let best = -1,
    threshold = 0,
    w0 = 0,
    s0 = 0;
  const centre = (b: number) => (b + 0.5) / bins;
  let sAll = 0;
  for (let b = 0; b < bins; b++) sAll += hist[b] * centre(b);
  for (let b = 0; b < bins - 1; b++) {
    w0 += hist[b];
    s0 += hist[b] * centre(b);
    if (w0 === 0 || w0 === n) continue;
    const m0 = s0 / w0,
      m1 = (sAll - s0) / (n - w0);
    const between = (w0 / n) * (1 - w0 / n) * (m0 - m1) ** 2;
    if (between > best) {
      best = between;
      threshold = (b + 1) / bins;
    }
  }
  const dark: number[] = [],
    light: number[] = [];
  for (const l of lum) (l < threshold ? dark : light).push(l);
  const darkSorted = Float64Array.from(dark).sort(),
    lightSorted = Float64Array.from(light).sort();
  const mDark = quantile(darkSorted, 0.5),
    mLight = quantile(lightSorted, 0.5);
  const fg = fgHint ? parseCssColor(fgHint) : null;
  const notes: string[] = [];
  let inkIsLight: boolean;
  if (fg) {
    const lf = relativeLuminance(...fg);
    inkIsLight = Math.abs(mLight - lf) < Math.abs(mDark - lf);
  } else {
    inkIsLight = light.length < dark.length;
    notes.push("couleur DOM absente : encre = classe minoritaire");
  }
  const ink = inkIsLight ? lightSorted : darkSorted,
    background = inkIsLight ? darkSorted : lightSorted;
  const inkShare = ink.length / n;
  const separation = best / total;
  if (
    inkShare < CONTRAST_LIMITS.minInkShare ||
    inkShare > CONTRAST_LIMITS.maxInkShare
  )
    return {
      status: "unmeasurable",
      reason: `part d'encre ${round(inkShare * 100, 1)} % hors [2 %, 70 %]`,
    };
  if (separation < CONTRAST_LIMITS.minSeparation)
    return {
      status: "unmeasurable",
      reason: `séparation texte/fond faible (${round(separation, 2)} < ${CONTRAST_LIMITS.minSeparation})`,
    };
  const backgroundSpread = contrastRatio(
    quantile(background, 0.9),
    quantile(background, 0.1),
  );
  const heterogeneous = backgroundSpread > CONTRAST_LIMITS.maxBackgroundSpread;
  if (heterogeneous) notes.push("fond hétérogène, confiance faible");
  const inkLuminance = quantile(ink, 0.5),
    backgroundLuminance = quantile(background, 0.5);
  return {
    status: "measured",
    ratio: round(contrastRatio(inkLuminance, backgroundLuminance), 2),
    inkLuminance: round(inkLuminance, 4),
    backgroundLuminance: round(backgroundLuminance, 4),
    inkShare: round(inkShare),
    separation: round(separation),
    backgroundSpread: round(backgroundSpread, 2),
    confidence: heterogeneous ? "low" : "normal",
    notes,
  };
}

/** Composition box → video pixel crop, rounded outwards and clamped; null when off-picture. */
export function cropBox(
  bbox: NonNullable<ContrastZone["bbox"]>,
  composition: { width: number; height: number },
  video: { width: number; height: number },
) {
  const sx = video.width / composition.width,
    sy = video.height / composition.height;
  const x0 = Math.max(0, Math.floor(bbox.x * sx)),
    y0 = Math.max(0, Math.floor(bbox.y * sy)),
    x1 = Math.min(video.width, Math.ceil((bbox.x + bbox.width) * sx)),
    y1 = Math.min(video.height, Math.ceil((bbox.y + bbox.height) * sy));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export interface MeasureTextContrastOptions {
  compositionWidth: number;
  compositionHeight: number;
  timeoutMs?: number;
}

export const MAX_INSTANTS_PER_ZONE = 5;
/** Spread of reliable ratios (max/min − 1) above which a zone is labelled variable. */
export const VARIABLE_RATIO_SPREAD = 0.2;

const reliable = (r: PixelContrast) =>
  r.status === "measured" && r.confidence === "normal";

/**
 * Picks a zone's verdict among its samples: the best reliable ratio (a text fails
 * only if it stays below the floor at its most legible instant); otherwise a
 * low-confidence measurement, otherwise the first sample.
 */
export function pickZoneSample(samples: ContrastSample[]): {
  sample: ContrastSample;
  variable: boolean;
} {
  if (!samples.length) throw new Error("No contrast sample");
  const ratios = samples.flatMap((s) =>
    reliable(s.result) && s.result.status === "measured"
      ? [{ s, ratio: s.result.ratio }]
      : [],
  );
  if (ratios.length) {
    const best = ratios.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    const min = Math.min(...ratios.map((r) => r.ratio));
    return {
      sample: best.s,
      variable: best.ratio / min - 1 > VARIABLE_RATIO_SPREAD,
    };
  }
  return {
    sample: samples.find((s) => s.result.status === "measured") ?? samples[0],
    variable: false,
  };
}

/**
 * Re-measures each zone's box at `time` and at each instant of `times` (deduplicated,
 * at most 5). The DOM box is the one HyperFrames read at `time`, assumed fixed at the
 * other instants: the guards reject crops that no longer frame the text.
 */
export async function measureTextContrast(
  videoPath: string,
  zones: ContrastZone[],
  options: MeasureTextContrastOptions,
): Promise<ZoneMeasurement[]> {
  const path = resolve(videoPath);
  const timeoutMs = options.timeoutMs ?? 30000;
  const stream = await probeVideoStream(path, timeoutMs);
  if (!stream) throw new Error("No video stream");
  const rate = parseFrameRate(stream.r_frame_rate ?? "");
  const count = stream.nb_frames ? Number(stream.nb_frames) : Infinity;
  const out: ZoneMeasurement[] = [];
  for (const [i, zone] of zones.entries()) {
    const base = {
      text: zone.text,
      selector: zone.selector,
      hfRatio: zone.ratio,
      requiredRatio: zone.requiredRatio ?? (zone.large ? 3 : 4.5),
      transient: zone.severity === "warning",
    };
    const fail = (
      reason: string,
      extra: Partial<ContrastSample> & { crop?: ZoneMeasurement["crop"] } = {},
    ) => {
      const sample = {
        timeMs: extra.timeMs ?? 0,
        frameIndex: extra.frameIndex,
        result: { status: "unmeasurable", reason } as const,
      };
      out.push({
        ...base,
        timeMs: extra.timeMs,
        frameIndex: extra.frameIndex,
        crop: extra.crop,
        result: sample.result,
        samples: extra.timeMs === undefined ? [] : [sample],
        variable: false,
      });
    };
    if (i >= CONTRAST_LIMITS.maxZones) {
      fail(`au-delà de ${CONTRAST_LIMITS.maxZones} zones`);
      continue;
    }
    if (!zone.bbox || zone.time === undefined || !(zone.time >= 0)) {
      fail("boîte ou instant absent du constat HyperFrames");
      continue;
    }
    const firstMs = Math.round(zone.time * 1000);
    const firstFrame = rate ? frameAt(firstMs, rate, count) : undefined;
    const crop = cropBox(
      zone.bbox,
      { width: options.compositionWidth, height: options.compositionHeight },
      stream,
    );
    if (!crop) {
      fail("boîte hors image", { timeMs: firstMs, frameIndex: firstFrame });
      continue;
    }
    if (
      crop.height < CONTRAST_LIMITS.minHeightPx ||
      crop.width * crop.height < CONTRAST_LIMITS.minAreaPx
    ) {
      fail(`boîte trop petite (${crop.width}×${crop.height} px)`, {
        timeMs: firstMs,
        frameIndex: firstFrame,
        crop,
      });
      continue;
    }
    // `time` first, then the other failing instants; one sample per distinct frame.
    const instants = new Map<string, { timeMs: number; frameIndex?: number }>();
    for (const t of [zone.time, ...(zone.times ?? [])]) {
      if (!(t >= 0) || instants.size >= MAX_INSTANTS_PER_ZONE) continue;
      const timeMs = Math.round(t * 1000);
      const frameIndex = rate ? frameAt(timeMs, rate, count) : undefined;
      const key = String(frameIndex ?? timeMs);
      if (!instants.has(key)) instants.set(key, { timeMs, frameIndex });
    }
    const samples: ContrastSample[] = [];
    for (const { timeMs, frameIndex } of instants.values()) {
      // Input -ss drops frames whose pts is before the target: aim half a frame early.
      const seek =
        rate && frameIndex !== undefined
          ? frameIndex === 0
            ? 0
            : frameSeekSeconds(frameIndex - 1, rate)
          : timeMs / 1000;
      let pixels: Uint8Array | null = null;
      await streamFrames(
        path,
        [
          "-nostdin",
          "-v",
          "error",
          "-protocol_whitelist",
          "file",
          "-format_whitelist",
          VIDEO_FORMATS,
          "-ss",
          String(seek),
          "-i",
          path,
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-vf",
          `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}:exact=1,format=rgb24`,
          "-threads",
          "1",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        crop.width * crop.height * 3,
        1,
        timeoutMs,
        (frame) => {
          pixels = Uint8Array.from(frame);
        },
      );
      samples.push({
        timeMs,
        frameIndex,
        result: pixels
          ? contrastFromPixels(pixels, crop.width, crop.height, zone.fg)
          : {
              status: "unmeasurable",
              reason: "image introuvable à cet instant",
            },
      });
    }
    const { sample, variable } = pickZoneSample(samples);
    out.push({
      ...base,
      timeMs: sample.timeMs,
      frameIndex: sample.frameIndex,
      crop,
      result: sample.result,
      samples,
      variable,
    });
  }
  return out;
}

export const TEXT_CONTRAST_CHECK_NAME = "Contraste mesuré sur l'image rendue";

/** Check from the re-measured zones; the HyperFrames WCAG check stays the primary (major) one. */
export function textContrastCheck(
  measurements: ZoneMeasurement[],
  section: ContrastSection | undefined,
): QualityCheck {
  // HyperFrames counts element × sample checks, not texts.
  const hfCoverage = `HyperFrames a fait ${section?.checked ?? "?"} vérifications élément × instant (${section?.passed ?? "?"} réussies) ; les textes qui réussissent ne sont pas exposés et ne sont pas remesurés`;
  const notPerformed = (
    evidence: unknown,
    severity: "info" | "minor",
  ): QualityCheck =>
    qualityCheckSchema.parse({
      id: newId("qck"),
      name: TEXT_CONTRAST_CHECK_NAME,
      passed: false,
      severity,
      timestamp: 0,
      evidence:
        typeof evidence === "string" ? evidence : JSON.stringify(evidence),
      recommendation:
        severity === "info"
          ? "No action required"
          : "Vérifier le contraste à l'œil sur les images concernées.",
      analysisMode: "not-performed",
    });
  if (!section)
    return notPerformed(
      "Non mesuré : contrôle de contraste HyperFrames indisponible (aucune zone de texte connue).",
      "minor",
    );
  if (!measurements.length)
    return notPerformed(
      `Non mesuré : HyperFrames n'expose aucune zone (${hfCoverage}).`,
      "info",
    );
  const label = (r: PixelContrast, transient: boolean) =>
    r.status === "measured"
      ? transient
        ? "transitoire"
        : "mesuré"
      : `non mesurable : ${r.reason}`;
  const zones = measurements.map((m) => ({
    texte: m.text,
    frame: m.frameIndex,
    tempsMs: m.timeMs,
    ratioMesure: m.result.status === "measured" ? m.result.ratio : null,
    ratioHyperFrames: m.hfRatio,
    requis: m.requiredRatio,
    statut: label(m.result, m.transient),
    ...(m.result.status === "measured"
      ? {
          confiance: m.result.confidence === "low" ? "faible" : "normale",
          notes: [
            ...m.result.notes,
            ...(m.result.confidence === "low" ? ["hors verdict"] : []),
            ...(m.variable ? ["variable (animation probable)"] : []),
          ],
        }
      : {}),
    mesures: m.samples.map((s) => ({
      frame: s.frameIndex,
      ms: s.timeMs,
      ratio: s.result.status === "measured" ? s.result.ratio : null,
      statut:
        s.result.status === "measured"
          ? s.result.confidence === "low"
            ? "mesuré (confiance faible)"
            : "mesuré"
          : `non mesurable : ${s.result.reason}`,
    })),
  }));
  const measured = measurements.filter((m) => m.result.status === "measured");
  const trusted = measurements.filter((m) => reliable(m.result));
  const evidence = {
    couverture: `${measured.length} zones remesurées ; ${hfCoverage}`,
    zonesFiables: trusted.length,
    zones,
    methode:
      "Luminance relative WCAG 2.x par pixel dans la boîte DOM fournie par HyperFrames ; boîte relevée à l'instant `time`, supposée fixe aux autres instants en échec (`times`, 5 au plus ; les garde-fous rejettent les rognages incohérents) ; seuil d'Otsu ; encre = classe la plus proche de la couleur DOM ; ratio des médianes ; ratio retenu = meilleur ratio fiable de la zone ; mesures à confiance faible exclues du verdict",
  };
  if (!trusted.length)
    return notPerformed(
      {
        ...evidence,
        raison: "aucune zone n'a de mesure fiable (confiance normale)",
      },
      "minor",
    );
  const ratioOf = (m: ZoneMeasurement) =>
    m.result.status === "measured" ? m.result.ratio / m.requiredRatio : 1;
  const worst = trusted.reduce((a, b) => (ratioOf(b) < ratioOf(a) ? b : a));
  const passed = trusted.every((m) => ratioOf(m) >= 1);
  return qualityCheckSchema.parse({
    id: newId("qck"),
    name: TEXT_CONTRAST_CHECK_NAME,
    passed,
    severity: passed ? "info" : "minor",
    timestamp: passed ? 0 : (worst.timeMs ?? 0),
    evidence: JSON.stringify(evidence),
    recommendation: passed
      ? "No action required"
      : "Augmenter le contraste du texte (voir aussi « Lisibilité (contraste WCAG AA) »).",
    analysisMode: "deterministic",
  });
}
