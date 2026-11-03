import { spawn } from "node:child_process";
import { z } from "zod";
import { ProcessError, runProcess } from "./process";

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
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate,r_frame_rate,color_range,start_time,nb_frames",
      "-of",
      "json",
      path,
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
export function streamFrames(
  path: string,
  args: string[],
  frameBytes: number,
  maxFrames: number,
  timeoutMs: number,
  onFrame: (frame: Uint8Array) => void,
): Promise<void> {
  return new Promise((done, reject) => {
    const child = spawn("ffmpeg", args, {
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failure: string | undefined,
      stderr = "",
      frames = 0,
      filled = 0;
    const buffer = new Uint8Array(frameBytes);
    const kill = (message: string) => {
      failure ??= message;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(
      () => kill("Raw decode wall-clock timeout"),
      timeoutMs,
    );
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      try {
        for (let offset = 0; offset < chunk.length;) {
          const n = Math.min(frameBytes - filled, chunk.length - offset);
          buffer.set(chunk.subarray(offset, offset + n), filled);
          filled += n;
          offset += n;
          if (filled < frameBytes) continue;
          if (++frames > maxFrames)
            return kill(`Raw decode exceeded ${maxFrames} frames`);
          onFrame(buffer);
          filled = 0;
        }
      } catch (error) {
        kill(error instanceof Error ? error.message : "Raw decode failed");
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProcessError(error.message, stderr));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure || code !== 0)
        reject(
          new ProcessError(
            failure ?? `ffmpeg exited ${code ?? signal} on ${path}`,
            stderr,
          ),
        );
      else if (filled !== 0)
        reject(new ProcessError("Truncated raw frame", stderr));
      else done();
    });
  });
}
