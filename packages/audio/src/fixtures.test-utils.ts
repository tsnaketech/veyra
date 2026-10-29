import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runProcess } from "@veyra/video";
import type { ResolvedTrack } from "./schemas";
export async function fixtures() {
  const dir = await mkdtemp(join(tmpdir(), "veyra-audio-"));
  const tone = async (name: string, duration = 0.5, filter = "anull") => {
    const path = join(dir, name);
    await runProcess("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=880:sample_rate=48000:duration=${duration}`,
      "-af",
      filter,
      "-ac",
      "2",
      "-threads",
      "1",
      path,
    ]);
    return path;
  };
  const video = async (name = "video.mp4") => {
    const path = join(dir, name);
    await runProcess("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x64:r=30:d=3",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    return path;
  };
  return {
    dir,
    tone,
    video,
    clean: () => rm(dir, { recursive: true, force: true }),
  };
}
export const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
export const track = (
  assetPath: string,
  patch: Partial<ResolvedTrack> = {},
): ResolvedTrack => ({
  trackId: "atr_test",
  category: "sfx",
  assetPath,
  startMs: 0,
  sourceInMs: 0,
  playMs: 500,
  gainDb: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
  loop: false,
  duck: [],
  ...patch,
});
