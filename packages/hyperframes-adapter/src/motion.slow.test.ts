import { afterAll, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStorage } from "@veyra/storage";
import { compareFrames, extractFrames, probe } from "@veyra/video";
import {
  compose,
  writeComposition,
  HyperFramesEngine,
  motionDemoStoryboard,
} from "./index";

const root = mkdtempSync(join(tmpdir(), "veyra-motion-render-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("renders the five-component demo for real, passing HyperFrames check", async () => {
  const storage = new ProjectStorage(root);
  const paths = storage.ensureRevision("prj_motion", "rev_motion");
  const board = motionDemoStoryboard();
  writeComposition(
    paths.composition,
    compose(board, board, {
      palette: { violet: "#7C3AED", blue: "#2563EB", cyan: "#06B6D4" },
      fonts: ["Inter", "sans-serif"],
    }),
  );
  const engine = new HyperFramesEngine();
  const check = await engine.check(paths.composition);
  // Errors are blocking; warnings (craft advice) are reported, not hidden.
  for (const name of ["lint", "runtime", "layout", "contrast"])
    expect({
      name,
      errors: check.sections[name]?.findings.filter(
        (f) => f.severity === "error",
      ),
    }).toEqual({ name, errors: [] });
  console.info(
    "check warnings:",
    Object.values(check.sections).flatMap((s) =>
      s.findings.filter((f) => f.severity !== "error").map((f) => f.code),
    ),
  );
  const started = Date.now();
  const result = await engine.render(paths.composition, {
    revisionDir: paths.revision,
    outputPath: storage.renderPath("prj_motion", "rev_motion", "rnd_motion"),
    quality: "draft",
    fps: 30,
  });
  console.info(
    `render: ${((Date.now() - started) / 1000).toFixed(1)} s for 20 s`,
  );
  const info = await probe(result.path);
  expect(Math.abs(info.durationMs - 20000)).toBeLessThanOrEqual(100);
  expect(info).toMatchObject({
    width: 1920,
    height: 1080,
    codec: "h264",
    blackSegments: [],
  });
  // Animations really move: early vs settled frames differ inside each scene.
  for (const [early, late] of [
    [150, 2500],
    [4300, 7500],
    [9300, 11500],
    [13300, 15500],
    [17100, 19000],
  ]) {
    const [a, b] = await extractFrames(result.path, [early, late]);
    expect(await compareFrames(a, b)).toBeLessThan(40);
  }
  if (process.env.VEYRA_DEMO_OUT)
    copyFileSync(result.path, process.env.VEYRA_DEMO_OUT);
}, 300000);
