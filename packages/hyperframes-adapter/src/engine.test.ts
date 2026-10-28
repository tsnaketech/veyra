import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe, runProcess, ProcessError } from "@veyra/video";
import { ProjectStorage } from "@veyra/storage";
import { HyperFramesEngine, type RenderProgress } from "./index";
vi.mock("@veyra/video", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@veyra/video")>()),
  runProcess: vi.fn(),
  probe: vi.fn(),
}));
let root: string,
  paths: ReturnType<ProjectStorage["ensureRevision"]>,
  engine: HyperFramesEngine;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "veyra-engine-"));
  paths = new ProjectStorage(root).ensureRevision("prj_one", "rev_one");
  engine = new HyperFramesEngine({ bwrapPath: "/usr/bin/true" });
  vi.mocked(probe).mockReset().mockResolvedValue({
    durationMs: 1000,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: "h264",
    size: 100,
    audioStreams: [],
    blackSegments: [],
  });
  vi.mocked(runProcess)
    .mockReset()
    .mockImplementation(async (_command, args, options) => {
      const output = args.indexOf("-o");
      if (output !== -1) writeFileSync(args[output + 1], "test-double");
      options?.onLine?.("50%");
      return { stdout: "", stderr: "test stderr tail" };
    });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it("runs lint then CLI render and validates typed progress and output", async () => {
  const events: RenderProgress[] = [],
    path = join(paths.renders, "output.mp4");
  expect(
    await engine.render(
      paths.composition,
      {
        revisionDir: paths.revision,
        outputPath: path,
        quality: "looks",
        fps: 25,
        strict: true,
      },
      (value) => events.push(value),
    ),
  ).toEqual({ path, engine: "hyperframes", stderrTail: "test stderr tail" });
  const calls = vi.mocked(runProcess).mock.calls;
  expect(calls[0][1].slice(-2)).toEqual(["lint", "."]);
  expect(calls[1][1].slice(-10)).toEqual([
    "render",
    ".",
    "-o",
    path,
    "-q",
    "looks",
    "--quiet",
    "-f",
    "25",
    "--strict",
  ]);
  expect(events.map((event) => event.stage)).toEqual([
    "lint",
    "render",
    "render",
    "encode",
    "complete",
  ]);
  expect(events.at(-1)?.percent).toBe(100);
});
it("validates through lint and validate commands", async () => {
  expect((await engine.validate(paths.composition)).valid).toBe(true);
  expect(
    vi.mocked(runProcess).mock.calls.map((call) => call[1].at(-2)),
  ).toEqual(["lint", "validate"]);
});
it("previews a rendered draft without starting a server", async () => {
  const result = await engine.preview(paths.composition);
  expect(result.kind).toBe("rendered-draft");
  expect((await engine.preview(paths.composition)).path).toBe(result.path);
  expect(vi.mocked(runProcess).mock.calls).toHaveLength(2);
});
it("refuses outside output paths and propagates CLI stderr", async () => {
  await expect(
    engine.render(paths.composition, {
      revisionDir: paths.revision,
      outputPath: join(root, "outside.mp4"),
    }),
  ).rejects.toThrow("inside");
  vi.mocked(runProcess).mockRejectedValue(
    new ProcessError("CLI failed", "actual stderr"),
  );
  await expect(
    engine.render(paths.composition, {
      revisionDir: paths.revision,
      outputPath: join(paths.renders, "out.mp4"),
    }),
  ).rejects.toMatchObject({ stderrTail: "actual stderr" });
});
