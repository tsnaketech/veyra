import { expect, it } from "vitest";
import { resolveAnchor, type Storyboard } from "@veyra/schemas";
import {
  buildComponentScene,
  motionComponents,
  normalizeComponent,
  visualEventSchema,
  visualTimeline,
} from "./index";
const board: Storyboard = {
  width: 1920,
  height: 1080,
  fps: 30,
  scenes: motionComponents.map((c, i) => ({
    id: `scn_demo-${i}`,
    start: i * 4000,
    duration: 4000,
    text: c.name,
    animation: { durationMs: 800 },
    component: normalizeComponent({ id: c.id, params: c.example }),
  })),
};
const palette = { violet: "#7c3aed", blue: "#2563eb", cyan: "#06b6d4" };
it.each([
  { num: 30, den: 1 },
  { num: 30000, den: 1001 },
])("builds the five-component demo timeline at %j", (rate) => {
  const events = visualTimeline(board, rate);
  expect(events.filter((e) => e.kind === "scene")).toHaveLength(5);
  expect(events.map((e) => e.startMs)).toEqual(
    events.map((e) => e.startMs).sort((a, b) => a - b),
  );
  expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  expect(
    events.find((e) => e.sceneId === "scn_demo-1" && e.name === "scene")
      ?.startFrame,
  ).toBe(rate.den === 1 ? 120 : 119);
  for (const name of [
    "title-reveal",
    "subtitle-appear",
    "card-appear",
    "device-appear",
    "bars-grow",
    "metric-count",
    "headline-appear",
    "button-appear",
    "button-pulse",
  ])
    expect(events.some((e) => e.name === name)).toBe(true);
  board.scenes.forEach((scene, i) => {
    const built = buildComponentScene(scene.component!, {
      sceneId: `#scene-${i}`,
      durationS: 4,
      entryS: 0.8,
      width: board.width,
      height: board.height,
      palette,
    });
    for (const e of built.events)
      expect(
        events.find((v) => v.id === `${scene.id}:${e.name}:${e.index}`),
      ).toMatchObject({
        startMs: scene.start + e.atS * 1000,
        endMs: scene.start + e.endS * 1000,
      });
  });
});
it("emits card events at each staggered tween and metric events at counter times", () => {
  for (const id of ["feature-cards", "metrics-counter"]) {
    const scene = board.scenes.find((s) => s.component?.id === id)!;
    const built = buildComponentScene(scene.component!, {
      sceneId: "#scene-0",
      durationS: 4,
      entryS: 0.8,
      width: 1920,
      height: 1080,
      palette,
    });
    expect(built.events).toHaveLength(3);
    built.events.forEach((e, i) => {
      const animation =
        id === "feature-cards"
          ? built.tweens.find((t) => t.target.endsWith(".card"))!
          : built.counters[i];
      const stagger = "stagger" in animation ? (animation.stagger ?? 0) : 0;
      expect(e.index).toBe(i);
      expect(e.atS).toBe(animation.at + i * stagger);
      expect(e.endS).toBe(e.atS + animation.duration);
    });
  }
});
it("includes the whole word/bar stagger and pulse repeat", () => {
  for (const [index, name, selector, count] of [
    [0, "title-reveal", ".title .w", 7],
    [2, "bars-grow", ".bar", 7],
    [4, "button-pulse", ".button-inner", 1],
  ] as const) {
    const built = buildComponentScene(board.scenes[index].component!, {
      sceneId: "#scene-0",
      durationS: 4,
      entryS: 0.8,
      width: 1920,
      height: 1080,
      palette,
    });
    const t = built.tweens.find((t) => t.target.endsWith(selector))!;
    const e = built.events.find((e) => e.name === name)!;
    expect(e.endS).toBeCloseTo(
      t.at +
        t.duration * (1 + (t.repeat ?? 0)) +
        (count - 1) * (t.stagger ?? 0),
    );
  }
});
it("follows a moved stable scene while absolute anchors stay fixed", () => {
  const rate = { num: 30, den: 1 };
  const anchor = {
    type: "event" as const,
    sceneId: board.scenes[0].id,
    event: "title-reveal",
    offsetMs: 0,
  };
  const before = visualTimeline(board, rate);
  const after = visualTimeline(
    {
      ...board,
      scenes: board.scenes.map((s) => ({ ...s, start: s.start + 1000 })),
    },
    rate,
  );
  expect(resolveAnchor(anchor, before)).toEqual({ atMs: 240 });
  expect(resolveAnchor(anchor, after)).toEqual({ atMs: 1240 });
  expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
  for (const events of [before, after])
    expect(resolveAnchor({ type: "absolute", atMs: 500 }, events)).toEqual({
      atMs: 500,
    });
});
it("supports legacy default/explicit entrances, empty boards and default component pace", () => {
  const rate = { num: 30, den: 1 };
  const legacy = {
    ...board,
    scenes: [
      {
        id: "scn_legacy",
        start: 0,
        duration: 2000,
        text: "Texte",
        animation: {},
      },
    ],
  };
  expect(visualTimeline(legacy, rate)[1]).toMatchObject({
    name: "text-appear",
    startMs: 0,
    endMs: 500,
  });
  expect(
    visualTimeline(
      {
        ...legacy,
        scenes: [{ ...legacy.scenes[0], animation: { durationMs: 1000 } }],
      },
      rate,
    )[1].endMs,
  ).toBe(1000);
  expect(visualTimeline({ ...board, scenes: [] }, rate)).toEqual([]);
  const defaultPace = visualTimeline(
    { ...board, scenes: [{ ...board.scenes[0], animation: {} }] },
    rate,
  );
  expect(defaultPace.find((e) => e.name === "title-reveal")?.startMs).toBe(150);
});
it("validates visual events and omits optional events without rendered tweens", () => {
  expect(
    visualEventSchema.safeParse({ name: "Bad", atS: 0, endS: 1, index: 0 })
      .success,
  ).toBe(false);
  expect(
    visualEventSchema.safeParse({ name: "title", atS: 2, endS: 1, index: 0 })
      .success,
  ).toBe(false);
  const built = buildComponentScene(
    normalizeComponent({ id: "animated-title", params: { title: "Titre" } }),
    {
      sceneId: "#scene-0",
      durationS: 4,
      entryS: 0.5,
      width: 1920,
      height: 1080,
      palette,
    },
  );
  expect(built.events.map((e) => e.name)).toEqual(["title-reveal"]);
});
