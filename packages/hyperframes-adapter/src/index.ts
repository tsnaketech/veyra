import { createRequire } from "node:module";
import { dirname, join, relative, isAbsolute, resolve } from "node:path";
import {
  existsSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { z } from "zod";
import {
  probe,
  probeSchema,
  type VideoProbe,
  ProcessError,
} from "@veyra/video";
import { safePath } from "@veyra/storage";
import { Sandbox, type sandboxOptionsSchema } from "./sandbox";
export {
  Sandbox,
  SandboxUnavailableError,
  sandboxOptionsSchema,
} from "./sandbox";
export {
  compose,
  writeComposition,
  animationSchema,
  styleSchema,
  formatSchema,
} from "./compose";
const require = createRequire(import.meta.url);
export const progressSchema = z.object({
  percent: z.number().int().min(0).max(100),
  stage: z.enum(["lint", "render", "encode", "qa", "complete"]),
});
export type RenderProgress = z.infer<typeof progressSchema>;
export const renderOptionsSchema = z.object({
  outputPath: z.string().min(1),
  revisionDir: z.string().min(1),
  quality: z.enum(["draft", "looks", "delivery"]).default("draft"),
  fps: z.number().int().min(1).max(60).default(30),
  strict: z.boolean().default(false),
});
export type RenderOptions = z.input<typeof renderOptionsSchema>;
export const renderResultSchema = z.object({
  path: z.string().min(1),
  engine: z.enum(["hyperframes", "fake-test-only"]),
  stderrTail: z.string().max(8192),
});
export type RenderResult = z.infer<typeof renderResultSchema>;
export const validationResultSchema = z.object({
  valid: z.literal(true),
  engine: z.enum(["hyperframes", "fake-test-only"]),
  stderrTail: z.string().max(8192),
});
export type ValidationResult = z.infer<typeof validationResultSchema>;
export const previewResultSchema = z.object({
  path: z.string(),
  kind: z.literal("rendered-draft"),
  engine: z.enum(["hyperframes", "fake-test-only"]),
});
export type PreviewResult = z.infer<typeof previewResultSchema>;
export interface VideoEngine {
  readonly kind: "hyperframes" | "fake-test-only";
  validate(dir: string): Promise<ValidationResult>;
  preview(dir: string): Promise<PreviewResult>;
  render(
    dir: string,
    opts: RenderOptions,
    onProgress?: (progress: RenderProgress) => void,
  ): Promise<RenderResult>;
  inspect(file: string): Promise<VideoProbe>;
}
export class HyperFramesEngine implements VideoEngine {
  readonly kind = "hyperframes" as const;
  private sandbox: Sandbox;
  private cli = join(
    dirname(require.resolve("hyperframes/package.json")),
    "bin/hyperframes.mjs",
  );
  constructor(options: z.input<typeof sandboxOptionsSchema> = {}) {
    this.sandbox = new Sandbox(options);
  }
  async validate(dir: string): Promise<ValidationResult> {
    let stderr = "";
    for (const action of ["lint", "validate"]) {
      const result = await this.sandbox.run(
        process.execPath,
        [this.cli, action, "."],
        dir,
        dir,
      );
      stderr = (stderr + result.stderr).slice(-8192);
    }
    return validationResultSchema.parse({
      valid: true,
      engine: this.kind,
      stderrTail: stderr,
    });
  }
  async preview(dir: string): Promise<PreviewResult> {
    const revisionDir = dirname(resolve(dir));
    mkdirSync(safePath(revisionDir, "renders"), { recursive: true });
    const path = safePath(revisionDir, "renders/preview.mp4");
    if (existsSync(path)) {
      await this.inspect(path);
      return previewResultSchema.parse({
        path,
        kind: "rendered-draft",
        engine: this.kind,
      });
    }
    await this.render(dir, { revisionDir, outputPath: path, quality: "draft" });
    return previewResultSchema.parse({
      path,
      kind: "rendered-draft",
      engine: this.kind,
    });
  }
  async render(
    dir: string,
    input: RenderOptions,
    onProgress: (progress: RenderProgress) => void = () => {},
  ): Promise<RenderResult> {
    const opts = renderOptionsSchema.parse(input),
      root = realpathSync(opts.revisionDir);
    const rel = relative(root, resolve(opts.outputPath));
    if (!rel || isAbsolute(rel) || rel.startsWith(".."))
      throw new Error("Output must be inside revision");
    const outputPath = safePath(root, rel);
    if (existsSync(outputPath)) throw new Error("Render output already exists");
    const emit = (percent: number, stage: RenderProgress["stage"]) =>
      onProgress(progressSchema.parse({ percent, stage }));
    emit(5, "lint");
    await this.sandbox.run(
      process.execPath,
      [this.cli, "lint", "."],
      root,
      dir,
    );
    emit(15, "render");
    let progress = 15;
    const result = await this.sandbox.run(
      process.execPath,
      [
        this.cli,
        "render",
        ".",
        "-o",
        outputPath,
        "-q",
        opts.quality,
        "--quiet",
        "-f",
        String(opts.fps),
        ...(opts.strict ? ["--strict"] : []),
      ],
      root,
      dir,
      (line) => {
        const match = /(?:^|\s)(\d{1,3}(?:\.\d+)?)%/.exec(line);
        if (match) {
          progress = Math.max(
            progress,
            Math.min(90, 15 + Math.round(Number(match[1]) * 0.75)),
          );
          emit(progress, "render");
        }
      },
    );
    emit(95, "encode");
    const size = statSync(safePath(root, rel)).size;
    if (size === 0 || size > this.sandbox.options.maxOutputBytes)
      throw new ProcessError("Invalid render output size", result.stderr);
    emit(100, "complete");
    return renderResultSchema.parse({
      path: outputPath,
      engine: this.kind,
      stderrTail: result.stderr,
    });
  }
  inspect(file: string): Promise<VideoProbe> {
    return probe(file);
  }
}
// This test double never produces a real video; use only with explicitly simulated QA.
export class FakeEngine implements VideoEngine {
  readonly kind = "fake-test-only" as const;
  constructor(
    private options: {
      fail?: boolean;
      delayMs?: number;
      probe?: VideoProbe;
    } = {},
  ) {}
  async validate(_dir: string) {
    return validationResultSchema.parse({
      valid: true,
      engine: this.kind,
      stderrTail: "",
    });
  }
  async preview(dir: string) {
    return previewResultSchema.parse({
      path: join(dir, "fake-test-only.mp4"),
      kind: "rendered-draft",
      engine: this.kind,
    });
  }
  async render(
    _dir: string,
    input: RenderOptions,
    onProgress: (progress: RenderProgress) => void = () => {},
  ) {
    const opts = renderOptionsSchema.parse(input);
    onProgress(progressSchema.parse({ percent: 10, stage: "lint" }));
    await new Promise((resolve) =>
      setTimeout(resolve, this.options.delayMs ?? 0),
    );
    if (this.options.fail)
      throw new ProcessError(
        "FakeEngine test failure",
        "fake-test-only: simulated stderr",
      );
    onProgress(progressSchema.parse({ percent: 90, stage: "encode" }));
    writeFileSync(opts.outputPath, "FAKE TEST ONLY - NOT A VIDEO", {
      flag: "wx",
    });
    return renderResultSchema.parse({
      path: opts.outputPath,
      engine: this.kind,
      stderrTail: "",
    });
  }
  async inspect(_file: string) {
    if (!this.options.probe)
      throw new Error("FakeEngine requires explicit test probe data");
    return probeSchema.parse(this.options.probe);
  }
}
