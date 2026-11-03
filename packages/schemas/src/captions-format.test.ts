import { describe, expect, it } from "vitest";
import {
  captionCueSchema,
  captionPrecisionSummary,
  captionRulesSchema,
  captionStyleSchema,
  captionTrackSchema,
  frameDurationMs,
  groupCaptions,
  parseSrt,
  parseWebVtt,
  quantizeCues,
  sceneFallbackWords,
  toSrt,
  toWebVtt,
  tokenizeNarration,
  type CaptionWord,
} from "./index";

const NB = " ";
const style = captionStyleSchema.parse({});
const rules = captionRulesSchema.parse({});
// Words of 300 ms separated by 50 ms.
const words = (texts: string[], sceneId: string | null = null, at = 0) =>
  texts.map((text, i): CaptionWord => ({
    text,
    startMs: at + i * 350,
    endMs: at + i * 350 + 300,
    confidence: null,
    timing: "tts",
    sceneId,
  }));

describe("tokenizeNarration", () => {
  it("keeps apostrophes and punctuation inside words", () => {
    expect(tokenizeNarration("  L'équipe   d’Anna,\tarrive.\n")).toEqual([
      "L'équipe",
      "d’Anna,",
      "arrive.",
    ]);
  });
  it("binds French-spaced marks and numbers to their neighbour", () => {
    expect(tokenizeNarration("« Bonjour ! » Hausse de 3,5 % ?")).toEqual([
      `«${NB}Bonjour${NB}!${NB}»`,
      "Hausse",
      "de",
      `3,5${NB}%${NB}?`,
    ]);
    expect(tokenizeNarration("")).toEqual([]);
    expect(tokenizeNarration(" ! ")).toEqual(["!"]);
  });
});

describe("sceneFallbackWords", () => {
  const scenes = [
    {
      id: "scn_a",
      start: 0,
      duration: 3000,
      narration: { text: "Une phrase plutôt longue à lire." },
    },
    { id: "scn_b", start: 3000, duration: 1000 },
    { id: "scn_c", start: 4000, duration: 2001, narration: { text: "Fin." } },
  ];
  it("spreads words inside each scene, monotonic, timing scene", () => {
    const result = sceneFallbackWords(scenes);
    expect(result.map((w) => w.sceneId)).toEqual([
      ...Array(6).fill("scn_a"),
      "scn_c",
    ]);
    for (const w of result) {
      const scene = scenes.find((s) => s.id === w.sceneId)!;
      expect(w.timing).toBe("scene");
      expect(w.confidence).toBeNull();
      expect(w.startMs).toBeGreaterThanOrEqual(scene.start);
      expect(w.endMs).toBeLessThanOrEqual(scene.start + scene.duration);
      expect(w.endMs).toBeGreaterThan(w.startMs);
    }
    result.slice(1).forEach((w, i) => {
      expect(w.startMs).toBeGreaterThanOrEqual(result[i].endMs);
    });
    expect(result[5].endMs).toBe(3000);
    expect(result[6]).toMatchObject({ startMs: 4000, endMs: 6001 });
    // Longer words get more time.
    const span = (w: CaptionWord) => w.endMs - w.startMs;
    expect(span(result[3])).toBeGreaterThan(span(result[4]));
  });
});

describe("groupCaptions", () => {
  it("wraps lines greedily within maxCharsPerLine and maxLines", () => {
    const text = "un deux trois quatre cinq six sept huit neuf dix onze";
    const cues = groupCaptions(
      words(text.split(" ")),
      {
        maxLines: 2,
        maxCharsPerLine: 16,
      },
      rules,
    );
    expect(cues[0].lines).toEqual(["un deux trois", "quatre cinq six"]);
    expect(cues[1].lines).toEqual(["sept huit neuf", "dix onze"]);
    for (const cue of cues) {
      expect(cue.lines.length).toBeLessThanOrEqual(2);
      for (const line of cue.lines) expect(line.length).toBeLessThanOrEqual(16);
    }
  });
  it("gives an overlong word its own line", () => {
    const cues = groupCaptions(
      words(["a", "anticonstitutionnellement", "b"]),
      { maxLines: 3, maxCharsPerLine: 16 },
      rules,
    );
    expect(cues[0].lines).toEqual(["a", "anticonstitutionnellement", "b"]);
  });
  it("breaks after a sentence end once the cue is non-trivial", () => {
    const cues = groupCaptions(
      words(["Oui.", "Nous", "partons.", "Demain", "matin…", "Fin"]),
      style,
      rules,
    );
    expect(cues.map((c) => c.lines.join(" "))).toEqual([
      "Oui. Nous partons.",
      "Demain matin…",
      "Fin",
    ]);
  });
  it("never crosses a scene change", () => {
    const all = [
      ...words(["Un", "deux"], "scn_a"),
      ...words(["trois"], "scn_b", 700),
    ];
    const cues = groupCaptions(all, style, rules);
    expect(cues.map((c) => [c.wordStart, c.wordEnd])).toEqual([
      [0, 2],
      [2, 3],
    ]);
  });
  it("splits cues longer than maxDurationMs", () => {
    const many = words(Array.from({ length: 12 }, (_, i) => `m${i}`));
    const cues = groupCaptions(many, style, { ...rules, maxDurationMs: 1500 });
    for (const cue of cues)
      expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(1500);
    expect(cues.length).toBeGreaterThan(1);
  });
  it("extends short cues up to minDurationMs, keeping the gap", () => {
    const all = [
      ...words(["Court."], "scn_a"),
      ...words(["Suite."], "scn_b", 600),
      ...words(["Fin."], "scn_c", 3000),
    ];
    const cues = groupCaptions(all, style, rules);
    expect(cues[0]).toMatchObject({ startMs: 0, endMs: 520 });
    expect(cues[1]).toMatchObject({ startMs: 600, endMs: 1400 });
    expect(cues[2]).toMatchObject({ startMs: 3000, endMs: 3800 });
  });
  it("produces deterministic, valid ids and a valid track", () => {
    const input = words("Bonjour à tous. Voici la suite.".split(" "));
    const a = groupCaptions(input, style, rules);
    expect(groupCaptions(input, style, rules)).toEqual(a);
    expect(a.map((c) => c.id)).toEqual(["cue_0001", "cue_0002"]);
    for (const cue of a) expect(captionCueSchema.parse(cue)).toEqual(cue);
    captionTrackSchema.parse({
      schemaVersion: 1,
      id: "cap_x",
      words: input,
      cues: a,
      provenance: { provider: "script" },
    });
  });
});

const rates = [
  { num: 24, den: 1 },
  { num: 30, den: 1 },
  { num: 60, den: 1 },
  { num: 30000, den: 1001 },
];
describe("quantizeCues", () => {
  const cues = [
    { id: "cue_0001", startMs: 0, endMs: 1234 },
    { id: "cue_0002", startMs: 1240, endMs: 1250 },
    { id: "cue_0003", startMs: 1251, endMs: 2999.7 },
    { id: "cue_0004", startMs: 4000, endMs: 9000 },
    { id: "cue_0005", startMs: 9500, endMs: 9900 },
  ];
  for (const rate of rates)
    it(`snaps to frames at ${rate.num}/${rate.den}`, () => {
      const duration = frameDurationMs(rate);
      const count = Math.round((5000 * rate.num) / (1000 * rate.den));
      const q = quantizeCues(cues, rate, count);
      expect(q.map((c) => c.cueId)).toEqual(cues.slice(0, 4).map((c) => c.id));
      q.forEach((c, i) => {
        expect(c.endFrame).toBeGreaterThan(c.startFrame);
        expect(c.startMs).toBe(Math.floor(c.startFrame * duration + 1e-6));
        expect(c.endMs).toBe(Math.floor(c.endFrame * duration + 1e-6));
        // Player semantics (start <= t < end at frame presentation times): the
        // cue is visible exactly on frames [startFrame, endFrame).
        const shown = (frame: number) =>
          c.startMs <= frame * duration + 1e-6 &&
          frame * duration + 1e-6 < c.endMs + 1;
        expect(shown(c.startFrame)).toBe(true);
        if (c.startFrame)
          expect(c.startMs > (c.startFrame - 1) * duration).toBe(true);
        expect(c.endMs <= c.endFrame * duration + 1e-6).toBe(true);
        expect(c.endMs > (c.endFrame - 1) * duration).toBe(true);
        expect(shown(c.endFrame - 1)).toBe(true);
        // First frame starting at or after the cue start (0.5 ms tolerance).
        expect(c.startFrame * duration).toBeGreaterThanOrEqual(
          cues[i].startMs - 0.5,
        );
        if (i) expect(c.startFrame).toBeGreaterThanOrEqual(q[i - 1].endFrame);
      });
      // Clamped at media end.
      expect(q[3].endFrame).toBe(count);
      // Idempotent on its own exported milliseconds.
      const again = quantizeCues(
        q.map((c) => ({ id: c.cueId, startMs: c.startMs, endMs: c.endMs })),
        rate,
        count,
      );
      expect(again).toEqual(q);
    });
  it("gives a sub-frame cue one frame without overlapping", () => {
    const q = quantizeCues(cues.slice(0, 3), { num: 24, den: 1 }, 1000);
    // 1234 ms -> frame 30 (1250 ms); 1240-1250 ms would be empty.
    expect(q[0]).toMatchObject({ startFrame: 0, endFrame: 30, endMs: 1250 });
    expect(q[1]).toMatchObject({ startFrame: 30, endFrame: 31 });
    expect(q[2].startFrame).toBe(31);
  });
  it("computes 29.97 fps boundaries without drift", () => {
    const rate = { num: 30000, den: 1001 };
    const [c] = quantizeCues(
      [{ id: "cue_0001", startMs: 3_600_000, endMs: 3_601_000 }],
      rate,
      200_000,
    );
    // Frame 107892 starts at 3599996.4 ms, frame 107893 at 3600029.76 ms.
    expect(c.startFrame).toBe(107892 + 1);
    // Floored, not rounded up past the frame's presentation time.
    expect(c.startMs).toBe(3_600_029);
  });
});

describe("SRT and WebVTT", () => {
  const trackWith = (lines: string[][]) =>
    captionTrackSchema.parse({
      schemaVersion: 1,
      id: "cap_x",
      words: lines.map((_, i) => ({
        text: "w",
        startMs: i * 4_000_000,
        endMs: i * 4_000_000 + 500,
        timing: "manual",
      })),
      cues: lines.map((l, i) => ({
        id: `cue_000${i + 1}`,
        wordStart: i,
        wordEnd: i + 1,
        startMs: i * 4_000_000,
        endMs: i * 4_000_000 + 1000,
        lines: l,
      })),
      provenance: { provider: "manual" },
    });
  const track = trackWith([
    ["A --> B & <i>C</i>", "deux"],
    ["Après une heure"],
  ]);
  const rate = { num: 30000, den: 1001 };
  const q = quantizeCues(track.cues, rate, 200_000);
  it("formats SRT with hours and no arrow in text", () => {
    const srt = toSrt(track, q);
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:01,001\nA -> B & <i>C</i>\ndeux\n\n" +
        "2\n01:06:40,029 --> 01:06:41,030\nAprès une heure\n",
    );
    expect(srt.split("\n").filter((l) => l.includes("-->"))).toHaveLength(2);
  });
  it("formats WebVTT with escaping", () => {
    const vtt = toWebVtt(track, q);
    expect(vtt).toBe(
      "WEBVTT\n\ncue_0001\n00:00:00.000 --> 00:00:01.001\n" +
        "A --&gt; B &amp; &lt;i&gt;C&lt;/i&gt;\ndeux\n\n" +
        "cue_0002\n01:06:40.029 --> 01:06:41.030\nAprès une heure\n",
    );
    expect(vtt.split("\n").filter((l) => l.includes("-->"))).toHaveLength(2);
  });
  it("round-trips the quantized milliseconds", () => {
    const expected = q.map(({ startMs, endMs }) => ({ startMs, endMs }));
    const times = (cues: { startMs: number; endMs: number }[]) =>
      cues.map(({ startMs, endMs }) => ({ startMs, endMs }));
    expect(times(parseSrt(toSrt(track, q)))).toEqual(expected);
    expect(times(parseWebVtt(toWebVtt(track, q)))).toEqual(expected);
    expect(parseWebVtt(toWebVtt(track, q))[0].lines).toEqual([
      "A --> B & <i>C</i>",
      "deux",
    ]);
    expect(parseSrt(toSrt(track, q).replace(/\n/g, "\r\n"))).toEqual(
      parseSrt(toSrt(track, q)),
    );
  });
  it("parses WebVTT without hours, with settings and NOTE blocks", () => {
    expect(
      parseWebVtt(
        "﻿WEBVTT\r\n\r\nNOTE test\r\n\r\n01:02.500 --> 01:03.000 line:90%\r\nSalut\r\n",
      ),
    ).toEqual([{ startMs: 62_500, endMs: 63_000, lines: ["Salut"] }]);
  });
  it("rejects quantized cues unknown to the track", () => {
    expect(() => toSrt(track, [{ ...q[0], cueId: "cue_9999" }])).toThrow(
      "Unknown cue",
    );
  });
});

it("summarises timing precision", () => {
  const summary = captionPrecisionSummary({
    words: [
      ...words(["a", "b"]),
      { ...words(["c"])[0], timing: "scene" },
      { ...words(["d"])[0], timing: "asr" },
    ],
  });
  expect(summary).toEqual({
    counts: { tts: 2, aligned: 0, asr: 1, scene: 1, manual: 0 },
    total: 4,
    approximateShare: 0.5,
  });
  expect(captionPrecisionSummary({ words: [] }).approximateShare).toBe(0);
});
