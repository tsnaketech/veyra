import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectStorage } from "@veyra/storage";
import {
  captionBandRect,
  compose,
  writeComposition,
  HyperFramesEngine,
  type CompositionCheck,
} from "./index";
import {
  firstFrameAtOrAfter,
  parseSrt,
  parseWebVtt,
  quantizeCues,
  toSrt,
  toWebVtt,
} from "@veyra/schemas";
import { captionFixture, layerFor } from "./captions.fixture";
import { Sandbox } from "./sandbox";

// T113 / CA-3: caption clips appear exactly on [startFrame, endFrame) in real renders.
const require = createRequire(import.meta.url);
const cli = join(
  dirname(require.resolve("hyperframes/package.json")),
  "bin/hyperframes.mjs",
);
const root = mkdtempSync(join(tmpdir(), "veyra-captions-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const storage = new ProjectStorage(root);
const engine = new HyperFramesEngine();
const theme = {
  palette: { violet: "#7C3AED", blue: "#2563EB", cyan: "#06B6D4" },
  fonts: ["Inter", "sans-serif"],
};
const W = 960,
  H = 540,
  SCALE = 2; // decoded at half size
const film = {
  width: W,
  height: H,
  fps: 30,
  scenes: [{ id: "scn_a", start: 0, duration: 3000, text: "Veyra" }],
};

/** RGB frames decoded sequentially (no seeking), at half size. */
function decode(input: string): Buffer[] {
  const { stdout, status, stderr } = spawnSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-i",
      input,
      "-vf",
      `scale=${W / SCALE}:${H / SCALE}`,
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  if (status !== 0) throw new Error(stderr.toString());
  const size = (W / SCALE) * (H / SCALE) * 3;
  return Array.from({ length: stdout.length / size }, (_, i) =>
    stdout.subarray(i * size, (i + 1) * size),
  );
}
type Pixel = (r: number, g: number, b: number) => boolean;
const red: Pixel = (r, g, b) => r > 150 && g < 70 && b < 70;
const yellow: Pixel = (r, g, b) => r > 200 && g > 200 && b < 90;
/** Matching pixel count, row range and mean x (half-size px). */
function measure(frame: Buffer, match: Pixel) {
  let count = 0,
    sumX = 0,
    top = Infinity,
    bottom = -Infinity;
  for (let i = 0; i < frame.length; i += 3)
    if (match(frame[i], frame[i + 1], frame[i + 2])) {
      const p = i / 3,
        y = Math.floor(p / (W / SCALE));
      count++;
      sumX += p % (W / SCALE);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  return { count, x: count ? sumX / count : NaN, top, bottom };
}
const png = (file: string) => {
  const { stdout, status, stderr } = spawnSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `scale=${W / SCALE}:${H / SCALE}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (status !== 0) throw new Error(stderr.toString());
  return stdout;
};
const errors = (check: CompositionCheck) =>
  Object.entries(check.sections).flatMap(([name, section]) =>
    section.findings
      .filter((f) => f.severity === "error")
      .map((f) => `${name}:${f.code}:${f.message}`),
  );
// Deterministic shuffle (jumps forward, backward and back to 0).
const shuffle = <T>(list: T[]) =>
  list
    .map((value, i) => ({ value, key: (i * 7919) % 101 }))
    .sort((a, b) => a.key - b.key)
    .map((o) => o.value);

let n = 0;
async function renderLayer(layer: ReturnType<typeof layerFor>, fps: number) {
  const id = `rev_cap-${fps}-${n++}`;
  const paths = storage.ensureRevision("prj_captions", id);
  writeComposition(paths.composition, compose(film, film, theme, layer));
  const check = await engine.check(paths.composition);
  const { path } = await engine.render(paths.composition, {
    revisionDir: paths.revision,
    outputPath: storage.renderPath("prj_captions", id, `rnd_${n}`),
    quality: "draft",
    fps,
  });
  /** `hyperframes snapshot --at` at the middle of each frame, in the given order. */
  const snapshot = async (frameList: number[]) => {
    const shots = join(paths.revision, `shots-${n++}`);
    mkdirSync(shots);
    const times = frameList.map((f) => Number(((f + 0.5) / fps).toFixed(4)));
    await new Sandbox().run(
      process.execPath,
      [
        cli,
        "snapshot",
        ".",
        "--at",
        times.join(","),
        "--no-end",
        "--keep",
        "-o",
        shots,
      ],
      paths.revision,
      paths.composition,
    );
    return new Map(
      frameList.map((f, i) => [
        f,
        png(join(shots, `at-${Number(times[i].toFixed(3))}s.png`)),
      ]),
    );
  };
  return { check, frames: decode(path), snapshot };
}

const bandStyle = {
  background: "band",
  backgroundColor: "#C00000",
  backgroundOpacity: 1,
  animation: "none",
};
const cues = [
  { startMs: 400, endMs: 1100, lines: ["Bonjour à tous"] },
  { startMs: 1300, endMs: 2050, lines: ["Deux lignes", "de texte"] },
  { startMs: 2200, endMs: 2900, lines: ["Fin du test"] },
];

describe.each([24, 30, 60])("caption band at %i fps", (fps) => {
  it("is present exactly on [startFrame, endFrame), in the MP4 and on jumps", async () => {
    const layer = layerFor(
      captionFixture(cues, bandStyle),
      { num: fps, den: 1 },
      3000,
    );
    const { check, frames, snapshot } = await renderLayer(layer, fps);
    expect(errors(check)).toEqual([]);
    expect(frames).toHaveLength(3 * fps);
    const visible = (f: number) =>
      layer.cues.findIndex((q) => f >= q.startFrame && f < q.endFrame);
    const area = (lines: number) => {
      const r = captionBandRect(bandStyle, film, lines);
      return { ...r, px: (r.width * r.height) / SCALE / SCALE };
    };
    const state = (frame: Buffer, f: number) => {
      const i = visible(f),
        m = measure(frame, red);
      if (i < 0) return m.count < 50 ? "absent" : `stray ${m.count}`;
      const r = area(cues[i].lines.length);
      // Present over most of the band (text covers the rest), inside its rows.
      const inside =
        m.count > r.px * 0.6 &&
        Math.abs(m.top - r.y / SCALE) <= 1 &&
        Math.abs(m.bottom + 1 - (r.y + r.height) / SCALE) <= 1;
      return inside ? "present" : `wrong ${JSON.stringify(m)}`;
    };
    // Every decoded frame, not only the boundaries.
    const mp4 = frames.map((frame, f) => state(frame, f));
    expect(mp4.filter((s) => s !== "present" && s !== "absent")).toEqual([]);
    frames.forEach((_, f) =>
      expect([f, mp4[f]]).toEqual([f, visible(f) < 0 ? "absent" : "present"]),
    );
    const boundaries = layer.cues.flatMap((q) => [
      q.startFrame - 1,
      q.startFrame,
      q.endFrame - 1,
      q.endFrame,
    ]);
    const shots = await snapshot([...shuffle(boundaries), 0]);
    for (const [f, frame] of shots)
      expect([f, state(frame, f)]).toEqual([
        f,
        visible(f) < 0 ? "absent" : "present",
      ]);
  }, 300000);
});

it("word-highlight switches words exactly at their frames, on render and on jumps", async () => {
  const fps = 30;
  const track = captionFixture(
    [{ startMs: 300, endMs: 2700, lines: ["Un deux trois quatre"] }],
    {
      background: "box",
      sizePct: 7,
      backgroundOpacity: 1,
      animation: "word-highlight",
      highlightColor: "#FFFF00",
    },
  );
  const layer = layerFor(track, { num: fps, den: 1 }, 3000);
  const { check, frames, snapshot } = await renderLayer(layer, fps);
  expect(errors(check)).toEqual([]);
  // Words at 300, 900, 1500, 2100 ms -> frames 9, 27, 45, 63.
  const word = (f: number, frame = frames[f]) => measure(frame, yellow);
  for (const boundary of [27, 45]) {
    const before = word(boundary - 1),
      after = word(boundary);
    expect(before.count).toBeGreaterThan(20);
    expect(after.count).toBeGreaterThan(20);
    // The lit word moves right on the boundary frame, not one frame later.
    expect(after.x - before.x).toBeGreaterThan(15);
    expect(Math.abs(word(boundary + 1).x - after.x)).toBeLessThan(3);
  }
  const shots = await snapshot([62, 44, 27, 26, 45, 0, 9]);
  for (const f of [26, 27, 44, 45])
    expect(Math.abs(word(f, shots.get(f)).x - word(f).x)).toBeLessThan(3);
  // Before the cue and back at 0: nothing lit.
  expect(word(0, shots.get(0)).count).toBe(0);
  expect(word(9, shots.get(9)).count).toBeGreaterThan(20);
}, 300000);

// T114 / CA-3: SRT/VTT exported from the PROBED video match the burned MP4 frame by frame;
// the clean MP4 never shows the band.
describe.each([24, 30])("burned + clean exports at %i fps", (fps) => {
  it("SRT/VTT cues map to the frames where the band is present", async () => {
    const board = { ...film, fps };
    const rate = { num: fps, den: 1 };
    const track = captionFixture(cues, bandStyle);
    const layer = layerFor(track, rate, 3000);
    const id = `rev_exp-${fps}`;
    const paths = storage.ensureRevision("prj_captions", id);
    const render = async (name: string, captions?: unknown) => {
      writeComposition(
        paths.composition,
        compose(board, board, theme, captions),
      );
      return (
        await engine.render(paths.composition, {
          revisionDir: paths.revision,
          outputPath: storage.renderPath("prj_captions", id, `rnd_${name}`),
          quality: "draft",
          fps,
        })
      ).path;
    };
    const burned = await render("burned", layer);
    const clean = await render("clean");
    const probed = await engine.inspect(burned);
    expect(probed.frameRate).toEqual(rate);
    expect(probed.constantFrameRate).toBe(true);
    const measured = quantizeCues(
      track.cues,
      probed.frameRate!,
      probed.frameCount!,
    );
    expect(measured).toEqual(layer.cues);
    const fromSrt = parseSrt(toSrt(track, measured));
    const fromVtt = parseWebVtt(toWebVtt(track, measured));
    expect(fromVtt).toEqual(fromSrt);
    const spans = fromSrt.map((c) => [
      firstFrameAtOrAfter(c.startMs, rate),
      firstFrameAtOrAfter(c.endMs, rate),
    ]);
    expect(spans).toEqual(measured.map((q) => [q.startFrame, q.endFrame]));
    const shown = (f: number) =>
      spans.findIndex(([start, end]) => f >= start && f < end);
    const frames = decode(burned);
    expect(frames).toHaveLength(probed.frameCount!);
    const lines = (i: number) => cues[i].lines.length;
    const band = frames.map((frame, f) => {
      const m = measure(frame, red),
        i = shown(f);
      if (i < 0) return m.count < 50;
      const r = captionBandRect(bandStyle, film, lines(i));
      return (
        m.count > ((r.width * r.height) / SCALE / SCALE) * 0.6 &&
        Math.abs(m.top - r.y / SCALE) <= 1
      );
    });
    expect(band.flatMap((ok, f) => (ok ? [] : [f]))).toEqual([]);
    const plain = decode(clean);
    expect(plain).toHaveLength(probed.frameCount!);
    expect(
      plain.flatMap((frame, f) => (measure(frame, red).count < 50 ? [] : [f])),
    ).toEqual([]);
  }, 300000);
});
