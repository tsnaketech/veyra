import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contrastFromPixels,
  contrastRatio,
  cropBox,
  measureTextContrast,
  relativeLuminance,
  runProcess,
  textContrastCheck,
  type ZoneMeasurement,
} from "./index";

type Rgb = [number, number, number];
/** w×h RGB24 image: `ink(x, y)` pixels get `fg`, others `bg(x, y)`. */
function image(
  w: number,
  h: number,
  fg: Rgb,
  bg: (x: number, y: number) => Rgb,
  ink: (x: number, y: number) => boolean,
) {
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      out.set(ink(x, y) ? fg : bg(x, y), 3 * (y * w + x));
  return out;
}
// Vertical "glyph" strokes: 4 px out of every 10 columns, rows 4..15 (≈ 24 % ink).
const strokes = (x: number, y: number) => x % 10 < 4 && y >= 4 && y < 16;
const blue: Rgb = [37, 99, 235],
  white: Rgb = [255, 255, 255];

describe("contrastFromPixels", () => {
  it("white on #2563EB matches the WCAG formula (5.17:1)", () => {
    // Hand-computed: L(#2563EB) = 0.1532, (1 + 0.05) / (0.1532 + 0.05) = 5.17.
    expect(relativeLuminance(...blue)).toBeCloseTo(0.1532, 3);
    const r = contrastFromPixels(
      image(60, 20, white, () => blue, strokes),
      60,
      20,
      "rgb(255,255,255)",
    );
    expect(r).toMatchObject({
      status: "measured",
      ratio: 5.17,
      confidence: "normal",
    });
  });

  it("#9a9a9a on #808080 is ≈ 1.40:1", () => {
    const r = contrastFromPixels(
      image(60, 20, [154, 154, 154], () => [128, 128, 128], strokes),
      60,
      20,
      "rgb(154,154,154)",
    );
    expect(r).toMatchObject({ status: "measured", ratio: 1.4 });
  });

  it("text at 50 % opacity measures the blended (reduced) contrast", () => {
    const blended: Rgb = [146, 177, 245];
    const r = contrastFromPixels(
      image(60, 20, blended, () => blue, strokes),
      60,
      20,
      "rgb(255,255,255)",
    );
    expect(r.status).toBe("measured");
    if (r.status !== "measured") return;
    expect(r.ratio).toBeCloseTo(
      contrastRatio(relativeLuminance(...blended), relativeLuminance(...blue)),
      2,
    );
    expect(r.ratio).toBeLessThan(5.17); // 2.42:1 by formula
  });

  it("picks the ink class from the DOM colour, not the minority", () => {
    // Bold black text covering 60 % of a white box.
    const r = contrastFromPixels(
      image(
        60,
        20,
        [0, 0, 0],
        () => white,
        (x) => x % 10 < 6,
      ),
      60,
      20,
      "rgb(0,0,0)",
    );
    expect(r).toMatchObject({
      status: "measured",
      inkShare: 0.6,
      inkLuminance: 0,
      ratio: 21,
    });
  });

  it("striped background: low confidence", () => {
    const r = contrastFromPixels(
      image(
        60,
        20,
        white,
        (_, y) => (y % 4 < 2 ? [128, 128, 128] : [64, 64, 64]),
        strokes,
      ),
      60,
      20,
      "rgb(255,255,255)",
    );
    expect(r.status === "unmeasurable" || r.confidence === "low").toBe(true);
  });

  it("empty or tiny boxes are not measurable", () => {
    expect(
      contrastFromPixels(
        image(
          60,
          20,
          white,
          () => blue,
          () => false,
        ),
        60,
        20,
        "#ffffff",
      ),
    ).toMatchObject({
      status: "unmeasurable",
      reason: expect.stringContaining("uniforme"),
    });
    expect(
      contrastFromPixels(
        image(20, 4, white, () => blue, strokes),
        20,
        4,
      ),
    ).toMatchObject({
      status: "unmeasurable",
      reason: expect.stringContaining("trop petite"),
    });
    // A lone dot: ink share under 2 %.
    expect(
      contrastFromPixels(
        image(
          60,
          20,
          white,
          () => blue,
          (x, y) => x === 5 && y === 5,
        ),
        60,
        20,
        "#ffffff",
      ),
    ).toMatchObject({
      status: "unmeasurable",
      reason: expect.stringContaining("part d'encre"),
    });
  });
});

describe("cropBox", () => {
  const comp = { width: 1920, height: 1080 };
  it("scales and rounds outwards", () => {
    expect(
      cropBox({ x: 189, y: 523.78, width: 30.95, height: 34 }, comp, {
        width: 960,
        height: 540,
      }),
    ).toEqual({
      x: 94,
      y: 261,
      width: 16,
      height: 18,
    });
  });
  it("clamps to the picture and rejects boxes outside it", () => {
    expect(
      cropBox({ x: 1900, y: -10, width: 50, height: 30 }, comp, comp),
    ).toEqual({
      x: 1900,
      y: 0,
      width: 20,
      height: 20,
    });
    expect(
      cropBox({ x: 2000, y: 10, width: 50, height: 30 }, comp, comp),
    ).toBeNull();
  });
});

describe("textContrastCheck", () => {
  const zone = (
    ratio: number | null,
    extra: Partial<ZoneMeasurement> = {},
  ): ZoneMeasurement => ({
    text: "01",
    timeMs: 1389,
    frameIndex: 41,
    hfRatio: 2.42,
    requiredRatio: 3,
    transient: false,
    result:
      ratio === null
        ? { status: "unmeasurable", reason: "boîte hors image" }
        : {
            status: "measured",
            ratio,
            inkLuminance: 0.1,
            backgroundLuminance: 0.03,
            inkShare: 0.2,
            separation: 0.9,
            backgroundSpread: 1.1,
            confidence: "normal",
            notes: [],
          },
    ...extra,
  });
  it("without a HyperFrames section or zones it is not performed", () => {
    expect(textContrastCheck([], undefined)).toMatchObject({
      analysisMode: "not-performed",
      passed: false,
    });
    const none = textContrastCheck([], {
      checked: 41,
      passed: 41,
      findings: [],
    });
    expect(none).toMatchObject({
      analysisMode: "not-performed",
      passed: false,
      severity: "info",
    });
    expect(none.evidence).toContain(
      "41 textes validés par son contrôle DOM, non remesurés",
    );
  });
  it("a measured failure is minor, timestamped at the worst zone", () => {
    const check = textContrastCheck([zone(3.2, { timeMs: 500 }), zone(2.4)], {
      checked: 41,
      passed: 29,
    });
    expect(check).toMatchObject({
      analysisMode: "deterministic",
      passed: false,
      severity: "minor",
      timestamp: 1389,
    });
    const evidence = JSON.parse(check.evidence);
    expect(evidence.couverture).toContain("2 zones remesurées sur 41 textes");
    expect(evidence.zones[1]).toMatchObject({
      frame: 41,
      ratioMesure: 2.4,
      ratioHyperFrames: 2.42,
      requis: 3,
    });
  });
  it("labels transient zones and passes when all measured zones pass", () => {
    const check = textContrastCheck(
      [zone(3.5, { transient: true }), zone(null)],
      { checked: 5 },
    );
    expect(check).toMatchObject({
      passed: true,
      severity: "info",
      analysisMode: "deterministic",
    });
    const zones = JSON.parse(check.evidence).zones;
    expect(zones[0].statut).toBe("transitoire");
    expect(zones[1].statut).toBe("non mesurable : boîte hors image");
  });
  it("only unmeasurable zones: not performed", () => {
    expect(textContrastCheck([zone(null)], { checked: 5 })).toMatchObject({
      analysisMode: "not-performed",
      passed: false,
      severity: "minor",
    });
  });
});

const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
describe.skipIf(!existsSync(font))("measureTextContrast (real FFmpeg)", () => {
  let root: string, clip: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "veyra-contrast-"));
    clip = join(root, "text.mp4");
    // 640×360 video of a 1280×720 composition: white "01" on #2563EB from 0.5 s.
    await runProcess("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x2563EB:s=640x360:r=30:d=1,drawtext=fontfile=${font}:text=01:fontsize=64:fontcolor=white:x=100:y=100:enable='gte(t,0.5)'`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      clip,
    ]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("measures the box at its instant only, close to the WCAG value", async () => {
    const box = { x: 190, y: 190, width: 180, height: 140 };
    const base = {
      code: "contrast_aa_failure",
      severity: "error",
      fg: "rgb(255,255,255)",
      requiredRatio: 4.5,
      bbox: box,
    };
    const [shown, before, outside] = await measureTextContrast(
      clip,
      [
        { ...base, text: "01", time: 0.6 },
        { ...base, text: "01", time: 0.4 },
        {
          ...base,
          text: "far",
          time: 0.6,
          bbox: { x: 1400, y: 10, width: 50, height: 50 },
        },
      ],
      { compositionWidth: 1280, compositionHeight: 720 },
    );
    expect(shown).toMatchObject({
      frameIndex: 18,
      crop: { x: 95, y: 95, width: 90, height: 70 },
    });
    expect(shown.result.status).toBe("measured");
    // Tolerance: x264 + 4:2:0 chroma blur the stroke edges (theory 5.17:1).
    if (shown.result.status === "measured")
      expect(Math.abs(shown.result.ratio - 5.17)).toBeLessThan(0.4);
    expect(before.result).toMatchObject({
      status: "unmeasurable",
      reason: expect.stringContaining("uniforme"),
    });
    expect(outside.result).toMatchObject({
      status: "unmeasurable",
      reason: "boîte hors image",
    });
  });
});
