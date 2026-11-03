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
  pickZoneSample,
  type ContrastSample,
  type PixelContrast,
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
  const measured = (
    ratio: number,
    confidence: "normal" | "low" = "normal",
  ): PixelContrast => ({
    status: "measured",
    ratio,
    inkLuminance: 0.1,
    backgroundLuminance: 0.03,
    inkShare: 0.2,
    separation: 0.9,
    backgroundSpread: confidence === "low" ? 2 : 1.1,
    confidence,
    notes: confidence === "low" ? ["fond hétérogène, confiance faible"] : [],
  });
  const zone = (
    result: PixelContrast | null,
    extra: Partial<ZoneMeasurement> = {},
  ): ZoneMeasurement => {
    const r = result ?? {
      status: "unmeasurable" as const,
      reason: "boîte hors image",
    };
    return {
      text: "01",
      timeMs: 1389,
      frameIndex: 41,
      hfRatio: 2.42,
      requiredRatio: 3,
      transient: false,
      result: r,
      samples: [{ timeMs: 1389, frameIndex: 41, result: r }],
      variable: false,
      ...extra,
    };
  };
  const hf = { checked: 10, passed: 8 };
  it("without a HyperFrames section or zones it is not performed", () => {
    expect(textContrastCheck([], undefined)).toMatchObject({
      analysisMode: "not-performed",
      passed: false,
    });
    const none = textContrastCheck([], { checked: 41, passed: 41 });
    expect(none).toMatchObject({
      analysisMode: "not-performed",
      passed: false,
      severity: "info",
    });
    expect(none.evidence).toContain(
      "41 vérifications élément × instant (41 réussies)",
    );
    expect(none.evidence).not.toMatch(/\d+ textes/);
  });
  it("coverage counts element × instant checks, never texts", () => {
    const check = textContrastCheck([zone(measured(2.4))], hf);
    const { couverture } = JSON.parse(check.evidence);
    expect(couverture).toBe(
      "1 zones remesurées ; HyperFrames a fait 10 vérifications élément × instant (8 réussies) ; les textes qui réussissent ne sont pas exposés et ne sont pas remesurés",
    );
  });
  it("a reliable failure is minor, timestamped at the worst zone", () => {
    const check = textContrastCheck(
      [zone(measured(3.2), { timeMs: 500 }), zone(measured(2.4))],
      hf,
    );
    expect(check).toMatchObject({
      analysisMode: "deterministic",
      passed: false,
      severity: "minor",
      timestamp: 1389,
    });
    expect(JSON.parse(check.evidence).zones[1]).toMatchObject({
      frame: 41,
      ratioMesure: 2.4,
      ratioHyperFrames: 2.42,
      requis: 3,
      mesures: [{ frame: 41, ms: 1389, ratio: 2.4, statut: "mesuré" }],
    });
  });
  it("labels transient zones and passes when all reliable zones pass", () => {
    const check = textContrastCheck(
      [zone(measured(3.5), { transient: true }), zone(null)],
      hf,
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
  it("low-confidence measurements stay visible but out of the verdict", () => {
    // A reliable pass plus a low-confidence 1.2: passes, the 1.2 is shown as "hors verdict".
    const check = textContrastCheck(
      [zone(measured(3.5)), zone(measured(1.2, "low"), { timeMs: 3000 })],
      hf,
    );
    expect(check).toMatchObject({ passed: true, timestamp: 0 });
    const zones = JSON.parse(check.evidence).zones;
    expect(zones[1]).toMatchObject({
      ratioMesure: 1.2,
      confiance: "faible",
      notes: expect.arrayContaining(["hors verdict"]),
    });
    expect(JSON.parse(check.evidence).zonesFiables).toBe(1);
  });
  it("no reliable measurement: not performed, with the reason", () => {
    for (const zones of [[zone(null)], [zone(measured(1.2, "low"))]]) {
      const check = textContrastCheck(zones, hf);
      expect(check).toMatchObject({
        analysisMode: "not-performed",
        passed: false,
        severity: "minor",
      });
      expect(JSON.parse(check.evidence).raison).toContain("aucune zone");
    }
  });
});

describe("pickZoneSample", () => {
  const s = (frameIndex: number, result: PixelContrast): ContrastSample => ({
    frameIndex,
    timeMs: frameIndex * 33,
    result,
  });
  const m = (
    ratio: number,
    confidence: "normal" | "low" = "normal",
  ): PixelContrast => ({
    status: "measured",
    ratio,
    inkLuminance: 0,
    backgroundLuminance: 0,
    inkShare: 0.2,
    separation: 0.9,
    backgroundSpread: 1,
    confidence,
    notes: [],
  });
  it("keeps the best reliable ratio and flags a > 20 % spread", () => {
    // Fade: 1.47 at the first failing instant, 2.42 once fully shown; a low-confidence 4 is ignored.
    const picked = pickZoneSample([
      s(41, m(1.47)),
      s(75, m(2.42)),
      s(108, m(4, "low")),
      s(141, { status: "unmeasurable", reason: "x" }),
    ]);
    expect(picked.sample.frameIndex).toBe(75);
    expect(picked.variable).toBe(true);
    expect(pickZoneSample([s(1, m(2.4)), s(2, m(2.5))]).variable).toBe(false);
  });
  it("falls back to a low-confidence then to the first sample", () => {
    expect(
      pickZoneSample([
        s(1, { status: "unmeasurable", reason: "x" }),
        s(2, m(1.1, "low")),
      ]).sample.frameIndex,
    ).toBe(2);
    expect(
      pickZoneSample([s(3, { status: "unmeasurable", reason: "x" })]).sample
        .frameIndex,
    ).toBe(3);
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

  it("re-measures the same box at every failing instant and keeps the best", async () => {
    // First failing instant before the text appears, later ones once it is shown.
    const [zone] = await measureTextContrast(
      clip,
      [
        {
          code: "contrast_aa_failure",
          severity: "error",
          fg: "rgb(255,255,255)",
          requiredRatio: 4.5,
          bbox: { x: 190, y: 190, width: 180, height: 140 },
          time: 0.4,
          times: [0.4, 0.6, 0.6, 0.7, 0.8, 0.9, 0.95],
        },
      ],
      { compositionWidth: 1280, compositionHeight: 720 },
    );
    // Deduplicated per frame, at most 5 instants, `time` first.
    expect(zone.samples.map((s) => s.frameIndex)).toEqual([12, 18, 21, 24, 27]);
    expect(zone.samples[0].result.status).toBe("unmeasurable");
    expect(zone.result.status).toBe("measured");
    expect(zone.frameIndex).toBeGreaterThanOrEqual(18);
  });
});
