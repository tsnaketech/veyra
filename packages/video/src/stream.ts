import { z } from "zod";
import { mediaPath, ProcessError, runProcess, VIDEO_FORMATS } from "./process";

const streamSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  color_range: z.string().optional(),
  start_time: z.string().optional(),
  nb_frames: z.string().optional(),
});
/** First video stream (lightweight ffprobe, no decode), or null when there is none. */
export async function probeVideoStream(
  path: string,
  timeoutMs: number,
): Promise<z.infer<typeof streamSchema> | null> {
  const { stdout } = await runProcess(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      VIDEO_FORMATS,
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate,r_frame_rate,color_range,start_time,nb_frames",
      "-of",
      "json",
      mediaPath(path),
    ],
    { timeoutMs },
  );
  return (
    z.object({ streams: z.array(streamSchema) }).parse(JSON.parse(stdout))
      .streams[0] ?? null
  );
}

/**
 * Runs ffmpeg writing raw frames of `frameBytes` to stdout and hands them out one by
 * one (the buffer is reused). Timeout and frame cap kill the process group.
 */
export async function streamFrames(
  path: string,
  args: string[],
  frameBytes: number,
  maxFrames: number,
  timeoutMs: number,
  onFrame: (frame: Uint8Array) => void,
): Promise<void> {
  let frames = 0,
    filled = 0;
  const buffer = new Uint8Array(frameBytes);
  await runProcess("ffmpeg", args, {
    timeoutMs,
    label: `ffmpeg on ${path}`,
    onStdout: (chunk) => {
      for (let offset = 0; offset < chunk.length;) {
        const n = Math.min(frameBytes - filled, chunk.length - offset);
        buffer.set(chunk.subarray(offset, offset + n), filled);
        filled += n;
        offset += n;
        if (filled < frameBytes) continue;
        if (++frames > maxFrames)
          throw new Error(`Raw decode exceeded ${maxFrames} frames`);
        onFrame(buffer);
        filled = 0;
      }
    },
  });
  if (filled !== 0) throw new ProcessError("Truncated raw frame");
}
