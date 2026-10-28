import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { storyboardSchema } from "@veyra/schemas";
import { safePath } from "@veyra/storage";
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
): CompositionFiles {
  const board = storyboardSchema.parse(storyboard),
    dimensions = formatSchema.parse(format),
    brand = styleSchema.parse(style);
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
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Veyra composition</title>
<style>
*{box-sizing:border-box}html,body{margin:0;width:${dimensions.width}px;height:${dimensions.height}px;overflow:hidden}
#root{position:relative;width:${dimensions.width}px;height:${dimensions.height}px;background:linear-gradient(135deg,${brand.palette.violet},${brand.palette.blue} 60%,${brand.palette.cyan});color:white;font-family:${brand.fonts.map((font) => `'${font}'`).join(",")}}
.clip{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:8%;font-size:${Math.round(dimensions.width / 20)}px;font-weight:700;line-height:1.15;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;max-width:100%}
</style><script src="./gsap.min.js"></script></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${durationMs / 1000}" data-width="${dimensions.width}" data-height="${dimensions.height}">${clips.join("\n")}</div>
<script>
const tl = gsap.timeline({paused:true});
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
export function writeComposition(dir: string, files: CompositionFiles): void {
  for (const name of ["index.html", "gsap.min.js"] as const)
    writeFileSync(safePath(dir, name), files[name], { mode: 0o600 });
}
