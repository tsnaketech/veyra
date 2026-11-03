import { afterAll, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getComponent, normalizeComponent } from "@veyra/motion";
import { ProjectStorage } from "@veyra/storage";
import { compose, writeComposition, HyperFramesEngine } from "./index";
import { Sandbox } from "./sandbox";

const require = createRequire(import.meta.url);
const cli = join(
  dirname(require.resolve("hyperframes/package.json")),
  "bin/hyperframes.mjs",
);
const root = mkdtempSync(join(tmpdir(), "veyra-entry-state-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Pixels brighter than the gradient background: the white text actually on screen. */
function textPixels(input: string, frame?: number): number {
  const { stdout, status, stderr } = spawnSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-i",
      input,
      ...(frame === undefined ? [] : ["-vf", `select=eq(n\\,${frame})`]),
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (status !== 0) throw new Error(stderr.toString());
  let count = 0;
  for (const value of stdout) if (value > 230) count++;
  return count;
}

// T095: staggered entries must stay hidden until their own tween starts,
// whatever order the timeline is sought in (sequential render, jumps, back to 0).
it("keeps staggered entries hidden before they start, on render and on jumps", async () => {
  const storage = new ProjectStorage(root);
  const paths = storage.ensureRevision("prj_entry", "rev_entry");
  const title = getComponent("animated-title").example;
  const board = {
    width: 960,
    height: 540,
    fps: 30,
    scenes: [
      {
        id: "scn_title",
        start: 0,
        duration: 4000,
        text: "Titre",
        animation: { enter: "fade", durationMs: 800, easing: "power2.out" },
        component: normalizeComponent({
          id: "animated-title",
          params: title,
          style: { reveal: "words" },
        }),
      },
    ],
  };
  writeComposition(
    paths.composition,
    compose(board, board, {
      palette: { violet: "#7C3AED", blue: "#2563EB", cyan: "#06B6D4" },
      fonts: ["Inter", "sans-serif"],
    }),
  );
  const result = await new HyperFramesEngine().render(paths.composition, {
    revisionDir: paths.revision,
    outputPath: storage.renderPath("prj_entry", "rev_entry", "rnd_entry"),
    quality: "draft",
    fps: 30,
  });
  const settled = textPixels(result.path, 105); // 3.5 s, everything revealed
  expect(settled).toBeGreaterThan(2000);
  // Kicker and first word start at 0 from opacity 0: frame 0 shows no text.
  expect(textPixels(result.path, 0)).toBeLessThan(settled * 0.02);
  // Early entry frames stay far below the settled frame (the old flash showed ~94 % of it).
  for (const frame of [1, 3, 6, 9, 12])
    expect(textPixels(result.path, frame)).toBeLessThan(settled * 0.5);

  const shots = join(paths.revision, "shots");
  mkdirSync(shots);
  await new Sandbox().run(
    process.execPath,
    [
      cli,
      "snapshot",
      ".",
      "--at",
      "3.5,0.1,2,0",
      "--no-end",
      "--keep",
      "-o",
      shots,
    ],
    paths.revision,
    paths.composition,
  );
  const at = (s: string) => textPixels(join(shots, `at-${s}s.png`));
  expect(at("3.5")).toBeGreaterThan(2000);
  // Jumping back from the end must hide the entries again, down to frame 0.
  expect(at("0.1")).toBeLessThan(at("3.5") * 0.5);
  expect(at("0")).toBeLessThan(at("3.5") * 0.02);
  expect(at("2")).toBeGreaterThan(at("3.5") * 0.9);
}, 240000);
