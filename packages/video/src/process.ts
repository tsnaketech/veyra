import { spawn } from "node:child_process";
export class ProcessError extends Error {
  constructor(
    message: string,
    public readonly stderrTail: string = "",
    /** Full captured stdout (bounded by maxLogBytes), for CLIs that report JSON and exit non-zero. */
    public readonly stdout: string = "",
  ) {
    super(message);
    this.name = "ProcessError";
  }
}
export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxLogBytes?: number;
  onLine?: (line: string) => void;
  monitor?: () => void;
  /** Name used in error messages instead of the spawned binary (e.g. a wrapper). */
  label?: string;
}
export function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      detached: true,
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      failure: string | undefined;
    const kill = (message: string) => {
      failure ??= message;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(
      () => kill("Process wall-clock timeout"),
      options.timeoutMs ?? 30000,
    );
    const monitor = setInterval(() => {
      try {
        options.monitor?.();
      } catch (error) {
        kill(error instanceof Error ? error.message : "Output limit exceeded");
      }
    }, 50);
    const buffers = { stdout: "", stderr: "" };
    const collect = (kind: "stdout" | "stderr", chunk: Buffer) => {
      bytes += chunk.byteLength;
      const text = chunk.toString("utf8");
      if (kind === "stderr") stderr = (stderr + text).slice(-8192);
      else if (bytes <= (options.maxLogBytes ?? 2 * 1024 * 1024))
        stdout += text;
      if (bytes > (options.maxLogBytes ?? 2 * 1024 * 1024)) {
        kill("Process log size exceeded");
        return;
      }
      buffers[kind] += text;
      const lines = buffers[kind].split(/\r?\n|\r/);
      buffers[kind] = lines.pop() ?? "";
      try {
        for (const line of lines) options.onLine?.(line);
      } catch (error) {
        kill(
          error instanceof Error ? error.message : "Progress callback failed",
        );
      }
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    // Some CLIs (HyperFrames lint) report failures on stdout, so keep both streams.
    const outputTail = () =>
      [stdout.slice(-4096), stderr].filter(Boolean).join("\n").slice(-8192);
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(monitor);
    };
    child.on("error", (error) => {
      cleanup();
      reject(new ProcessError(error.message, outputTail()));
    });
    child.on("close", (code, signal) => {
      cleanup();
      if (failure || code !== 0)
        reject(
          new ProcessError(
            failure ?? `${options.label ?? command} exited ${code ?? signal}`,
            outputTail(),
            stdout,
          ),
        );
      else resolve({ stdout, stderr });
    });
  });
}
