import { describe, expect, it } from "vitest";
import {
  anchorSchema,
  assertConstantFrameRate,
  createTimelineEvent,
  frameCount,
  resolveAnchor,
  timelineEventSchema,
} from "./index";
const rate = { num: 30, den: 1 };
const scene = createTimelineEvent(
  {
    id: "scn_a:scene:0",
    kind: "scene",
    sceneId: "scn_a",
    name: "scene",
    startMs: 0,
    endMs: 4000,
    source: "motion",
  },
  rate,
  120,
);
const event = createTimelineEvent(
  {
    id: "scn_a:title-reveal:0",
    kind: "visual",
    sceneId: "scn_a",
    name: "title-reveal",
    startMs: 1000,
    endMs: 1500,
    source: "motion",
  },
  rate,
  120,
);
const anchor = {
  type: "event" as const,
  sceneId: "scn_a",
  event: "title-reveal",
  offsetMs: 20,
};
describe("shared timeline", () => {
  it("resolves absolute, start and end anchors", () => {
    expect(
      resolveAnchor({ type: "absolute", atMs: 200 }, [scene, event]),
    ).toEqual({ atMs: 200 });
    expect(resolveAnchor(anchor, [scene, event])).toEqual({ atMs: 1020 });
    expect(
      resolveAnchor({ ...anchor, edge: "end", offsetMs: -100 }, [scene, event]),
    ).toEqual({ atMs: 1400 });
  });
  it("reports missing events and out-of-bounds times without fallback", () => {
    expect(
      resolveAnchor({ ...anchor, index: 1 }, [scene, event]),
    ).toMatchObject({ error: { code: "event-missing" } });
    expect(
      resolveAnchor({ ...anchor, offsetMs: -1001 }, [scene, event]),
    ).toMatchObject({ error: { code: "before-zero" } });
    expect(
      resolveAnchor({ ...anchor, offsetMs: 4000 }, [scene, event]),
    ).toMatchObject({ error: { code: "after-end" } });
    expect(
      resolveAnchor({ type: "absolute", atMs: 4000 }, [scene, event]),
    ).toEqual({ atMs: 4000 });
    expect(
      resolveAnchor({ type: "absolute", atMs: 4001 }, [scene, event]),
    ).toMatchObject({ error: { code: "after-end" } });
    expect(resolveAnchor({ type: "absolute", atMs: 1 }, [])).toMatchObject({
      error: { code: "after-end" },
    });
  });
  it.each([
    { num: 30, den: 1 },
    { num: 30000, den: 1001 },
  ])("uses frameAt with rate %j and clamps end frames", (r) => {
    const e = createTimelineEvent(
      { ...event, startMs: 1000, endMs: 4000 },
      r,
      frameCount(4000, r),
    );
    expect(e.startFrame).toBe(r.den === 1 ? 30 : 29);
    expect(e.endFrame).toBe(119);
  });
  it("validates names, prefixes, intervals and exclusive anchor forms", () => {
    for (const patch of [
      { name: "Bad name" },
      { sceneId: "rev_a" },
      { index: -1 },
      { endMs: 999 },
      { startFrame: 0.5 },
      { endFrame: 1 },
    ])
      expect(
        timelineEventSchema.safeParse({ ...event, ...patch }).success,
      ).toBe(false);
    expect(anchorSchema.safeParse({ ...anchor, atMs: 1 }).success).toBe(false);
    expect(anchorSchema.safeParse({ ...anchor, offsetMs: 0.5 }).success).toBe(
      false,
    );
  });
  it("rejects VFR explicitly but accepts unknown and CFR media", () => {
    expect(() => assertConstantFrameRate({ constantFrameRate: false })).toThrow(
      "fréquence variable non prise en charge",
    );
    expect(() =>
      assertConstantFrameRate({ constantFrameRate: true }),
    ).not.toThrow();
    expect(() => assertConstantFrameRate(null)).not.toThrow();
  });
});
