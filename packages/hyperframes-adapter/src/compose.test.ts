import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { captionBandRect, compose } from "./compose";
import { captionFixture, layerFor } from "./captions.fixture";
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

describe("caption layer (T113)", () => {
  const theme = {
    palette: { violet: "#7C3AED", blue: "#2563EB", cyan: "#06B6D4" },
    fonts: ["Inter"],
  };
  const film = {
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: [
      { id: "scn_a", start: 0, duration: 3000, text: "A" },
      { id: "scn_b", start: 3000, duration: 3000, text: "B" },
    ],
  };
  const cues = [
    { startMs: 400, endMs: 1100, lines: ["Bonjour à tous"] },
    { startMs: 1300, endMs: 2050, lines: ["Deux lignes", "de texte ici"] },
    { startMs: 4000, endMs: 5900, lines: ["Fin"] },
  ];
  const html = (style = {}, rate = { num: 30, den: 1 }, list = cues) =>
    compose(
      film,
      film,
      theme,
      layerFor(captionFixture(list, style), rate, 6000),
    )["index.html"];
  const clip = (source: string, i: number) =>
    new RegExp(
      `<div class="clip cue l\\d" data-start="([^"]+)" data-duration="([^"]+)" data-track-index="(\\d+)" id="cue-${i}">`,
    ).exec(source)!;

  it("leaves the composition byte-identical without captions", () => {
    const board = motionDemoStoryboard();
    const plain = compose(board, board, theme)["index.html"];
    expect(compose(board, board, theme, undefined)["index.html"]).toBe(plain);
    // Digest of the pre-T113 output (commit 7bb8a06): any byte change fails.
    expect(createHash("sha256").update(plain).digest("hex")).toBe(
      "dd2fb617b03cb7be8fd56c6d02b0467f4b12da1a87bb149cc152f38a4c7cb610",
    );
    expect(plain).not.toContain("cue-");
  });

  it("escapes cue text and renders one span per line and per word", () => {
    const out = html({}, undefined, [
      {
        startMs: 0,
        endMs: 1000,
        lines: ['</script><script>alert("x")</script>', "a --> 'b'"],
      },
    ]);
    expect(out.match(/<script/g)).toHaveLength(2);
    expect(out).toContain(
      '<span class="cue-line"><span class="w w0">&lt;/script&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</span></span>',
    );
    expect(out).toContain(
      '<span class="cue-line"><span class="w w1">a</span> <span class="w w2">--&gt;</span> <span class="w w3">&#39;b&#39;</span></span>',
    );
    expect(out).not.toContain("-->");
  });

  it.each([
    [{ num: 24, den: 1 }],
    [{ num: 30, den: 1 }],
    [{ num: 60, den: 1 }],
    [{ num: 30000, den: 1001 }],
  ])("times clips from quantized frames only at %j", (rate) => {
    const layer = layerFor(captionFixture(cues), rate, 6000);
    const out = compose(film, film, theme, layer)["index.html"];
    layer.cues.forEach((q, i) => {
      const [, start, duration, track] = clip(out, i);
      expect(Number(start)).toBe((q.startFrame * rate.den) / rate.num);
      expect(Number(duration)).toBe(
        ((q.endFrame - q.startFrame) * rate.den) / rate.num,
      );
      // Above every scene track.
      expect(Number(track)).toBe(film.scenes.length);
      // Same frames as the SRT/VTT table, recovered from the seconds.
      expect(Math.round((Number(start) * rate.num) / rate.den)).toBe(
        q.startFrame,
      );
    });
    if (rate.den === 1001) {
      // 400 ms at 29.97: frame 12 starts at 400.4 ms, not at a floored ms.
      expect(layer.cues[0].startFrame).toBe(12);
      expect(clip(out, 0)[1]).toBe("0.4004");
    }
  });

  it("writes data-only animations with the T095 immediateRender rule", () => {
    expect(html({ animation: "none" })).not.toContain(".cue-text");
    const fade = html({ animation: "fade" });
    expect(fade).toContain(
      'tl.fromTo("#cue-0 .cue-text", {opacity:0}, {opacity:1,duration:0.2,ease:"power1.out",immediateRender:true}, 0.4);',
    );
    expect(html({ animation: "pop" })).toMatch(
      /tl\.fromTo\("#cue-1 \.cue-text", \{opacity:0,scale:0\.8\}, \{opacity:1,scale:1,[^}]*immediateRender:true\}, 1\.3\);/,
    );
    const karaoke = html({ animation: "karaoke" });
    // First word lit from the cue start without a tween; later words switch on once.
    expect(karaoke).toContain('<span class="w w0 on">Bonjour</span>');
    expect(karaoke.match(/"#cue-0 \.w1"/g)).toHaveLength(1);
    expect(karaoke).not.toMatch(/"#cue-\d \.w\d".*immediateRender:false/);
    const highlight = html({ animation: "word-highlight" });
    // One entry (true) and one exit (false) per word, never two entries.
    expect(
      highlight.match(/"#cue-0 \.w1".*immediateRender:true/g),
    ).toHaveLength(1);
    expect(
      highlight.match(/"#cue-0 \.w1".*immediateRender:false/g),
    ).toHaveLength(1);
    expect(highlight).not.toMatch(/"#cue-0 \.w2".*immediateRender:false/);
    // Word 1 of cue 0 starts at 633 ms -> frame 19 at 30 fps; its switch runs
    // from half to a quarter frame before 19/30 s.
    const s = 19 / 30 - 1 / 30 / 2;
    expect(highlight).toContain(
      `tl.fromTo("#cue-0 .w1", {"color":"#FFFFFF"}, {color:"#FDE047",duration:${1 / 30 / 4},ease:"none",immediateRender:true}, ${s});`,
    );
    expect(highlight).not.toMatch(/visibility|autoAlpha/);
  });

  it("derives every CSS value from the closed style", () => {
    const out = html({
      font: "serif",
      sizePct: 5,
      textColor: "#112233",
      background: "band",
      backgroundColor: "#C00000",
      backgroundOpacity: 0.5,
      outline: true,
      highlightColor: "#00FF00",
    });
    expect(out).toContain("font-family:Georgia,'Times New Roman',serif");
    expect(out).toContain("font-size:54px");
    expect(out).toContain("line-height:68px");
    expect(out).toContain("color:#112233");
    expect(out).toContain("background:rgba(192,0,0,0.5)");
    expect(out).toContain("text-shadow:-3px -3px 0 #C00000");
    expect(out).toContain(".cue .w.on{color:#00FF00}");
    const r = captionBandRect({ sizePct: 5, background: "band" }, film, 2);
    expect(out).toContain(
      `.clip.cue.l2{left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px}`,
    );
    expect(html({ background: "none" })).toContain("background:transparent");
    expect(html()).not.toContain("text-shadow:-");
  });

  it("places the band or box by construction", () => {
    const size = { width: 1920, height: 1080 };
    // Defaults: 4.2 % -> 45 px font, 56 px lines, 14 px padding, 5 % margin = 54 px.
    expect(captionBandRect({}, size, 1)).toEqual({
      x: 96,
      y: 1080 - 54 - 84,
      width: 1728,
      height: 84,
    });
    expect(captionBandRect({ background: "band" }, size, 2)).toEqual({
      x: 0,
      y: 1080 - 54 - 140,
      width: 1920,
      height: 140,
    });
    expect(
      captionBandRect({ position: "top", background: "none" }, size, 3),
    ).toEqual({
      x: 96,
      y: 54,
      width: 1728,
      height: 196,
    });
    expect(
      captionBandRect({ position: "middle", safeMarginPct: 0 }, size, 1),
    ).toEqual({ x: 96, y: 498, width: 1728, height: 84 });
    expect(() => captionBandRect({}, size, 4)).toThrow();
    expect(() => captionBandRect({ sizePct: 2 }, size, 1)).toThrow();
  });

  it("accepts a last cue on the rounded last frame (review D1: 2750 ms at 30 fps)", () => {
    for (const durationMs of [2750, 1250, 1020, 5017]) {
      const short = {
        ...film,
        scenes: [{ id: "scn_a", start: 0, duration: durationMs, text: "A" }],
      };
      const track = captionFixture([
        { startMs: 0, endMs: durationMs, lines: ["Fin du film"] },
      ]);
      const layer = layerFor(track, { num: 30, den: 1 }, durationMs);
      expect(layer.cues.at(-1)!.endFrame).toBe(
        Math.round((durationMs * 30) / 1000),
      );
      expect(() => compose(short, film, theme, layer)).not.toThrow();
      expect(() =>
        compose(short, film, theme, {
          ...layer,
          cues: [{ ...layer.cues[0], endFrame: layer.cues[0].endFrame + 1 }],
        }),
      ).toThrow(/after the composition/);
    }
  });

  it("rejects caption tables that do not match the track or the film", () => {
    const track = captionFixture(cues);
    const rate = { num: 30, den: 1 };
    const good = layerFor(track, rate, 6000);
    const bad = (layer: unknown) => () => compose(film, film, theme, layer);
    expect(
      bad({ ...good, cues: [{ ...good.cues[0], cueId: "cue_9" }] }),
    ).toThrow();
    expect(bad({ ...good, cues: [good.cues[1], good.cues[0]] })).toThrow();
    expect(
      bad({
        ...good,
        cues: [{ ...good.cues[0], endFrame: good.cues[0].startFrame }],
      }),
    ).toThrow();
    expect(
      bad({ ...good, cues: [{ ...good.cues[2], endFrame: 181 }] }),
    ).toThrow(/after the composition/);
    expect(bad({ ...good, rate: { num: 0, den: 1 } })).toThrow();
    expect(
      bad({
        ...good,
        track: { ...track, style: { ...track.style, css: "x" } },
      }),
    ).toThrow();
  });
});
