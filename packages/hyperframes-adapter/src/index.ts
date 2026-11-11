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
  runEngine,
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
  captionBandRect,
  captionMetrics,
  captionLayerSchema,
  type CaptionLayer,
  type CaptionRect,
} from "./compose";
export { motionDemoStoryboard } from "./demo";
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
const checkFinding = z
  .object({
    code: z.string(),
    severity: z.string(),
    message: z.string(),
    selector: z.string().optional(),
    time: z.number().optional(),
    // contrast_aa_failure details (DOM box in composition CSS px at `time`, colours, ratios).
    times: z.array(z.number()).optional(),
    text: z.string().optional(),
    fg: z.string().optional(),
    bg: z.string().optional(),
    ratio: z.number().optional(),
    requiredRatio: z.number().optional(),
    large: z.boolean().optional(),
    bbox: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .optional(),
  })
  .loose();
const checkSection = z
  .object({
    ok: z.boolean(),
    errorCount: z.number().default(0),
    warningCount: z.number().default(0),
    findings: z.array(checkFinding).default([]),
    /** contrast: text elements checked / passing (passing ones expose no box). */
    checked: z.number().optional(),
    passed: z.number().optional(),
  })
  .loose();
/** `hyperframes check --json`: lint, runtime, layout (overflow), contrast, motion, craft. */
export const compositionCheckSchema = z.object({
  ok: z.boolean(),
  engine: z.enum(["hyperframes", "fake-test-only"]),
  sections: z.record(z.string(), checkSection),
});
export type CompositionCheck = z.infer<typeof compositionCheckSchema>;
export type CompositionCheckFinding = z.infer<typeof checkFinding>;
export type CompositionCheckSection = z.infer<typeof checkSection>;
const checkSections = [
  "lint",
  "runtime",
  "layout",
  "contrast",
  "motion",
  "craft",
] as const;
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
  /** Static and in-browser checks of the composition before encoding. */
  check(dir: string, signal?: AbortSignal): Promise<CompositionCheck>;
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
  async check(dir: string, signal?: AbortSignal): Promise<CompositionCheck> {
    let stdout: string;
    try {
      stdout = (
        await this.sandbox.run(
          process.execPath,
          [
            this.cli,
            "check",
            ".",
            "--json",
            "--at-transitions",
            "--max-transition-samples=40",
          ],
          dirname(resolve(dir)),
          dir,
          undefined,
          signal,
        )
      ).stdout;
    } catch (error) {
      // check exits non-zero when it finds errors; its JSON report is still on stdout.
      if (
        !(error instanceof ProcessError) ||
        !error.stdout.trim().startsWith("{")
      )
        throw error;
      stdout = error.stdout;
    }
    const raw = z
      .object({ ok: z.boolean() })
      .loose()
      .parse(JSON.parse(stdout)) as Record<string, unknown> & { ok: boolean };
    return compositionCheckSchema.parse({
      ok: raw.ok,
      engine: this.kind,
      sections: Object.fromEntries(
        checkSections
          .filter((name) => raw[name])
          .map((name) => [name, raw[name]]),
      ),
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
  async check(_dir: string) {
    return compositionCheckSchema.parse({
      ok: true,
      engine: this.kind,
      sections: {},
    });
  }
  async inspect(_file: string) {
    if (!this.options.probe)
      throw new Error("FakeEngine requires explicit test probe data");
    return probeSchema.parse(this.options.probe);
  }
}
