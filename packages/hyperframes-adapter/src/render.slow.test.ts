import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStorage } from "@veyra/storage";
import { probe } from "@veyra/video";
import { compose, writeComposition, HyperFramesEngine } from "./index";
const root = mkdtempSync(join(tmpdir(), "veyra-real-render-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
it("renders three scenes in bwrap with local GSAP and no black segments", async () => {
  const storage = new ProjectStorage(root);
  const paths = storage.ensureRevision("prj_slow", "rev_slow");
  const board = {
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: ["Veyra", "Create with clarity", "Review with confidence"].map(
      (text, index) => ({
        id: `scn_${index}`,
        start: index * 2000,
        duration: 2000,
        text,
        animation: {
          enter: ["fade", "slide-up", "scale"][index],
          durationMs: 400,
          easing: "power2.out",
        },
      }),
    ),
  };
  writeComposition(
    paths.composition,
    compose(board, board, {
      palette: { violet: "#7C3AED", blue: "#2563EB", cyan: "#06B6D4" },
      fonts: ["Inter", "sans-serif"],
    }),
  );
  const engine = new HyperFramesEngine();
  const result = await engine.render(paths.composition, {
    revisionDir: paths.revision,
    outputPath: storage.renderPath("prj_slow", "rev_slow", "rnd_slow"),
    quality: "draft",
    fps: 30,
  });
  const info = await probe(result.path);
  expect(Math.abs(info.durationMs - 6000)).toBeLessThanOrEqual(100);
  expect(info).toMatchObject({
    width: 1920,
    height: 1080,
    codec: "h264",
    fps: 30,
    blackSegments: [],
  });
}, 180000);
