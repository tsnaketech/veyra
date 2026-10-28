import { expect, it } from "vitest";
import { compose } from "./compose";
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
