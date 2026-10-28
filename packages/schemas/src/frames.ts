// Frame indexing for constant-frame-rate media. Rates are rationals (e.g. 30000/1001)
// so fractional NTSC rates do not drift; times are milliseconds from the first frame.
export interface FrameRate {
  num: number;
  den: number;
}
const EPSILON = 1e-9;

export function parseFrameRate(value: string): FrameRate | null {
  const match = /^(\d+)(?:\/(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const num = Number(match[1]);
  const den = Number(match[2] ?? 1);
  return num > 0 && den > 0 ? { num, den } : null;
}
export const frameDurationMs = ({ num, den }: FrameRate) => (1000 * den) / num;

/** Number of frames whose start lies inside [0, durationMs). */
export function frameCount(durationMs: number, rate: FrameRate) {
  return Math.max(0, Math.round((durationMs * rate.num) / (1000 * rate.den)));
}
/** Index of the frame displayed at `ms`, clamped to the media. */
export function frameAt(
  ms: number,
  rate: FrameRate,
  count: number,
  startMs = 0,
) {
  const index = Math.floor(
    ((ms - startMs) * rate.num) / (1000 * rate.den) + EPSILON,
  );
  return Math.min(Math.max(0, index), Math.max(0, count - 1));
}
/** Integer millisecond that is guaranteed to fall inside frame `index`. */
export function frameTimestampMs(index: number, rate: FrameRate, startMs = 0) {
  return Math.ceil(startMs + index * frameDurationMs(rate) - EPSILON);
}
/** Seek target in seconds: the middle of the frame, so decoders land on it. */
export function frameSeekSeconds(index: number, rate: FrameRate, startMs = 0) {
  return (startMs + (index + 0.5) * frameDurationMs(rate)) / 1000;
}
export function stepFrame(index: number, delta: number, count: number) {
  return Math.min(Math.max(0, index + delta), Math.max(0, count - 1));
}
/** Index of a frame from its presentation timestamp (rounded: PTS may be truncated to µs). */
export function frameFromPts(ptsMs: number, rate: FrameRate, count: number) {
  const index = Math.round((ptsMs * rate.num) / (1000 * rate.den));
  return Math.min(Math.max(0, index), Math.max(0, count - 1));
}
