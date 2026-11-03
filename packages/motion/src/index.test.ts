import { describe, expect, it } from "vitest";
import {
  buildComponentScene,
  checkTiming,
  componentDraftSchema,
  componentIds,
  formatCounter,
  getComponent,
  motionComponents,
  motionCss,
  normalizeComponent,
  previewStoryboard,
  resolveComponent,
  scriptJson,
} from "./index";

const ctx = {
  sceneId: "#scene-0",
  durationS: 4,
  entryS: 0.8,
  width: 1920,
  height: 1080,
  palette: { violet: "#7c3aed", blue: "#2563eb", cyan: "#06b6d4" },
};

describe("motion component registry", () => {
  it("keeps FeatureCards numbers white and above the text floor (T104)", () => {
    const rule = motionCss(1920, 1080).match(/\.card-index\{[^}]*\}/)![0];
    // Accent text failed WCAG AA on the gradient; the accent lives on the ::before dash only.
    expect(rule).toContain("color:#fff");
    expect(rule).not.toContain("var(--accent)");
    expect(Number(rule.match(/font-size:(\d+)px/)![1])).toBeGreaterThanOrEqual(
      28,
    );
  });
  it("declares the five components with stable ids, schemas, timing and capabilities", () => {
    expect(componentIds).toEqual([
      "animated-title",
      "feature-cards",
      "product-mockup",
      "metrics-counter",
      "call-to-action",
    ]);
    for (const component of motionComponents) {
      expect(component.version).toBe(1);
      expect(component.capabilities.length).toBeGreaterThan(0);
      const { minMs, defaultMs, maxMs } = component.timing;
      expect(minMs <= defaultMs && defaultMs <= maxMs).toBe(true);
      // The example is valid and builds: this is also what previews render.
      const ref = normalizeComponent({
        id: component.id,
        params: component.example,
      });
      expect(
        typeof (ref.params as Record<string, unknown>)[component.primaryField],
      ).toBe("string");
      const built = buildComponentScene(ref, ctx);
      expect(built.html.length).toBeGreaterThan(10);
      expect(built.tweens.length).toBeGreaterThan(0);
      for (const tween of built.tweens) {
        expect(tween.target.startsWith("#scene-0")).toBe(true);
        expect(tween.at + tween.duration).toBeLessThanOrEqual(ctx.durationS);
      }
    }
  });
  it("escapes every text parameter and never emits script", () => {
    const hostile = '<script>alert(1)</script><img src=x onerror="x()">';
    for (const component of motionComponents) {
      const params = JSON.parse(
        JSON.stringify(component.example).replace(
          /"(?:title|heading|screenTitle|headline)":"[^"]*"/,
          `"${component.primaryField}":${JSON.stringify(hostile.slice(0, 24))}`,
        ),
      );
      const { html } = buildComponentScene(
        normalizeComponent({ id: component.id, params }),
        ctx,
      );
      expect(html).not.toMatch(/<script|<img|onerror=/i);
    }
    expect(scriptJson({ a: "</script><!--" })).not.toMatch(/<\/script|<!--/);
  });
  it("rejects unknown components, parameters, versions and out-of-range values", () => {
    expect(() => getComponent("custom-js")).toThrow(/inconnu/);
    expect(() =>
      resolveComponent({
        id: "animated-title",
        version: 2,
        params: { title: "x" },
      }),
    ).toThrow(/Version/);
    expect(() =>
      normalizeComponent({
        id: "animated-title",
        params: { title: "x", onload: "evil()" },
      }),
    ).toThrow();
    expect(() =>
      normalizeComponent({
        id: "feature-cards",
        params: { cards: [{ title: "seule" }] },
      }),
    ).toThrow();
    expect(() =>
      normalizeComponent({
        id: "animated-title",
        params: { title: "x".repeat(61) },
      }),
    ).toThrow();
    expect(() =>
      componentDraftSchema.parse({
        id: "animated-title",
        params: { title: "x" },
        script: "x",
      }),
    ).toThrow();
    expect(
      componentDraftSchema.parse({
        id: "call-to-action",
        params: { headline: "Go", buttonLabel: "Essai" },
      }),
    ).toMatchObject({ id: "call-to-action" });
  });
  it("enforces each component's duration constraints", () => {
    expect(() => checkTiming("call-to-action", 3000)).not.toThrow();
    expect(() => checkTiming("call-to-action", 9000)).toThrow(/hors de/);
    expect(() => checkTiming("feature-cards", 1000)).toThrow(/hors de/);
  });
  it("counts in French formatting and starts counters at zero", () => {
    expect(
      formatCounter(1200, { decimals: 0, prefix: "", suffix: "" }),
    ).toMatch(/^1\s?200$/u);
    expect(formatCounter(4.8, { decimals: 1, prefix: "", suffix: "/5" })).toBe(
      "4,8/5",
    );
    const built = buildComponentScene(
      normalizeComponent({
        id: "metrics-counter",
        params: getComponent("metrics-counter").example,
      }),
      ctx,
    );
    expect(built.counters.map((c) => [c.from, c.to])).toEqual([
      [0, 38],
      [0, 1200],
      [0, 4.8],
    ]);
  });
  it("builds a one-scene preview storyboard from the example", () => {
    const board = previewStoryboard("product-mockup");
    expect(board.scenes).toHaveLength(1);
    expect(board.scenes[0]).toMatchObject({
      duration: 4000,
      text: "Activité de la semaine",
      component: { id: "product-mockup", version: 1 },
    });
  });
});
