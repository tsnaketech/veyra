import { describe, expect, it } from "vitest";
import { compose } from "./compose";
import { motionDemoStoryboard } from "./demo";
const style = {
  palette: { violet: "#7C3AED", blue: "#2563EB", cyan: "#06B6D4" },
  fonts: ["Inter", "sans-serif"],
};
const board = {
  width: 1920,
  height: 1080,
  fps: 30,
  scenes: [
    {
      id: "scn_one",
      start: 0,
      duration: 2000,
      text: '</script><img onerror="alert(1)"> & hello',
      animation: { enter: "slide-up", durationMs: 400, easing: "power2.out" },
    },
  ],
};
it("generates deterministic escaped HTML and local GSAP", () => {
  const files = compose(board, board, style);
  expect(files).toEqual(compose(board, board, style));
  expect(files["index.html"]).toContain(
    "&lt;/script&gt;&lt;img onerror=&quot;alert(1)&quot;&gt; &amp; hello",
  );
  expect(files["index.html"]).toContain('data-duration="2"');
  expect(files["index.html"]).toContain('window.__timelines["main"] = tl;');
  expect(files["index.html"]).not.toContain("https://");
  expect(files["gsap.min.js"]).toContain("GSAP 3.14.2");
  // HyperFrames lint rejects tweens that touch clip visibility.
  expect(files["index.html"]).not.toMatch(/visibility|autoAlpha/);
});
it.each([
  { enter: "run-js" },
  { durationMs: 5000 },
  { easing: "evil()" },
  { onComplete: 'fetch("secret")' },
])("rejects unsafe animation %j", (animation) => {
  expect(() =>
    compose(
      { ...board, scenes: [{ ...board.scenes[0], animation }] },
      board,
      style,
    ),
  ).toThrow();
});
it("rejects unsafe CSS and invalid storyboard data", () => {
  expect(() =>
    compose(board, board, { ...style, fonts: ["Inter;}</style><script>"] }),
  ).toThrow();
  expect(() =>
    compose(board, board, {
      ...style,
      palette: { ...style.palette, blue: "url(https://example.com)" },
    }),
  ).toThrow();
  expect(() => compose({ ...board, scenes: [] }, board, style)).toThrow();
  expect(() =>
    compose(
      { ...board, scenes: [{ ...board.scenes[0], duration: 61000 }] },
      board,
      style,
    ),
  ).toThrow();
});

describe("motion components in compositions", () => {
  const style = {
    palette: { violet: "#7C3AED", blue: "#2563EB", cyan: "#06B6D4" },
    fonts: ["Inter"],
  };
  it("renders registered components as clips with data-only tweens and keeps text scenes", () => {
    const board = motionDemoStoryboard();
    board.scenes.push({
      id: "scn_legacy",
      start: 20000,
      duration: 2000,
      text: "Scène texte",
      animation: { enter: "fade", durationMs: 500, easing: "power2.out" },
    });
    const html = compose(board, board, style)["index.html"];
    expect(html.match(/class="clip scene"/g)).toHaveLength(5);
    expect(html).toContain(
      '<p class="clip" data-start="20" data-duration="2" data-track-index="5" id="text-5">Scène texte</p>',
    );
    expect(html).toContain(
      'veyraCounter({"target":"#scene-3 .metric-0 .value"',
    );
    expect(html).not.toMatch(/visibility|autoAlpha/);
  });
  it("cannot be used to inject markup or script through parameters", () => {
    const board = motionDemoStoryboard();
    const evil = "</script><script>alert(1)</script>";
    (board.scenes[0].component!.params as { title: string }).title = evil.slice(
      0,
      60,
    );
    (
      board.scenes[3].component!.params as { metrics: { suffix: string }[] }
    ).metrics[0].suffix = "</scr";
    const html = compose(board, board, style)["index.html"];
    expect(html.match(/<script/g)).toHaveLength(2); // gsap.min.js + Veyra's own timeline
    expect(html).not.toContain("alert(1)</script>");
    const bad = motionDemoStoryboard();
    (bad.scenes[1].component!.params as { cards: unknown[] }).cards = [];
    expect(() => compose(bad, bad, style)).toThrow();
    const unknown = motionDemoStoryboard();
    unknown.scenes[0].component!.id = "custom-js";
    expect(() => compose(unknown, unknown, style)).toThrow(/inconnu/);
  });
});
