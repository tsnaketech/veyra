import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualityCheckSchema } from "@veyra/schemas";
import {
  analyzeFlashes,
  detectFlashes,
  lumaToNits,
  photosensitivityCheck,
  runProcess,
  type ColorRange,
} from "./index";

const W = 40,
  H = 25,
  N = W * H,
  FPS = 30;
const opts = (colorRange: ColorRange = "full") => ({
  fps: FPS,
  width: W,
  height: H,
  colorRange,
});
/** `count` frames; `lit(i)` says whether frame i shows `high` on the first `share` of pixels. */
function frames(
  count: number,
  lit: (i: number) => boolean,
  share = 1,
  [low, high] = [0, 255],
) {
  const n = Math.round(share * N);
  return Array.from({ length: count }, (_, i) => {
    const frame = new Uint8Array(N).fill(low);
    if (lit(i)) frame.fill(high, 0, n);
    return frame;
  });
}
const hz = (f: number) => (i: number) =>
  Math.floor((2 * f * i) / FPS) % 2 === 1;
/** Toggles at the given frame indices, then holds. */
const toggles = (at: number[]) => (i: number) =>
  at.filter((t) => t <= i).length % 2 === 1;

describe("detectFlashes", () => {
  it("luminance model: limited and full peaks map to 200 cd/m²", () => {
    expect(lumaToNits(235, "limited")).toBeCloseTo(200);
    expect(lumaToNits(16, "limited")).toBe(0);
    expect(lumaToNits(255, "full")).toBeCloseTo(200);
    expect(lumaToNits(0, "full")).toBe(0);
  });

  it("full-screen 5 Hz is a major defect", () => {
    const r = detectFlashes(frames(60, hz(5)), opts());
    expect(r.severity).toBe("major");
    expect(r.maxFlashesPerSecond).toBe(5);
    expect(r.worstWindow).toMatchObject({ frameIndex: 3, startMs: 100 });
    const check = photosensitivityCheck(r);
    expect(check).toMatchObject({
      passed: false,
      severity: "major",
      timestamp: 100,
      analysisMode: "deterministic",
    });
    expect(check.evidence).toContain("ITU-R BT.1702");
    expect(check.evidence).toContain("flashs rouges saturés non évalués");
    expect(JSON.parse(check.evidence).transitions[0]).toMatchObject({
      frame: 3,
      sens: "montée",
    });
  });

  it("full-screen 2 Hz passes", () => {
    const r = detectFlashes(frames(90, hz(2)), opts());
    expect(r.maxFlashesPerSecond).toBe(2);
    expect(r.severity).toBe("info");
    expect(photosensitivityCheck(r)).toMatchObject({
      passed: true,
      severity: "info",
    });
  });

  it("5 Hz on 9 % of the screen is not reported", () => {
    const r = detectFlashes(frames(60, hz(5), 0.09), opts());
    expect(r.severity).toBe("info");
    expect(r.maxArea).toBeCloseTo(0.09);
  });

  it("5 Hz on ~15 % of the screen is a minor warning", () => {
    const r = detectFlashes(frames(60, hz(5), 0.15), opts());
    expect(r.maxFlashesPerSecond).toBe(0);
    expect(r.maxFlashesPerSecondSmallArea).toBe(5);
    expect(r.severity).toBe("minor");
    expect(photosensitivityCheck(r).recommendation).toContain(
      "vérifier par un humain",
    );
  });

  it("area bounds: 24 % is minor, 26 % is major", () => {
    expect(detectFlashes(frames(60, hz(5), 0.24), opts()).severity).toBe(
      "minor",
    );
    expect(detectFlashes(frames(60, hz(5), 0.26), opts()).severity).toBe(
      "major",
    );
  });

  it("rate bounds: 3 flashes/s is minor, 3.5 is major", () => {
    const six = detectFlashes(
      frames(60, toggles([4, 8, 12, 16, 20, 24])),
      opts(),
    );
    expect(six.maxFlashesPerSecond).toBe(3);
    expect(six.severity).toBe("minor");
    const seven = detectFlashes(
      frames(60, toggles([4, 8, 12, 16, 20, 24, 28])),
      opts(),
    );
    expect(seven.maxFlashesPerSecond).toBe(3.5);
    expect(seven.severity).toBe("major");
  });

  it("a slow fade in then out (1 s each) passes", () => {
    const ramp = Array.from({ length: 90 }, (_, i) =>
      new Uint8Array(N).fill(
        Math.round(255 * (i < 30 ? i / 30 : i < 60 ? 1 : (90 - i) / 30)),
      ),
    );
    const r = detectFlashes(ramp, opts());
    expect(r.events.map((e) => e.direction)).toEqual(["up", "down"]);
    expect(r.severity).toBe("info");
  });

  it("a single black-to-white cut passes", () => {
    const r = detectFlashes(
      frames(30, (i) => i >= 10),
      opts(),
    );
    expect(r.events).toEqual([
      { frameIndex: 10, timeMs: 333, direction: "up", area: 1 },
    ]);
    expect(r.severity).toBe("info");
  });

  // Halves swap (one half goes up while the other goes down) whenever `swapped` changes.
  const halves = (count: number, swapped: (i: number) => boolean) =>
    Array.from({ length: count }, (_, i) => {
      const frame = new Uint8Array(N).fill(swapped(i) ? 0 : 255);
      frame.fill(swapped(i) ? 255 : 0, 0, N / 2);
      return frame;
    });

  it("pooling never reuses a transition: complementary cuts and single frames", () => {
    // Review T104 (D1): a cut between complementary shots used to yield up, down, up.
    expect(
      detectFlashes(
        halves(30, (i) => i >= 10),
        opts(),
      ).events,
    ).toHaveLength(1);
    for (const fps of [24, 30, 60]) {
      const twoCuts = detectFlashes(
        halves(fps * 2, (i) => i >= fps / 3 && i < fps / 3 + fps / 2),
        { ...opts(), fps },
      );
      expect(twoCuts.events).toHaveLength(2);
      expect(twoCuts.severity).toBe("info");
      // One white frame is one flash (up then down), at any frame rate.
      const single = detectFlashes(
        frames(fps, (i) => i === 10),
        { ...opts(), fps },
      );
      expect(single.events.map((e) => e.direction)).toEqual(["up", "down"]);
      expect(single.maxFlashesPerSecond).toBe(1);
    }
    // Opposite-phase halves swapping 4 times per second: 2 flashes/s, not more.
    const swaps = detectFlashes(halves(90, hz(2)), opts());
    expect(swaps.maxFlashesPerSecond).toBe(2);
    expect(swaps.severity).toBe("info");
  });

  it("a sweeping flash (3 bands of 10 %, staggered) keeps its full rate", () => {
    // Re-review T104 (N1): consuming both directions halved this rate.
    const cases = [
      { fps: 30, hz: 5, shift: 1, width: 2, rate: 5 },
      { fps: 30, hz: 6, shift: 1, width: 2, rate: 6 },
      { fps: 60, hz: 4, shift: 2, width: 4, rate: 4 },
      { fps: 60, hz: 5, shift: 2, width: 3, rate: 5 },
      // Re-review 2 (N2): one-frame bands.
      { fps: 30, hz: 5, shift: 1, width: 1, rate: 5 },
      { fps: 30, hz: 4, shift: 1, width: 1, rate: 4 },
      { fps: 60, hz: 5, shift: 2, width: 2, rate: 5 },
    ];
    for (const { fps, hz: f, shift, width, rate } of cases) {
      const period = fps / f;
      const sweep = Array.from({ length: fps * 2 }, (_, i) => {
        const frame = new Uint8Array(N);
        for (let band = 0; band < 3; band++) {
          const t = (((i - band * shift) % period) + period) % period;
          if (i >= band * shift && t < width)
            frame.fill(255, band * 100, (band + 1) * 100);
        }
        return frame;
      });
      const r = detectFlashes(sweep, { ...opts(), fps });
      expect(r.maxFlashesPerSecond).toBe(rate);
      expect(r.severity).toBe("major");
    }
  });

  it("opposite-phase halves count each region's rate, not the sum", () => {
    // Each half flashes at 5 Hz: major; at 2 Hz: passes.
    expect(detectFlashes(halves(60, hz(5)), opts())).toMatchObject({
      maxFlashesPerSecond: 5,
      severity: "major",
    });
    expect(detectFlashes(halves(90, hz(2)), opts()).severity).toBe("info");
  });

  it("5 Hz full-screen stays major at 24 and 60 fps", () => {
    for (const fps of [24, 60]) {
      const at = (i: number) => Math.floor((2 * 5 * i) / fps) % 2 === 1;
      const r = detectFlashes(frames(fps * 2, at), { ...opts(), fps });
      expect(r.severity).toBe("major");
      expect(r.maxFlashesPerSecond).toBe(5);
    }
  });

  it("a non-uniform (staggered) fade is pooled into one transition", () => {
    // Five 20 % bands switch on at frames 10..14: no single frame reaches 25 %.
    const staggered = Array.from({ length: 30 }, (_, i) => {
      const frame = new Uint8Array(N);
      for (let band = 0; band < 5; band++)
        if (i >= 10 + band) frame.fill(255, band * 200, (band + 1) * 200);
      return frame;
    });
    const r = detectFlashes(staggered, opts());
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ frameIndex: 11, direction: "up" });
    expect(r.maxArea).toBeCloseTo(0.6);
  });

  it("colour range changes the measured luminance swing", () => {
    // Codes 16 ↔ 91: 20.4 cd/m² in full range, 18.9 cd/m² in limited range.
    const clip = frames(60, hz(5), 1, [16, 91]);
    expect(detectFlashes(clip, opts("full")).severity).toBe("major");
    expect(detectFlashes(clip, opts("limited")).events).toEqual([]);
  });

  it("rejects frames of the wrong size", () => {
    expect(() => detectFlashes([new Uint8Array(3)], opts())).toThrow();
  });

  it("an unmeasured result is never passed", () => {
    const check = photosensitivityCheck({ measured: false, reason: "VFR" });
    expect(check).toMatchObject({
      passed: false,
      analysisMode: "not-performed",
    });
    expect(() => qualityCheckSchema.parse(check)).not.toThrow();
  });
});

describe("analyzeFlashes (real FFmpeg)", () => {
  let root: string;
  const make = async (name: string, filter: string, extra: string[] = []) => {
    const path = join(root, name);
    await runProcess("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      filter,
      "-t",
      "2",
      ...extra,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      path,
    ]);
    return path;
  };
  const square = (period: number) =>
    `nullsrc=s=320x180:r=30,format=yuv420p,geq=lum='if(lt(mod(N,${period}),${period / 2}),235,16)':cb=128:cr=128`;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "veyra-flash-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("flags a 5 Hz MP4 and passes a 2 Hz one", async () => {
    const five = await analyzeFlashes(await make("5hz.mp4", square(6)));
    expect(five).toMatchObject({
      measured: true,
      severity: "major",
      fps: 30,
      framesAnalyzed: 60,
      maxFlashesPerSecond: 5,
    });
    const two = await analyzeFlashes(
      await make(
        "2hz.mp4",
        "nullsrc=s=320x180:r=30,format=yuv420p,geq=lum='if(lt(mod(2*N,30),15),235,16)':cb=128:cr=128",
      ),
    );
    expect(two).toMatchObject({
      measured: true,
      severity: "info",
      maxFlashesPerSecond: 2,
    });
  });

  it("reports a variable frame rate video as not measured", async () => {
    const vfr = await make("vfr.mp4", "testsrc=s=160x90:r=30", [
      "-vf",
      "setpts='if(lt(N,30),N/30,1+(N-30)/10)/TB'",
      "-fps_mode",
      "vfr",
    ]);
    const r = await analyzeFlashes(vfr);
    expect(r.measured).toBe(false);
    expect(photosensitivityCheck(r).passed).toBe(false);
  });

  it("enforces the frame cap", async () => {
    const path = await make("cap.mp4", square(6));
    await expect(analyzeFlashes(path, { maxFrames: 10 })).rejects.toThrow(
      /exceeded 10 frames/,
    );
  });
});
