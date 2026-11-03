import { afterAll, expect, it } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getComponent, normalizeComponent } from "@veyra/motion";
import { ProjectStorage } from "@veyra/storage";
import {
  analyzeFlashes,
  contrastRatio,
  measureTextContrast,
  parseCssColor,
  photosensitivityCheck,
  relativeLuminance,
  textContrastCheck,
  type FlashMeasurement,
} from "@veyra/video";
import {
  compose,
  writeComposition,
  HyperFramesEngine,
  motionDemoStoryboard,
  type CompositionCheck,
} from "./index";

// T104: photosensitivity and rendered-contrast checks on real HyperFrames renders (bwrap).
const root = mkdtempSync(join(tmpdir(), "veyra-qa-checks-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const storage = new ProjectStorage(root);
const engine = new HyperFramesEngine();
const theme = {
  palette: { violet: "#7C3AED", blue: "#2563EB", cyan: "#06B6D4" },
  fonts: ["Inter", "sans-serif"],
};
const tiny = {
  width: 64,
  height: 64,
  fps: 30,
  scenes: [{ id: "scn_x", start: 0, duration: 1000, text: "x" }],
};
const gsapJs = compose(tiny, tiny, theme)["gsap.min.js"];
// Optional evidence copy (JSON + MP4) for manual review; nothing is written by default.
const evidence = process.env.VEYRA_QA_EVIDENCE;

const wcag = (a: string, b: string) =>
  contrastRatio(
    relativeLuminance(...parseCssColor(a)!),
    relativeLuminance(...parseCssColor(b)!),
  );

interface Clip {
  id: string;
  html: string;
}
/** Fixed test composition (test data, not AI code): clips on #root, paused GSAP timeline. */
function page(o: {
  width: number;
  height: number;
  seconds: number;
  background: string;
  css: string;
  clips: Clip[];
  script?: string;
}) {
  const clips = o.clips
    .map(
      (c, i) =>
        `<div class="clip" id="${c.id}" data-start="0" data-duration="${o.seconds}" data-track-index="${i}">${c.html}</div>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Veyra QA fixture</title>
<style>*{box-sizing:border-box}html,body{margin:0;width:${o.width}px;height:${o.height}px;overflow:hidden}
#root{position:relative;width:${o.width}px;height:${o.height}px;background:${o.background};font-family:'Inter',sans-serif}
.clip{position:absolute}
${o.css}</style><script src="./gsap.min.js"></script></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${o.seconds}" data-width="${o.width}" data-height="${o.height}">${clips}</div>
<script>
const tl = gsap.timeline({paused:true});
tl.to({}, {duration:${o.seconds}}, 0);
${o.script ?? ""}
window.__timelines = window.__timelines || {};
window.__timelines["main"] = tl;
tl.seek(0);
</script></body></html>`;
}

let n = 0;
async function renderCase(name: string, html: string) {
  const id = `rev_${name.replace(/[^a-z0-9]/gi, "-")}-${n++}`;
  const paths = storage.ensureRevision("prj_qa", id);
  writeComposition(paths.composition, {
    "index.html": html,
    "gsap.min.js": gsapJs,
  });
  const check = await engine.check(paths.composition);
  const { path } = await engine.render(paths.composition, {
    revisionDir: paths.revision,
    outputPath: storage.renderPath("prj_qa", id, `rnd_${n}`),
    quality: "draft",
    fps: 30,
  });
  return { check, video: path };
}

async function contrastOf(
  check: CompositionCheck,
  video: string,
  size: { width: number; height: number },
) {
  const section = check.sections.contrast;
  const zones = (section?.findings ?? []).filter(
    (f) => f.code === "contrast_aa_failure",
  );
  const measurements = zones.length
    ? await measureTextContrast(video, zones, {
        compositionWidth: size.width,
        compositionHeight: size.height,
      })
    : [];
  return {
    section,
    zones,
    measurements,
    check: textContrastCheck(measurements, section),
  };
}

function keep(name: string, data: unknown, video?: string) {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, `${name}.json`), JSON.stringify(data, null, 2));
  if (video) copyFileSync(video, join(evidence, `${name}.mp4`));
}

const small = { width: 960, height: 540 };
const text = (color: string) =>
  `font-size:64px;font-weight:800;line-height:1;color:${color}`;

it("flags a known low-contrast text and re-measures it close to its WCAG ratio", async () => {
  const html = page({
    ...small,
    seconds: 3,
    background: "#2d2877",
    css: `#low{left:80px;top:120px;${text("#2563EB")}}#high{left:80px;top:320px;${text("#ffffff")}}`,
    clips: [
      { id: "low", html: "Faible 0123" },
      { id: "high", html: "Lisible 4567" },
    ],
  });
  const { check, video } = await renderCase("contrast-low", html);
  const result = await contrastOf(check, video, small);
  keep(
    "a-contrast-low",
    {
      hf: result.section,
      measurements: result.measurements,
      check: result.check,
    },
    video,
  );
  const expected = wcag("#2563EB", "#2d2877"); // ≈ 2.4:1, below the 3:1 large-text floor
  // HyperFrames reports the low text only; the white one passes and exposes no box.
  expect(result.zones.map((z) => z.selector ?? z.text).join()).toMatch(
    /low|Faible/,
  );
  expect(result.zones.some((z) => /Lisible/.test(z.text ?? ""))).toBe(false);
  expect(result.section?.checked).toBeGreaterThanOrEqual(2);
  const low = result.measurements.find((m) => /Faible/.test(m.text ?? ""))!;
  expect(low.result.status).toBe("measured");
  if (low.result.status !== "measured") return;
  // Tolerance: anti-aliased edges and x264 4:2:0 chroma on draft quality → ±15 % of the theoretical ratio.
  expect(Math.abs(low.result.ratio - expected) / expected).toBeLessThan(0.15);
  expect(low.result.confidence).toBe("normal");
  expect(low.transient).toBe(false);
  expect(result.check).toMatchObject({
    passed: false,
    severity: "minor",
    analysisMode: "deterministic",
  });
}, 240000);

it("never reports a reliable ratio for text over a striped or strong-gradient background", async () => {
  const html = page({
    ...small,
    seconds: 3,
    background: "#2d2877",
    css: [
      ".clip{padding:12px 16px}",
      `#stripes{left:40px;top:60px;background:repeating-linear-gradient(90deg,#111 0 7px,#eee 7px 14px);${text("#6b7280")}}`,
      `#gradient{left:40px;top:300px;background:linear-gradient(90deg,#000,#fff);${text("#8a8a8a")}}`,
    ].join(""),
    clips: [
      { id: "stripes", html: "Rayures 12" },
      { id: "gradient", html: "Dégradé 34" },
    ],
  });
  const { check, video } = await renderCase("overlay", html);
  const result = await contrastOf(check, video, small);
  keep(
    "b-overlay",
    {
      hf: result.section,
      measurements: result.measurements,
      check: result.check,
    },
    video,
  );
  console.info(
    "overlay:",
    JSON.stringify({
      checked: result.section?.checked,
      passed: result.section?.passed,
      zones: result.zones.map((z) => [z.text, z.ratio, z.bg, z.severity]),
      measured: result.measurements.map((m) => [m.text, m.result]),
    }),
  );
  // HyperFrames 0.8.214 flags the gradient text (striped one passes its DOM check).
  expect(result.zones.length).toBeGreaterThan(0);
  // Every re-measured zone is either unmeasurable or flagged low confidence.
  for (const m of result.measurements)
    if (m.result.status === "measured")
      expect({ text: m.text, confidence: m.result.confidence }).toEqual({
        text: m.text,
        confidence: "low",
      });
  const evidenceJson = JSON.parse(result.check.evidence);
  if (result.measurements.length)
    for (const zone of evidenceJson.zones ?? [])
      expect(
        zone.confiance === "faible" || /non mesurable/.test(zone.statut),
      ).toBe(true);
}, 240000);

it("labels a fading low-contrast text consistently with HyperFrames", async () => {
  const html = page({
    ...small,
    seconds: 5,
    background: "#2d2877",
    css: `#fade{left:80px;top:120px;opacity:0;${text("#2563EB")}}#blink{left:80px;top:320px;opacity:0;${text("#2563EB")}}`,
    clips: [
      { id: "fade", html: "Fondu 0123" },
      { id: "blink", html: "Bref 4567" },
    ],
    // A slow fade-in, and a short pulse (visible about 0.6 s) to provoke a transient finding.
    script: [
      `tl.fromTo("#fade", {opacity:0}, {opacity:1, duration:4, ease:"none", immediateRender:true}, 0);`,
      `tl.fromTo("#blink", {opacity:0}, {opacity:1, duration:0.2, ease:"none", immediateRender:true}, 2.3);`,
      `tl.to("#blink", {opacity:0, duration:0.2, ease:"none"}, 2.7);`,
    ].join("\n"),
  });
  const { check, video } = await renderCase("fade", html);
  const result = await contrastOf(check, video, small);
  keep(
    "c-fade",
    {
      hf: result.section,
      measurements: result.measurements,
      check: result.check,
    },
    video,
  );
  console.info(
    "fade:",
    JSON.stringify({
      samples: (result.section as { samples?: unknown })?.samples,
      zones: result.zones.map((z) => [
        z.text,
        z.severity,
        z.ratio,
        z.time,
        z.times,
      ]),
      measured: result.measurements.map((m) => [
        m.text,
        m.transient,
        m.timeMs,
        m.result,
      ]),
    }),
  );
  expect(result.zones.length).toBeGreaterThan(0);
  const evidenceJson = JSON.parse(result.check.evidence);
  for (const [i, m] of result.measurements.entries()) {
    // transient ⇔ HyperFrames "warning"; the evidence label follows it for measured zones.
    expect(m.transient).toBe(result.zones[i].severity === "warning");
    if (m.result.status === "measured")
      expect(evidenceJson.zones[i].statut).toBe(
        m.transient ? "transitoire" : "mesuré",
      );
  }
  // The fading zone is judged at its most legible failing instant, not at its first one.
  const fade = result.measurements.find((m) => /Fondu/.test(m.text ?? ""));
  if (fade) {
    const reliable = fade.samples.flatMap((s) =>
      s.result.status === "measured" && s.result.confidence === "normal"
        ? [s.result.ratio]
        : [],
    );
    expect(fade.samples.length).toBeGreaterThan(1);
    const fadeZone = result.zones.find((z) => /Fondu/.test(z.text ?? ""))!;
    expect(fade.samples[0].timeMs).toBe(Math.round(fadeZone.time! * 1000));
    if (reliable.length) {
      expect(fade.result.status === "measured" && fade.result.ratio).toBe(
        Math.max(...reliable),
      );
      if (Math.max(...reliable) / Math.min(...reliable) - 1 > 0.2)
        expect(
          evidenceJson.zones[result.measurements.indexOf(fade)].notes,
        ).toContain("variable (animation probable)");
    }
  }
}, 240000);

it("FeatureCards (violet and blue accents) exposes no failing zone: contrast check not-performed", async () => {
  for (const accent of ["violet", "blue"] as const) {
    const board = {
      width: 1920,
      height: 1080,
      fps: 30,
      scenes: [
        {
          id: "scn_cards",
          start: 0,
          duration: 5000,
          text: "Cartes",
          animation: { enter: "fade", durationMs: 800, easing: "power2.out" },
          component: normalizeComponent({
            id: "feature-cards",
            params: getComponent("feature-cards").example,
            style: { accent },
          }),
        },
      ],
    };
    const { check, video } = await renderCase(
      `cards-${accent}`,
      compose(board, board, theme)["index.html"],
    );
    const result = await contrastOf(check, video, board);
    keep(
      `d-feature-cards-${accent}`,
      { hf: result.section, check: result.check },
      video,
    );
    expect(result.zones).toEqual([]);
    expect(result.section?.checked).toBeGreaterThan(0);
    expect(result.check).toMatchObject({
      passed: false,
      severity: "info",
      analysisMode: "not-performed",
    });
  }
}, 300000);

function flashPage(hz: number, seconds: number) {
  const half = 1 / (2 * hz);
  return page({
    ...small,
    seconds,
    background: "#000",
    css: "#flash{inset:0;background:#fff;opacity:0}",
    clips: [{ id: "flash", html: "" }],
    // Square wave driven by the paused timeline: finite repeat, no timer.
    script: `tl.fromTo("#flash", {opacity:0}, {opacity:1, duration:${half}, ease:"steps(1)", repeat:${Math.round(seconds * hz * 2) - 2}, yoyo:true, immediateRender:true}, ${half});`,
  });
}

it("flags a 5 Hz full-screen flash as major and passes a 2 Hz one", async () => {
  const fast = await renderCase("flash-5hz", flashPage(5, 3));
  const slow = await renderCase("flash-2hz", flashPage(2, 3));
  const f5 = (await analyzeFlashes(fast.video)) as FlashMeasurement;
  const f2 = (await analyzeFlashes(slow.video)) as FlashMeasurement;
  const c5 = photosensitivityCheck(f5),
    c2 = photosensitivityCheck(f2);
  keep("e-flash-5hz", { flashes: f5, check: c5 }, fast.video);
  keep("e-flash-2hz", { flashes: f2, check: c2 }, slow.video);
  console.info(
    "flash:",
    JSON.stringify({
      f5: [f5.maxFlashesPerSecond, f5.maxArea, f5.severity],
      f2: [f2.maxFlashesPerSecond, f2.maxArea, f2.severity],
    }),
  );
  expect(f5.measured && f2.measured).toBe(true);
  expect(f5.maxFlashesPerSecond).toBeGreaterThanOrEqual(4);
  expect(f5.maxArea).toBeGreaterThan(0.9);
  expect(c5).toMatchObject({
    passed: false,
    severity: "major",
    analysisMode: "deterministic",
  });
  expect(f2.maxFlashesPerSecond).toBeLessThanOrEqual(2);
  expect(c2).toMatchObject({
    passed: true,
    severity: "info",
    analysisMode: "deterministic",
  });
}, 240000);

// T095 before/after: the old `immediateRender:false` entries flashed text for one frame;
// neither variant may raise a photosensitivity alert (the flash is small and single).
it("five-component demo, current and pre-T095 entries: no photosensitivity alert", async () => {
  const board = motionDemoStoryboard();
  const current = compose(board, board, theme)["index.html"];
  expect(current).toContain(`"immediateRender":true`);
  const old = current.replaceAll(
    `"immediateRender":true`,
    `"immediateRender":false`,
  );
  const summary: Record<string, unknown> = {};
  for (const [name, html] of [
    ["current", current],
    ["pre-t095", old],
  ] as const) {
    const { check, video } = await renderCase(`demo-${name}`, html);
    const flashes = (await analyzeFlashes(video)) as FlashMeasurement;
    const flashCheck = photosensitivityCheck(flashes);
    const contrast = await contrastOf(check, video, board);
    summary[name] = {
      maxFlashesPerSecond: flashes.maxFlashesPerSecond,
      maxFlashesPerSecondSmallArea: flashes.maxFlashesPerSecondSmallArea,
      maxArea: flashes.maxArea,
      events: flashes.events.length,
      smallAreaEvents: flashes.smallAreaEvents.length,
      severity: flashes.severity,
      hfChecked: contrast.section?.checked,
      hfPassed: contrast.section?.passed,
      hfZones: contrast.zones.map((z) => [z.text, z.severity, z.ratio, z.time]),
      rendered: contrast.measurements.map((m) => [m.text, m.result]),
      contrastCheck: [
        contrast.check.passed,
        contrast.check.severity,
        contrast.check.analysisMode,
      ],
    };
    keep(
      `demo-${name}`,
      { flashes, flashCheck, hf: contrast.section, contrast: contrast.check },
      video,
    );
    expect(flashCheck).toMatchObject({
      passed: true,
      severity: "info",
      analysisMode: "deterministic",
    });
  }
  console.info("demo:", JSON.stringify(summary));
}, 600000);
