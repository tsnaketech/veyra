import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
  /** Aborting kills the whole process group, like the wall-clock timeout. */
  signal?: AbortSignal;
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
  "CODEX_HOME",
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
/** The only directories a bare command is resolved in, in this order (T127-sec N8). */
export const SYSTEM_BIN_DIRS = ["/usr/local/bin", "/usr/bin", "/bin"];
/**
 * Fixed child PATH: system dirs first, node's own directory last (only node-based
 * children such as HyperFrames need it), never the parent's PATH.
 */
const CHILD_PATH = [
  ...new Set([...SYSTEM_BIN_DIRS, dirname(process.execPath)]),
].join(":");
let testBinDir: string | undefined;
/** Test-only, reached through `@veyra/video/testing` (VITEST gate there and here). */
export function setTestBinDir(dir: string | undefined) {
  if (!process.env.VITEST) throw new Error("Test-only hook outside Vitest");
  testBinDir = dir;
}
const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const resolvedBinaries = new Map<string, string>();
/**
 * Absolute path of a bare system tool (ffmpeg, ffprobe, prlimit, bwrap…), searched once
 * in SYSTEM_BIN_DIRS only: neither the parent PATH nor node's directory is consulted.
 */
export function systemBinary(name: string): string | undefined {
  if (testBinDir && executable(join(testBinDir, name)))
    return join(testBinDir, name);
  if (!resolvedBinaries.has(name)) {
    const found = SYSTEM_BIN_DIRS.map((dir) => join(dir, name)).find(
      executable,
    );
    if (!found) return undefined;
    resolvedBinaries.set(name, found);
  }
  return resolvedBinaries.get(name);
}
const absolute = (command: string) => {
  if (command.includes("/")) return command;
  const path = systemBinary(command);
  if (!path)
    throw new Error(
      `${command} not found in ${SYSTEM_BIN_DIRS.join(", ")}; refused`,
    );
  return path;
};
const SECRET_KEY =
  /^(?:ANTHROPIC_|CLAUDE_CODE_|AWS_|GITHUB_|OPENAI_)|(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS?)$/i;
const SHELLS = /^(?:a|ba|da|k|mk|tc|z|c|fi|yo)?sh$|^(?:env|busybox|xargs)$/;
/**
 * Builds a child environment from the allow-list only; the parent environment is
 * never inherited. Throws on a secret-looking or unlisted key.
 */
/** Same rule the executor uses to refuse an env key; reused to mask error messages. */
export const isSecretEnvKey = (key: string) => SECRET_KEY.test(key);

export function childEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: testBinDir ? `${testBinDir}:${CHILD_PATH}` : CHILD_PATH,
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
    command = absolute(command);
    const media = MEDIA_TOOLS.includes(basename(command));
    // Media tool run directly or through an explicit prlimit wrapper (audio limits).
    const wrapped =
      basename(command) === "prlimit" ? args.indexOf("--") + 1 : 0;
    if (wrapped)
      args = args.map((arg, i) => (i === wrapped ? absolute(arg) : arg));
    const tool = media
      ? basename(command)
      : wrapped && MEDIA_TOOLS.find((name) => name === basename(args[wrapped]));
    if (tool) {
      args = withFormatWhitelist(args);
      assertFileInputs(tool, wrapped ? args.slice(wrapped + 1) : args);
    }
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
    const child = spawn(limits ? absolute("prlimit") : command, argv, {
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
    const onAbort = () => kill("Process aborted");
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
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
      options.signal?.removeEventListener("abort", onAbort);
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
const ALLOWED_FORMATS = new Set([...MEDIA_FORMATS.split(","), IMAGE_FORMATS]);
const refuse = (tool: string, why: string): never => {
  throw new Error(`Refused ${tool} argv: ${why}`);
};
/**
 * T127-sec N7: every input carries `-protocol_whitelist file` and a `-format_whitelist`
 * drawn from the media lists, or is a lavfi graph declared by `-f lavfi` right before
 * its `-i`. ffmpeg input options are those between the previous input and its `-i`;
 * ffprobe has a single input, often positional, so its options are checked globally.
 */
function assertFileInputs(tool: string, args: string[]) {
  const lastValue = (options: string[], name: string) => {
    const i = options.lastIndexOf(name);
    return i < 0 ? undefined : (options[i + 1] ?? "");
  };
  const checkMarked = (options: string[], what: string) => {
    if (lastValue(options, "-protocol_whitelist") !== "file")
      refuse(tool, `${what} without -protocol_whitelist file`);
    const formats = lastValue(options, "-format_whitelist");
    if (!formats) refuse(tool, `${what} without -format_whitelist`);
    for (const format of formats!.split(","))
      if (!ALLOWED_FORMATS.has(format))
        refuse(tool, `demuxer ${JSON.stringify(format)} is not allowed`);
  };
  args.forEach((arg, i) => {
    if (arg === "-protocol_whitelist" && args[i + 1] !== "file")
      refuse(tool, "-protocol_whitelist must be exactly file");
  });
  let start = 0;
  args.forEach((arg, i) => {
    if (arg !== "-i") return;
    const options = args.slice(start, i);
    start = i + 2;
    if (args[i - 2] === "-f" && args[i - 1] === "lavfi") return;
    checkMarked(options, `input ${JSON.stringify(args[i + 1] ?? "")}`);
  });
  const lavfi = args.some((arg, i) => arg === "lavfi" && args[i - 1] === "-f");
  if (tool === "ffprobe" && !lavfi) checkMarked(args, "input");
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
