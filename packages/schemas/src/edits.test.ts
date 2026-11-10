import { expect, it } from "vitest";
import { editOperationSchema, invalidationPlanSchema } from "./index";

const scn = "scn_00000000-0000-4000-8000-000000000001";
const atr = "atr_music";
const ast = "ast_00000000-0000-4000-8000-000000000002";
const ast2 = "ast_00000000-0000-4000-8000-000000000003";
const cue = "cue_00000000-0000-4000-8000-000000000004";

it("accepts one example of each operation", () => {
  const valid = [
    { op: "scene.update", sceneId: scn, patch: { text: "Nouveau titre" } },
    { op: "scene.update", sceneId: scn, patch: { params: { value: 42 } } },
    { op: "scene.animation", sceneId: scn, animationMs: 600 },
    { op: "scene.transition", sceneId: scn, enter: "slide-up" },
    { op: "scene.duration", sceneId: scn, durationMs: 4000 },
    { op: "media.replace", assetId: ast, withAssetId: ast2 },
    { op: "audio.track", trackId: atr, patch: { gainDb: -6, fadeOutMs: 500 } },
    { op: "voice.narration", sceneId: scn, text: "Bienvenue" },
    { op: "voice.narration", sceneId: scn, text: null },
    { op: "captions.cue", cueId: cue, lines: ["Bonjour", "à tous"] },
    { op: "captions.delivery", mode: "clean" },
  ];
  for (const op of valid) expect(editOperationSchema.parse(op)).toEqual(op);
});

it("refuses unknown operations, wrong ids, empty or out-of-bounds patches and extra keys", () => {
  const invalid = [
    { op: "scene.delete", sceneId: scn },
    { op: "scene.update", sceneId: "rev_x", patch: { text: "x" } },
    { op: "scene.update", sceneId: scn, patch: {} },
    // Fields that belong to other operations are not smuggled through a patch.
    { op: "scene.update", sceneId: scn, patch: { durationMs: 4000 } },
    { op: "scene.duration", sceneId: scn, durationMs: 500 },
    { op: "scene.duration", sceneId: scn, durationMs: 4000.5 },
    { op: "scene.animation", sceneId: scn, animationMs: 5000 },
    { op: "scene.transition", sceneId: scn, enter: "wipe" },
    { op: "media.replace", assetId: ast, withAssetId: ast },
    { op: "media.replace", assetId: ast, withAssetId: "/etc/passwd" },
    { op: "audio.track", trackId: atr, patch: {} },
    { op: "audio.track", trackId: atr, patch: { gainDb: 40 } },
    { op: "voice.narration", sceneId: scn, text: "   " },
    { op: "captions.cue", cueId: cue, lines: [] },
    { op: "captions.cue", cueId: cue, lines: ["deux\nlignes"] },
    { op: "captions.delivery", mode: "sidecar" },
    { op: "scene.transition", sceneId: scn, enter: "fade", shell: "rm -rf /" },
  ];
  for (const op of invalid)
    expect(editOperationSchema.safeParse(op).success, JSON.stringify(op)).toBe(
      false,
    );
});

it("an invalidation plan names its artefacts and causes", () => {
  const plan = {
    scenes: [{ sceneId: scn, change: "unchanged" }],
    artefacts: [
      {
        artefact: "picture",
        status: "reused",
        cause: null,
        reusedFrom: "rev_00000000-0000-4000-8000-000000000005",
        targets: [],
      },
      {
        artefact: "mix",
        status: "invalidated",
        cause: "operation",
        reusedFrom: null,
        targets: [atr],
      },
    ],
  };
  expect(invalidationPlanSchema.parse(plan)).toEqual(plan);
  expect(
    invalidationPlanSchema.safeParse({
      ...plan,
      artefacts: [{ ...plan.artefacts[1], artefact: "cache" }],
    }).success,
  ).toBe(false);
});
