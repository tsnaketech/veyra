import {
  accessSync,
  constants,
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { runProcess, ProcessError } from "@veyra/video";
import { z } from "zod";
export class SandboxUnavailableError extends ProcessError {
  constructor(message: string, stderrTail = "") {
    super(message, stderrTail);
    this.name = "SandboxUnavailableError";
  }
}
export const sandboxOptionsSchema = z.object({
  allowUnsandboxed: z.boolean().default(false),
  wallTimeoutMs: z.number().int().positive().max(600000).default(120000),
  cpuSeconds: z.number().int().positive().max(600).default(90),
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),
  bwrapPath: z.string().default("/usr/bin/bwrap"),
  prlimitPath: z.string().default("/usr/bin/prlimit"),
  // Re-bound read-only after the private /tmp, so a root under /tmp stays visible.
  readOnlyBinds: z.array(z.string()).default([]),
});
function writableSize(root: string): number {
  let total = 0;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry),
      info = lstatSync(path);
    if (info.isSymbolicLink())
      throw new Error("Symlink in render workspace refused");
    total += info.isDirectory() ? writableSize(path) : info.size;
  }
  return total;
}
export class Sandbox {
  readonly options: z.infer<typeof sandboxOptionsSchema>;
  constructor(options: z.input<typeof sandboxOptionsSchema> = {}) {
    this.options = sandboxOptionsSchema.parse(options);
  }
  async run(
    command: string,
    args: string[],
    revisionDir: string,
    cwd: string,
    onLine?: (line: string) => void,
  ) {
    const root = realpathSync(revisionDir),
      working = realpathSync(cwd),
      rel = relative(root, working);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Working directory escapes revision");
    let available = true;
    try {
      accessSync(this.options.bwrapPath, constants.X_OK);
    } catch {
      available = false;
    }
    if (!available && !this.options.allowUnsandboxed)
      throw new SandboxUnavailableError(
        "bwrap is unavailable; rendering refused",
      );
    const sandboxArgs = available
      ? [
          this.options.bwrapPath,
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--tmpfs",
          "/tmp",
          "--tmpfs",
          "/dev/shm",
          "--bind",
          root,
          root,
          ...this.options.readOnlyBinds.flatMap((dir) => {
            const real = realpathSync(dir);
            return ["--ro-bind", real, real];
          }),
          "--unshare-net",
          "--unshare-pid",
          "--die-with-parent",
          "--chdir",
          working,
          command,
          ...args,
        ]
      : [command, ...args];
    // Additions to the executor's minimal env (PATH, LANG); HOME locates Chrome's cache.
    const environment = {
      HOME: process.env.HOME,
      LANG: "C.UTF-8",
      HYPERFRAMES_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
      HYPERFRAMES_SKIP_SKILLS: "1",
    };
    const monitor = () => {
      if (writableSize(root) > this.options.maxOutputBytes)
        throw new Error("Revision output size limit exceeded");
    };
    monitor();
    try {
      const result = await runProcess(
        this.options.prlimitPath,
        [
          `--cpu=${this.options.cpuSeconds}`,
          `--fsize=${this.options.maxOutputBytes}`,
          "--",
          ...sandboxArgs,
        ],
        {
          cwd: working,
          env: environment,
          timeoutMs: this.options.wallTimeoutMs,
          onLine,
          monitor,
          label: [basename(args[0] ?? command), args[1]]
            .filter(Boolean)
            .join(" "),
        },
      );
      monitor();
      return result;
    } catch (error) {
      if (
        available &&
        error instanceof ProcessError &&
        /bwrap:.*(?:not permitted|namespace|permission denied)/is.test(
          error.stderrTail,
        )
      ) {
        throw new SandboxUnavailableError(
          "bwrap cannot create the required isolation; rendering refused",
          error.stderrTail,
        );
      }
      throw error;
    }
  }
}

/**
 * Runs a local engine (T116): argv only, no network, engine root read-only, only
 * outputDir writable, CPU/time/output limits. Never falls back to running unsandboxed.
 */
export function runEngine(
  command: string,
  args: string[],
  dirs: { engineRoot: string; outputDir: string },
  limits: Pick<
    z.input<typeof sandboxOptionsSchema>,
    "wallTimeoutMs" | "cpuSeconds" | "maxOutputBytes" | "bwrapPath"
  > = {},
  onLine?: (line: string) => void,
) {
  const engine = realpathSync(dirs.engineRoot),
    output = realpathSync(dirs.outputDir);
  const inside = (a: string, b: string) => {
    const rel = relative(b, a);
    return !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (inside(output, engine) || inside(engine, output))
    throw new Error("Engine root and output directory must be disjoint");
  return new Sandbox({
    ...limits,
    allowUnsandboxed: false,
    readOnlyBinds: [engine],
  }).run(command, args, output, output, onLine);
}
