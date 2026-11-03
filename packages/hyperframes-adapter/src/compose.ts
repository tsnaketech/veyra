import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  captionStyleSchema,
  captionTrackSchema,
  firstFrameAtOrAfter,
  storyboardSchema,
  type CaptionStyle,
} from "@veyra/schemas";
import { safePath } from "@veyra/storage";
import { buildComponentScene, motionCss, scriptJson } from "@veyra/motion";
const require = createRequire(import.meta.url);
export const animationSchema = z
  .object({
    enter: z.enum(["fade", "slide-up", "scale"]).default("fade"),
    durationMs: z.number().int().min(0).max(1500).default(500),
    easing: z
      .enum(["none", "power1.out", "power2.out", "power3.out", "sine.out"])
      .default("power2.out"),
  })
  .strict();
export const formatSchema = z.object({
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
});
export const styleSchema = z.object({
  palette: z.object({
    violet: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    blue: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    cyan: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  fonts: z
    .array(z.string().regex(/^[A-Za-z][A-Za-z0-9 -]{0,63}$/))
    .min(1)
    .max(8),
});
export type CompositionFiles = Record<"index.html" | "gsap.min.js", string>;
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
export function compose(
  storyboard: unknown,
  format: unknown,
  style: unknown,
  captions?: unknown,
): CompositionFiles {
  const board = storyboardSchema.parse(storyboard),
    dimensions = formatSchema.parse(format),
    brand = styleSchema.parse(style),
    layer = captions === undefined ? null : captionLayerSchema.parse(captions);
  if (board.scenes.length < 1 || board.scenes.length > 100)
    throw new Error("Expected 1–100 scenes");
  const durationMs = Math.max(
    ...board.scenes.map((scene) => scene.start + scene.duration),
  );
  if (durationMs > 60000) throw new Error("MVP duration exceeds 60 seconds");
  const clips: string[] = [],
    steps: string[] = [];
  board.scenes.forEach((scene, index) => {
    const animation = animationSchema.parse(scene.animation);
    if (scene.component) {
      const domId = `scene-${index}`,
        start = scene.start / 1000,
        duration = scene.duration / 1000;
      const built = buildComponentScene(scene.component, {
        sceneId: `#${domId}`,
        durationS: duration,
        entryS: animation.durationMs / 1000,
        width: dimensions.width,
        height: dimensions.height,
        palette: brand.palette,
      });
      clips.push(
        `<div class="clip scene" data-start="${start}" data-duration="${duration}" data-track-index="${index}" id="${domId}"><div class="stage align-${built.align}" style="--accent:${brand.palette[built.accent]}">${built.html}</div></div>`,
      );
      // Fixed statements around validated data: components never contribute code.
      // immediateRender applies each start state at build time: staggered or delayed
      // entries stay hidden until they start, on any seek order (T095). Safe because
      // no two entry tweens animate the same property of one element.
      for (const t of built.tweens) {
        const { target, from, to, at, duration: length, ...options } = t;
        steps.push(
          `tl.fromTo(${scriptJson(target)}, ${scriptJson(from)}, ${scriptJson({ ...to, ...options, duration: length, immediateRender: true })}, ${start + at});`,
        );
      }
      for (const c of built.counters)
        steps.push(`veyraCounter(${scriptJson(c)}, ${start + c.at});`);
      // Exit fade on the inner stage (HyperFrames owns the clip itself); none on the last scene.
      if (index < board.scenes.length - 1) {
        const exit = Math.min(0.4, duration * 0.1);
        steps.push(
          `tl.fromTo(${scriptJson(`#${domId} .stage`)}, {opacity:1}, {opacity:0,duration:${exit},ease:"power1.in",immediateRender:false}, ${start + duration - exit});`,
        );
      }
      return;
    }
    const selector = `#text-${index}`,
      start = scene.start / 1000,
      duration = scene.duration / 1000;
    clips.push(
      `<p class="clip" data-start="${start}" data-duration="${duration}" data-track-index="${index}" id="text-${index}">${escapeHtml(scene.text)}</p>`,
    );
    const from =
      animation.enter === "slide-up"
        ? { opacity: 0, y: 60 }
        : animation.enter === "scale"
          ? { opacity: 0, scale: 0.85 }
          : { opacity: 0 };
    steps.push(
      // Only opacity/transform are tweened: HyperFrames owns clip visibility (lint rule gsap_animates_clip_element).
      `tl.fromTo(${JSON.stringify(selector)}, ${JSON.stringify(from)}, {opacity:1,y:0,scale:1,duration:${Math.min(animation.durationMs / 1000, duration)},ease:${JSON.stringify(animation.easing)},immediateRender:false}, ${start});`,
    );
  });
  const captionCss = layer
    ? captionLayer(
        layer,
        dimensions,
        board.scenes.length,
        durationMs,
        clips,
        steps,
      )
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Veyra composition</title>
<style>
*{box-sizing:border-box}html,body{margin:0;width:${dimensions.width}px;height:${dimensions.height}px;overflow:hidden}
#root{position:relative;width:${dimensions.width}px;height:${dimensions.height}px;background:linear-gradient(135deg,${brand.palette.violet},${brand.palette.blue} 60%,${brand.palette.cyan});color:white;font-family:${brand.fonts.map((font) => `'${font}'`).join(",")}}
${motionCss(dimensions.width, dimensions.height)}
.clip{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:8%;font-size:${Math.round(dimensions.width / 20)}px;font-weight:700;line-height:1.15;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;max-width:100%}${captionCss}
</style><script src="./gsap.min.js"></script></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${durationMs / 1000}" data-width="${dimensions.width}" data-height="${dimensions.height}">${clips.join("\n")}</div>
<script>
const tl = gsap.timeline({paused:true});
const veyraFormats = {};
// Counter tweens animate a plain number and write formatted text (fixed code; data from JSON).
function veyraCounter(c, at) {
  const el = document.querySelector(c.target);
  if (!el) return;
  const f = veyraFormats[c.decimals] || (veyraFormats[c.decimals] = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals }));
  const state = { v: c.from };
  tl.to(state, { v: c.to, duration: c.duration, ease: "power1.out", onUpdate: () => { el.textContent = c.prefix + f.format(state.v) + c.suffix; } }, at);
}
tl.to({}, {duration:${durationMs / 1000}}, 0);
${steps.join("\n")}
window.__timelines = window.__timelines || {};
window.__timelines["main"] = tl;
tl.seek(0);
</script></body></html>`;
  return {
    "index.html": html,
    "gsap.min.js": readFileSync(
      require.resolve("gsap/dist/gsap.min.js"),
      "utf8",
    ),
  };
}
const rateSchema = z
  .object({
    num: z.number().int().positive(),
    den: z.number().int().positive(),
  })
  .strict();
const quantizedCueSchema = z
  .object({
    cueId: z.string(),
    startFrame: z.number().int().nonnegative(),
    endFrame: z.number().int().positive(),
    startMs: z.number(),
    endMs: z.number(),
  })
  .strict()
  .refine((c) => c.endFrame > c.startFrame, "A cue holds at least one frame");
/** Caption layer input: the track (text, words, style) and its quantizeCues table. */
export const captionLayerSchema = z
  .object({
    track: captionTrackSchema,
    cues: z.array(quantizedCueSchema),
    rate: rateSchema,
  })
  .strict()
  .superRefine(({ track, cues }, ctx) => {
    const ids = new Set(track.cues.map((cue) => cue.id));
    cues.forEach((cue, i) => {
      if (!ids.has(cue.cueId))
        ctx.addIssue({
          code: "custom",
          path: ["cues", i],
          message: "Unknown cue",
        });
      if (i && cue.startFrame < cues[i - 1].endFrame)
        ctx.addIssue({
          code: "custom",
          path: ["cues", i],
          message: "Cues overlap",
        });
    });
  });
export type CaptionLayer = z.input<typeof captionLayerSchema>;

const captionFonts: Record<CaptionStyle["font"], string> = {
  inter: "'Inter',sans-serif",
  "system-sans": "system-ui,'Segoe UI',Roboto,Arial,sans-serif",
  serif: "Georgia,'Times New Roman',serif",
};
/** Caption sizes in composition px; the single source for the CSS, captionBandRect and line fitting. */
export function captionMetrics(
  style: CaptionStyle,
  { width, height }: Dimensions,
) {
  const font = Math.round((style.sizePct * height) / 100);
  return {
    font,
    lineHeight: Math.round(font * 1.25),
    padX: Math.round(font * 0.5),
    padY: Math.round(font * 0.3),
    margin: Math.round((style.safeMarginPct * height) / 100),
    // Box and text column stay inside the 5 % horizontal safe zone.
    inset: Math.round(width * 0.05),
  };
}
type Dimensions = z.infer<typeof formatSchema>;
export interface CaptionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/**
 * Caption zone in composition px, by construction (the CSS uses the same numbers):
 * - band: full-width background strip;
 * - box: background column inset by 5 % of the width on each side;
 * - none: the same column, holding only the text (no background, so no reliable
 *   contrast zone).
 * Height is lineCount line boxes plus vertical padding; y follows position and
 * safeMarginPct (percent of the height) from the top or bottom edge.
 */
export function captionBandRect(
  style: unknown,
  format: unknown,
  lineCount: number,
): CaptionRect {
  const s = captionStyleSchema.parse(style),
    size = formatSchema.parse(format),
    lines = z.number().int().min(1).max(3).parse(lineCount),
    m = captionMetrics(s, size);
  const height = lines * m.lineHeight + 2 * m.padY;
  const y =
    s.position === "top"
      ? m.margin
      : s.position === "middle"
        ? Math.round((size.height - height) / 2)
        : size.height - m.margin - height;
  return s.background === "band"
    ? { x: 0, y, width: size.width, height }
    : { x: m.inset, y, width: size.width - 2 * m.inset, height };
}
const rgba = (hex: string, alpha: number) =>
  `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",")},${alpha})`;

/** Appends one clip per quantized cue (above every scene) and its tweens; returns the CSS. */
function captionLayer(
  { track, cues, rate }: z.infer<typeof captionLayerSchema>,
  dimensions: Dimensions,
  trackIndex: number,
  durationMs: number,
  clips: string[],
  steps: string[],
): string {
  const style = track.style,
    m = captionMetrics(style, dimensions),
    byId = new Map(track.cues.map((cue) => [cue.id, cue]));
  // Exact rational frame times: the quantized frames are the only timing source.
  const seconds = (frames: number) => (frames * rate.den) / rate.num;
  const frame = seconds(1);
  const word =
    style.animation === "word-highlight" || style.animation === "karaoke";
  cues.forEach((q, i) => {
    const cue = byId.get(q.cueId)!,
      id = `cue-${i}`,
      start = seconds(q.startFrame),
      duration = seconds(q.endFrame - q.startFrame);
    if (seconds(q.endFrame) > durationMs / 1000 + 1e-9)
      throw new Error("Caption cue ends after the composition");
    const tokens = cue.lines.map((line) => line.split(" ").filter(Boolean));
    const words = track.words.slice(cue.wordStart, cue.wordEnd);
    // shortcut: lines edited so they no longer match the words are shown without word timing.
    const timed = word && tokens.flat().length === words.length;
    const on = words.map((w) =>
      Math.min(
        q.endFrame - 1,
        Math.max(q.startFrame, firstFrameAtOrAfter(w.startMs, rate)),
      ),
    );
    // Highlighted on [on[k], off[k]); karaoke keeps every word until the cue ends.
    const off = on.map((_, k) =>
      style.animation === "word-highlight" && k + 1 < on.length
        ? on[k + 1]
        : q.endFrame,
    );
    let k = 0;
    const lines = tokens
      .map(
        (line) =>
          `<span class="cue-line">${line
            .map((text) => {
              const n = k++;
              const lit = timed && on[n] === q.startFrame && off[n] > on[n];
              return `<span class="w w${n}${lit ? " on" : ""}">${escapeHtml(text)}</span>`;
            })
            .join(" ")}</span>`,
      )
      .join("");
    clips.push(
      `<div class="clip cue l${cue.lines.length}" data-start="${start}" data-duration="${duration}" data-track-index="${trackIndex}" id="${id}"><div class="cue-text">${lines}</div></div>`,
    );
    // Entries animate the text only: the background (QA zone) is exact on startFrame.
    // One entry tween per property and element (T095); exits use immediateRender:false.
    const entry = Math.min(0.2, duration / 2);
    if (style.animation === "fade")
      steps.push(
        `tl.fromTo(${scriptJson(`#${id} .cue-text`)}, {opacity:0}, {opacity:1,duration:${entry},ease:"power1.out",immediateRender:true}, ${start});`,
      );
    if (style.animation === "pop")
      steps.push(
        `tl.fromTo(${scriptJson(`#${id} .cue-text`)}, {opacity:0,scale:0.8}, {opacity:1,scale:1,duration:${entry},ease:"back.out(2)",immediateRender:true}, ${start});`,
      );
    if (!timed) return;
    // Colour switches end a quarter frame before the boundary: the frame at the
    // boundary shows the new state and no frame lands inside a tween.
    const at = (f: number) => seconds(f) - frame / 2;
    on.forEach((f, n) => {
      if (off[n] <= f) return;
      const target = scriptJson(`#${id} .w${n}`),
        base = scriptJson({ color: style.textColor }),
        lit = scriptJson({ color: style.highlightColor });
      if (f > q.startFrame)
        steps.push(
          `tl.fromTo(${target}, ${base}, {color:${scriptJson(style.highlightColor)},duration:${frame / 4},ease:"none",immediateRender:true}, ${at(f)});`,
        );
      if (off[n] < q.endFrame)
        steps.push(
          `tl.fromTo(${target}, ${lit}, {color:${scriptJson(style.textColor)},duration:${frame / 4},ease:"none",immediateRender:false}, ${at(off[n])});`,
        );
    });
  });
  const rule = (lines: number) => {
    const r = captionBandRect(style, dimensions, lines);
    return `.clip.cue.l${lines}{left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px}`;
  };
  const o = Math.max(1, Math.round(m.font * 0.06)),
    shadow = [-o, 0, o]
      .flatMap((x) => [-o, 0, o].map((y) => [x, y]))
      .filter(([x, y]) => x || y)
      .map(([x, y]) => `${x}px ${y}px 0 ${style.backgroundColor}`)
      .join(",");
  return `
.clip.cue{inset:auto;z-index:10;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:${m.padY}px ${m.padX}px;margin:0;max-width:none;font-family:${captionFonts[style.font]};font-size:${m.font}px;font-weight:600;line-height:${m.lineHeight}px;white-space:nowrap;overflow-wrap:normal;color:${style.textColor};background:${style.background === "none" ? "transparent" : rgba(style.backgroundColor, style.backgroundOpacity)}${style.outline ? `;text-shadow:${shadow}` : ""}}
.cue-line{display:block}.cue .w.on{color:${style.highlightColor}}
${[1, 2, 3].map(rule).join("")}`;
}
export function writeComposition(dir: string, files: CompositionFiles): void {
  for (const name of ["index.html", "gsap.min.js"] as const)
    writeFileSync(safePath(dir, name), files[name], { mode: 0o600 });
}
