// pnpm motion:previews [--out DIR] [--demo FILE.mp4]
// Renders every registered component (and optionally the demo) with real HyperFrames.
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  motionComponents,
  previewStoryboard,
  registryVersion,
} from "@veyra/motion";
import type { Storyboard } from "@veyra/schemas";
import { ProjectStorage } from "@veyra/storage";
import { fileInput, runProcess } from "@veyra/video";
import { createRequire } from "node:module";
import {
  compose,
  HyperFramesEngine,
  motionDemoStoryboard,
  writeComposition,
} from "./index";

const hyperframesVersion = (
  createRequire(import.meta.url)("hyperframes/package.json") as {
    version: string;
  }
).version;
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = process.env.INIT_CWD ?? process.cwd();
const at = (path: string) => (isAbsolute(path) ? path : resolve(base, path));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = at(
  option("out") ?? join(repoRoot, "apps/studio/static/motion-previews"),
);
const style = {
  palette: { violet: "#7C3AED", blue: "#2563EB", cyan: "#06B6D4" },
  fonts: ["Inter", "sans-serif"],
};
const root = mkdtempSync(join(tmpdir(), "veyra-previews-"));
const storage = new ProjectStorage(root);
const engine = new HyperFramesEngine();

async function render(name: string, board: Storyboard) {
  const paths = storage.ensureRevision("prj_previews", `rev_${name}`);
  writeComposition(paths.composition, compose(board, board, style));
  const check = await engine.check(paths.composition);
  const started = Date.now();
  const result = await engine.render(paths.composition, {
    revisionDir: paths.revision,
    outputPath: storage.renderPath(
      "prj_previews",
      `rev_${name}`,
      "rnd_preview",
    ),
    quality: "draft",
    fps: 30,
  });
  const findings = Object.values(check.sections).flatMap((s) => s.findings);
  return {
    path: result.path,
    renderSeconds: Math.round(((Date.now() - started) / 1000) * 10) / 10,
    check: {
      ok: check.ok,
      errors: findings.filter((f) => f.severity === "error").map((f) => f.code),
      warnings: [
        ...new Set(
          findings.filter((f) => f.severity !== "error").map((f) => f.code),
        ),
      ],
    },
  };
}

mkdirSync(out, { recursive: true });
const manifest = [];
for (const component of motionComponents) {
  const board = previewStoryboard(component.id);
  const result = await render(component.id, board);
  // Settled frame: after the entrance, before the exit.
  const seconds = (component.timing.defaultMs * 0.7) / 1000;
  await runProcess("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-ss",
    String(seconds),
    ...fileInput(result.path),
    "-frames:v",
    "1",
    "-vf",
    "scale=960:-2",
    join(out, `${component.id}.png`),
  ]);
  manifest.push({
    id: component.id,
    image: `${component.id}.png`,
    frameAtSeconds: seconds,
    renderSeconds: result.renderSeconds,
    check: result.check,
  });
  console.log(
    `${component.id}: ${result.renderSeconds} s, check ${result.check.ok ? "ok" : "KO"} ${result.check.errors.join(",")}`,
  );
}
writeFileSync(
  join(out, "index.json"),
  JSON.stringify(
    {
      registryVersion,
      engine: `HyperFrames ${hyperframesVersion} (bwrap, draft)`,
      generatedAt: new Date().toISOString(),
      previews: manifest,
    },
    null,
    2,
  ) + "\n",
);
const demo = option("demo");
if (demo) {
  const result = await render("demo", motionDemoStoryboard());
  copyFileSync(result.path, at(demo));
  console.log(
    `demo: ${at(demo)} (${result.renderSeconds} s, check ${result.check.ok ? "ok" : "KO"})`,
  );
}
rmSync(root, { recursive: true, force: true });
