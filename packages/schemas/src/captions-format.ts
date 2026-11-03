import type {
  CaptionCue,
  CaptionRules,
  CaptionStyle,
  CaptionTiming,
  CaptionTrack,
  CaptionWord,
} from "./captions";
import { captionTimingSchema, isApproximateTiming } from "./captions";
import type { Scene } from "./core";
import { frameDurationMs, type FrameRate } from "./frames";

const NBSP = " ";
const PUNCT_ONLY = /^[\p{P}\p{S}]+$/u;
const OPENING = /^[«“‘([{¿¡]+$/u;

/**
 * Splits narration on whitespace. Punctuation stays attached to its word; a
 * standalone mark (French spacing: « Bonjour ! », 3,5 %) is joined to its
 * neighbour with a no-break space so it never starts or ends a caption line.
 */
export function tokenizeNarration(text: string): string[] {
  const tokens: string[] = [];
  let prefix = "";
  for (const raw of text.split(/\s+/)) {
    if (!raw) continue;
    if (PUNCT_ONLY.test(raw) && (OPENING.test(raw) || !tokens.length)) {
      prefix += raw + NBSP;
    } else if (PUNCT_ONLY.test(raw) && !prefix) {
      tokens[tokens.length - 1] += NBSP + raw;
    } else {
      tokens.push(prefix + raw);
      prefix = "";
    }
  }
  if (prefix) {
    const tail = prefix.slice(0, -1);
    if (tokens.length) tokens[tokens.length - 1] += NBSP + tail;
    else tokens.push(tail);
  }
  return tokens;
}

const WORD_SHARE = 2; // fixed weight per word, in characters (word gap, onset)
const length = (text: string) => [...text].length;

/**
 * Words of each narrated scene spread over [start, start + duration] in
 * proportion to their length. Approximate by construction: timing "scene".
 */
export function sceneFallbackWords(
  scenes: Pick<Scene, "id" | "start" | "duration" | "narration">[],
): CaptionWord[] {
  return scenes.flatMap((scene) => {
    if (!scene.narration) return [];
    const tokens = tokenizeNarration(scene.narration.text);
    const end = scene.start + scene.duration;
    const total = tokens.reduce((sum, t) => sum + length(t) + WORD_SHARE, 0);
    const at = (weight: number) =>
      Math.min(
        end,
        Math.max(
          scene.start,
          Math.round(scene.start + (scene.duration * weight) / total),
        ),
      );
    let weight = 0;
    return tokens.map((text) => {
      const startMs = at(weight);
      weight += length(text) + WORD_SHARE;
      return {
        text,
        startMs,
        endMs: at(weight),
        confidence: null,
        timing: "scene" as const,
        sceneId: scene.id,
      };
    });
  });
}

/** Greedy wrap without splitting words; a word longer than a line gets its own. */
function wrap(words: string[], maxChars: number): string[] {
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last !== undefined && length(last) + 1 + length(word) <= maxChars)
      lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}
const SENTENCE_END = /[.!?…]["»”’)\] ]*$/u;

/**
 * Deterministic greedy grouping of words into cues: never across a scene
 * change, closes after a sentence end once the cue holds two words, keeps
 * maxLines x maxCharsPerLine and maxDurationMs, then extends short cues up to
 * minDurationMs while keeping minGapMs before the next cue. CPS is measured by
 * QA, not enforced here.
 */
export function groupCaptions(
  words: CaptionWord[],
  style: Pick<CaptionStyle, "maxLines" | "maxCharsPerLine">,
  rules: Pick<CaptionRules, "minDurationMs" | "maxDurationMs" | "minGapMs">,
): CaptionCue[] {
  const groups: { start: number; end: number }[] = [];
  const texts = (g: { start: number; end: number }, extra = 0) =>
    words.slice(g.start, g.end + extra).map((w) => w.text);
  let closed = true;
  words.forEach((word, i) => {
    const current = groups.at(-1);
    const fits =
      !closed &&
      current &&
      word.sceneId === words[current.start].sceneId &&
      word.endMs - words[current.start].startMs <= rules.maxDurationMs &&
      wrap(texts(current, 1), style.maxCharsPerLine).length <= style.maxLines;
    if (fits) current.end = i + 1;
    else groups.push({ start: i, end: i + 1 });
    const group = groups.at(-1)!;
    closed = SENTENCE_END.test(word.text) && group.end - group.start >= 2;
  });
  return groups.map((g, i) => {
    const startMs = words[g.start].startMs;
    const natural = words[g.end - 1].endMs;
    const next = groups[i + 1] ? words[groups[i + 1].start].startMs : Infinity;
    const target = Math.min(
      startMs + rules.minDurationMs,
      next - rules.minGapMs,
    );
    let endMs = Math.max(natural, target);
    // Zero-length words: a cue still lasts 1 ms.
    endMs = Math.max(endMs, startMs + 1);
    return {
      id: `cue_${String(i + 1).padStart(4, "0")}`,
      wordStart: g.start,
      wordEnd: g.end,
      startMs,
      endMs,
      lines: wrap(texts(g), style.maxCharsPerLine),
    };
  });
}

export interface QuantizedCue {
  cueId: string;
  startFrame: number;
  /** Exclusive. */
  endFrame: number;
  startMs: number;
  endMs: number;
}
// Tolerance of integer-ms rounding: quantizing the exported ms again gives the same frames.
const TOLERANCE_MS = 0.5;
/** First frame starting at or after `ms` (cue and word snapping rule, ±0.5 ms). */
export const firstFrameAtOrAfter = (ms: number, rate: FrameRate) =>
  // "+ 0" turns the -0 of Math.ceil(-0.0…) into 0.
  Math.ceil(((ms - TOLERANCE_MS) * rate.num) / (1000 * rate.den) - 1e-9) + 0;

/**
 * Snaps cues to the frames of the measured video. This table is the single
 * source for the HyperFrames caption layer AND the SRT/WebVTT export.
 * startFrame is the first frame starting at or after cue.startMs, endFrame
 * (exclusive) the first frame starting at or after cue.endMs, both within
 * [0, frameCount]; every cue keeps at least one frame and never overlaps the
 * previous one. Cues starting after the last frame are dropped. Milliseconds
 * are floored from exact rational frame boundaries: a player shows a cue while
 * start <= t < end at each frame's presentation time, so a rounded-up start
 * (66.733 -> 67 ms at 29.97 fps) would show the caption one frame late.
 */
export function quantizeCues(
  cues: Pick<CaptionCue, "id" | "startMs" | "endMs">[],
  rate: FrameRate,
  frameCount: number,
): QuantizedCue[] {
  const duration = frameDurationMs(rate);
  // 1e-6: 3 * 33.333... must floor to 100, not 99.
  const ms = (frame: number) => Math.floor(frame * duration + 1e-6);
  const out: QuantizedCue[] = [];
  for (const cue of cues) {
    const previous = out.at(-1)?.endFrame ?? 0;
    const startFrame = Math.max(
      previous,
      firstFrameAtOrAfter(cue.startMs, rate),
    );
    if (startFrame >= frameCount) continue;
    const endFrame = Math.min(
      frameCount,
      Math.max(startFrame + 1, firstFrameAtOrAfter(cue.endMs, rate)),
    );
    out.push({
      cueId: cue.id,
      startFrame,
      endFrame,
      startMs: ms(startFrame),
      endMs: ms(endFrame),
    });
  }
  return out;
}

const pad = (n: number, size = 2) => String(n).padStart(size, "0");
function timestamp(ms: number, separator: "," | ".") {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms % 1000, 3)}`;
}
// "-->" would end the text and start a timing line.
const noArrow = (text: string) => text.replace(/-{2,}>/g, "->");
const escapeVtt = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function exportCues(track: CaptionTrack, quantized: QuantizedCue[]) {
  const lines = new Map(track.cues.map((cue) => [cue.id, cue.lines]));
  return quantized.map((q) => {
    const text = lines.get(q.cueId);
    if (!text) throw new Error(`Unknown cue ${q.cueId}`);
    return { ...q, lines: text };
  });
}
export function toSrt(track: CaptionTrack, quantized: QuantizedCue[]): string {
  return exportCues(track, quantized)
    .map(
      (cue, i) =>
        `${i + 1}\n${timestamp(cue.startMs, ",")} --> ${timestamp(cue.endMs, ",")}\n` +
        `${cue.lines.map(noArrow).join("\n")}\n`,
    )
    .join("\n");
}
export function toWebVtt(
  track: CaptionTrack,
  quantized: QuantizedCue[],
): string {
  const cues = exportCues(track, quantized).map(
    (cue) =>
      `${cue.cueId}\n${timestamp(cue.startMs, ".")} --> ${timestamp(cue.endMs, ".")}\n` +
      `${cue.lines.map((line) => escapeVtt(line)).join("\n")}\n`,
  );
  return ["WEBVTT\n", ...cues].join("\n");
}

export interface ParsedCue {
  startMs: number;
  endMs: number;
  lines: string[];
}
const TIME = /(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})/;
const toMs = (match: RegExpExecArray) =>
  Number(match[1] ?? 0) * 3_600_000 +
  Number(match[2]) * 60_000 +
  Number(match[3]) * 1000 +
  Number(match[4]);
// Minimal reader (blocks with a timing line); identifiers, headers and NOTE blocks are skipped.
function parseBlocks(text: string, unescape: (line: string) => string) {
  const cues: ParsedCue[] = [];
  for (const block of text.replace(/^﻿/, "").split(/\r?\n(?:[ \t]*\r?\n)+/)) {
    const rows = block.split(/\r?\n/);
    const at = rows.findIndex((row) => row.includes("-->"));
    if (at < 0) continue;
    const [left, right] = rows[at].split("-->");
    const start = TIME.exec(left);
    const end = TIME.exec(right);
    if (!start || !end) continue;
    cues.push({
      startMs: toMs(start),
      endMs: toMs(end),
      lines: rows
        .slice(at + 1)
        .filter((row) => row.trim())
        .map(unescape),
    });
  }
  return cues;
}
export const parseSrt = (text: string) => parseBlocks(text, (line) => line);
export const parseWebVtt = (text: string) =>
  parseBlocks(text, (line) =>
    line.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
  );

/** Words per timing and the approximate share (asr + scene), for QA and UI. */
export function captionPrecisionSummary(track: Pick<CaptionTrack, "words">) {
  const counts = Object.fromEntries(
    captionTimingSchema.options.map((timing) => [timing, 0]),
  ) as Record<CaptionTiming, number>;
  for (const word of track.words) counts[word.timing] += 1;
  const total = track.words.length;
  const approximate = track.words.filter((w) =>
    isApproximateTiming(w.timing),
  ).length;
  return {
    counts,
    total,
    approximateShare: total ? approximate / total : 0,
  };
}
