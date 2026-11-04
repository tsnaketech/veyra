import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
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
export interface ProcessLimits {
  cpuSeconds: number;
  fileSizeBytes: number;
  /** RLIMIT_AS; omit for Chrome/HyperFrames (large virtual reservations). */
  addressSpaceBytes?: number;
}
export interface ProcessOptions {
  cwd?: string;
  /**
   * Additions to the minimal child environment (never the parent's). Keys must be in
   * CHILD_ENV_KEYS and must not look like a secret; undefined values are dropped.
   */
  env?: Record<string, string | undefined>;
  /** prlimit wrapper; defaults to MEDIA_LIMITS for ffmpeg/ffprobe, none otherwise. */
  limits?: ProcessLimits | false;
  timeoutMs?: number;
  maxLogBytes?: number;
  onLine?: (line: string) => void;
  /** Raw stdout consumer (binary streams): stdout is then neither kept nor counted. */
  onStdout?: (chunk: Buffer) => void;
  monitor?: () => void;
  /** Name used in error messages instead of the spawned binary (e.g. a wrapper). */
  label?: string;
}
/** Backstop limits for media tools; wall timeouts stay the primary bound. */
export const MEDIA_LIMITS: ProcessLimits = {
  cpuSeconds: 600,
  fileSizeBytes: 2 * 1024 ** 3,
  addressSpaceBytes: 8 * 1024 ** 3,
};
/** The only variables a child may receive besides PATH and LANG (PATH is fixed). */
export const CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "HYPERFRAMES_TELEMETRY",
  "HYPERFRAMES_SKIP_SKILLS",
  "DO_NOT_TRACK",
  "CLAUDE_CONFIG_DIR",
] as const;
/**
 * Demuxers a file input may select (`-format_whitelist`, T136b): playlists (hls),
 * concat lists and other demuxers that open further files are refused before decoding.
 * Media defaults to the audio import formats of config/audio.yaml (wav, mp3, flac,
 * ogg, the mov family, aiff); renders and previews narrow to the mov family.
 */
export const MEDIA_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,wav,mp3,flac,ogg,aiff";
export const VIDEO_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2";
export const IMAGE_FORMATS = "png_pipe";
const MEDIA_TOOLS = ["ffmpeg", "ffprobe"];
/** Fixed child PATH: node's own directory and system dirs, never the parent's PATH. */
const CHILD_PATH = [
  ...new Set([dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"]),
].join(":");
let testPathPrefix: string | undefined;
/**
 * Test-only: prepends `dir` to the fixed child PATH (recording shims). Throws outside
 * Vitest, so production code can never widen the child PATH.
 */
export function setChildPathPrefixForTests(dir: string | undefined) {
  if (!process.env.VITEST) throw new Error("Test-only hook outside Vitest");
  testPathPrefix = dir;
}
const SECRET_KEY =
  /^(?:ANTHROPIC_|CLAUDE_CODE_|AWS_|GITHUB_|OPENAI_)|(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS?)$/i;
const SHELLS = /^(?:a|ba|da|k|mk|tc|z|c|fi|yo)?sh$|^(?:env|busybox|xargs)$/;
/**
 * Builds a child environment from the allow-list only; the parent environment is
 * never inherited. Throws on a secret-looking or unlisted key.
 */
export function childEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: testPathPrefix ? `${testPathPrefix}:${CHILD_PATH}` : CHILD_PATH,
    LANG: "C",
  };
  for (const [key, value] of Object.entries(extra)) {
    if (SECRET_KEY.test(key))
      throw new Error(
        `Refused secret-like variable ${key} for a child process`,
      );
    if (!(CHILD_ENV_KEYS as readonly string[]).includes(key))
      throw new Error(`Variable ${key} is not allowed for a child process`);
    if (value !== undefined) env[key] = value;
  }
  return env;
}
export function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  // Validation errors throw synchronously inside the promise, so callers see a rejection.
  return new Promise((resolve, reject) => {
    if (!command || command.startsWith("-") || SHELLS.test(basename(command)))
      throw new Error(
        `Refused command ${JSON.stringify(command)}: argv only, no shell`,
      );
    const env = childEnv(options.env);
    const media = MEDIA_TOOLS.includes(basename(command));
    // Media tool run directly or through an explicit prlimit wrapper (audio limits).
    const tool =
      media ||
      (basename(command) === "prlimit" &&
        MEDIA_TOOLS.includes(basename(args[args.indexOf("--") + 1] ?? "")));
    if (tool) args = withFormatWhitelist(args);
    const limits = options.limits ?? (media ? MEDIA_LIMITS : false);
    const argv = limits
      ? [
          `--cpu=${limits.cpuSeconds}`,
          `--fsize=${limits.fileSizeBytes}`,
          ...(limits.addressSpaceBytes
            ? [`--as=${limits.addressSpaceBytes}`]
            : []),
          "--",
          command,
          ...args,
        ]
      : args;
    const child = spawn(limits ? "/usr/bin/prlimit" : command, argv, {
      shell: false,
      detached: true,
      cwd: options.cwd,
      env,
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
    child.stdout.on("data", (chunk: Buffer) => {
      if (!options.onStdout) return collect("stdout", chunk);
      if (failure) return;
      try {
        options.onStdout(chunk);
      } catch (error) {
        kill(error instanceof Error ? error.message : "Output consumer failed");
      }
    });
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
/**
 * Every `-protocol_whitelist file` (the marker of a file input) without its own
 * `-format_whitelist` gets MEDIA_FORMATS, so no caller can forget the demuxer list.
 */
function withFormatWhitelist(args: string[]): string[] {
  return args.flatMap((arg, i) =>
    arg === "file" &&
    args[i - 1] === "-protocol_whitelist" &&
    args[i + 1] !== "-format_whitelist"
      ? [arg, "-format_whitelist", MEDIA_FORMATS]
      : [arg],
  );
}
/**
 * Media input path for ffmpeg/ffprobe: refuses options, protocol URLs (concat:, http:,
 * data:…), symlinks (lstat, like probeAudio) and anything but an existing regular
 * file; returns the absolute path.
 */
export function mediaPath(file: string): string {
  if (file.startsWith("-") || /^[a-z][\w+.-]*:/i.test(file))
    throw new Error(`Refused media input ${JSON.stringify(file.slice(0, 80))}`);
  const path = resolve(file);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile())
    throw new Error(`Media input is not a regular file: ${path}`);
  return path;
}
/** `-protocol_whitelist file -format_whitelist <formats> -i <path>` for one input. */
export const fileInput = (file: string, formats = VIDEO_FORMATS) => [
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  formats,
  "-i",
  mediaPath(file),
];
