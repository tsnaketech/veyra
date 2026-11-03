import { describe, expect, it } from "vitest";
import {
  alignmentResultSchema,
  captionCueSchema,
  captionRulesSchema,
  captionStyleSchema,
  captionTrackSchema,
  isApproximateTiming,
  sceneSchema,
  storyboardSchema,
  transcriptionResultSchema,
  videoRevisionSchema,
  voiceResultSchema,
} from "./index";

const word = (
  text: string,
  startMs: number,
  endMs: number,
  timing = "tts",
) => ({
  text,
  startMs,
  endMs,
  timing,
});
const track = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: "cap_one",
  words: [
    word("Bonjour", 0, 400),
    word("à", 400, 500),
    word("tous.", 500, 900),
  ],
  cues: [
    {
      id: "cue_0001",
      wordStart: 0,
      wordEnd: 3,
      startMs: 0,
      endMs: 1000,
      lines: ["Bonjour à tous."],
    },
  ],
  provenance: { provider: "local-tts" },
  ...overrides,
});

describe("caption track", () => {
  it("applies defaults for style, rules, language and provenance", () => {
    const parsed = captionTrackSchema.parse(track());
    expect(parsed.language).toBe("fr");
    expect(parsed.style).toMatchObject({
      position: "bottom",
      sizePct: 4.2,
      maxLines: 2,
      maxCharsPerLine: 42,
      background: "box",
      animation: "fade",
    });
    expect(parsed.rules).toEqual({
      minDurationMs: 800,
      maxDurationMs: 7000,
      maxCps: 17,
      minGapMs: 80,
    });
    expect(parsed.provenance.engine).toBeNull();
    expect(parsed.words[0]).toMatchObject({ confidence: null, sceneId: null });
  });
  it("rejects invalid styles and free CSS", () => {
    for (const style of [
      { textColor: "white" },
      { textColor: "#FFF" },
      { sizePct: 2 },
      { maxLines: 4 },
      { css: "color: red" },
    ])
      expect(captionStyleSchema.safeParse(style).success).toBe(false);
    expect(
      captionRulesSchema.safeParse({ minDurationMs: 2000, maxDurationMs: 1500 })
        .success,
    ).toBe(false);
  });
  it("rejects overlapping or unordered words", () => {
    const words = [word("a", 0, 500), word("b", 400, 600), word("c", 600, 900)];
    expect(captionTrackSchema.safeParse(track({ words })).success).toBe(false);
    expect(
      captionTrackSchema.safeParse(
        track({
          words: [word("a\nb", 0, 1), word("b", 1, 2), word("c", 2, 3)],
        }),
      ).success,
    ).toBe(false);
  });
  it("rejects cue ranges outside words, overlaps and loose bounds", () => {
    const cue = track().cues[0];
    const bad = [
      [{ ...cue, wordEnd: 4 }],
      [{ ...cue, startMs: 100 }],
      [{ ...cue, endMs: 800 }],
      [
        { ...cue, wordEnd: 2, endMs: 600 },
        { ...cue, id: "cue_0002", wordStart: 2, startMs: 500 },
      ],
      [
        { ...cue, wordEnd: 2, endMs: 500 },
        { ...cue, id: "cue_0002", wordStart: 1, startMs: 500 },
      ],
      [
        { ...cue, wordEnd: 2, endMs: 500 },
        { ...cue, wordStart: 2, startMs: 500 },
      ],
    ];
    for (const cues of bad)
      expect(captionTrackSchema.safeParse(track({ cues })).success).toBe(false);
    expect(
      captionCueSchema.safeParse({ ...cue, wordStart: 2, wordEnd: 2 }).success,
    ).toBe(false);
    expect(captionCueSchema.safeParse({ ...cue, id: "cap_x" }).success).toBe(
      false,
    );
  });
  it("flags asr and scene timings as approximate", () => {
    expect(
      (["tts", "aligned", "asr", "scene", "manual"] as const).filter(
        isApproximateTiming,
      ),
    ).toEqual(["asr", "scene"]);
  });
});

describe("provider results", () => {
  const voice = {
    sceneId: "scn_one",
    assetId: "ast_one",
    durationMs: 1200,
    words: [word("Bonjour", 0, 400, "scene")],
    provider: "fake",
    provenance: { provider: "fake" },
    simulated: true,
  };
  it("accepts a simulated fake voice with scene timing", () => {
    expect(voiceResultSchema.safeParse(voice).success).toBe(true);
    expect(voiceResultSchema.safeParse({ ...voice, words: [] }).success).toBe(
      true,
    );
  });
  it("takes word times only from a real synthesizer, never from an import", () => {
    const real = { ...voice, simulated: false };
    const tts = word("Bonjour", 0, 400, "tts");
    expect(
      voiceResultSchema.safeParse({
        ...real,
        provider: "local-tts",
        provenance: { provider: "local-tts" },
        words: [tts],
      }).success,
    ).toBe(true);
    for (const timing of ["aligned", "asr", "scene"])
      expect(
        voiceResultSchema.safeParse({
          ...real,
          provider: "local-tts",
          provenance: { provider: "local-tts" },
          words: [word("a", 0, 1, timing)],
        }).success,
      ).toBe(false);
    const imported = {
      ...real,
      provider: "import",
      provenance: { provider: "import" },
    };
    expect(
      voiceResultSchema.safeParse({ ...imported, words: [] }).success,
    ).toBe(true);
    expect(
      voiceResultSchema.safeParse({ ...imported, words: [tts] }).success,
    ).toBe(false);
  });
  it("never lets a simulated result carry precise timings", () => {
    for (const timing of ["tts", "aligned", "asr"])
      expect(
        voiceResultSchema.safeParse({
          ...voice,
          words: [word("a", 0, 1, timing)],
        }).success,
      ).toBe(false);
    expect(
      voiceResultSchema.safeParse({ ...voice, simulated: false }).success,
    ).toBe(false);
    expect(
      voiceResultSchema.safeParse({
        ...voice,
        provider: "local-tts",
        provenance: { provider: "local-tts" },
        simulated: true,
      }).success,
    ).toBe(false);
  });
  it("requires asr timings in a real transcription", () => {
    const result = {
      language: "fr",
      text: "Bonjour",
      words: [word("Bonjour", 0, 400, "asr")],
      provenance: { provider: "local-asr", engine: "whisper.cpp" },
      simulated: false,
    };
    expect(transcriptionResultSchema.safeParse(result).success).toBe(true);
    expect(
      transcriptionResultSchema.safeParse({
        ...result,
        words: [word("Bonjour", 0, 400, "aligned")],
      }).success,
    ).toBe(false);
  });
  it("requires aligned or tts timings in a real alignment", () => {
    const result = {
      words: [word("a", 0, 1, "aligned"), word("b", 1, 2, "tts")],
      unaligned: [2],
      provenance: { provider: "alignment" },
      simulated: false,
    };
    expect(alignmentResultSchema.safeParse(result).success).toBe(true);
    expect(
      alignmentResultSchema.safeParse({
        ...result,
        words: [word("a", 0, 1, "scene")],
      }).success,
    ).toBe(false);
    expect(
      alignmentResultSchema.safeParse({
        ...result,
        provenance: { provider: "fake" },
        simulated: true,
      }).success,
    ).toBe(false);
  });
});

describe("scene narration", () => {
  const scene = { id: "scn_one", start: 0, duration: 1000, text: "One" };
  it("keeps storyboards without narration unchanged", () => {
    const board = { width: 1920, height: 1080, fps: 30, scenes: [scene] };
    const parsed = storyboardSchema.parse(board);
    expect(parsed.scenes[0]).toEqual({ ...scene, animation: {} });
    expect("narration" in parsed.scenes[0]).toBe(false);
  });
  it("validates narration and voice", () => {
    const parsed = sceneSchema.parse({
      ...scene,
      narration: { text: "  Bonjour  ", voice: { provider: "fake" } },
    });
    expect(parsed.narration).toEqual({
      text: "Bonjour",
      voice: {
        provider: "fake",
        voiceId: null,
        speakerId: null,
        lengthScale: 1,
      },
    });
    for (const narration of [
      { text: "   " },
      { text: "x".repeat(1001) },
      { text: "a", voice: { provider: "cloud" } },
      { text: "a", voice: { provider: "fake", lengthScale: 3 } },
      { text: "a", extra: 1 },
    ])
      expect(sceneSchema.safeParse({ ...scene, narration }).success).toBe(
        false,
      );
  });
  it("defaults revision captions to null", () => {
    const revision = videoRevisionSchema.parse({
      id: "rev_one",
      projectId: "prj_one",
      storyboard: { width: 1, height: 1, fps: 30, scenes: [] },
      resolvedConfig: {},
      videoPath: null,
      error: null,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(revision.captions).toBeNull();
    expect(
      videoRevisionSchema.parse({ ...revision, captions: track() }).captions
        ?.id,
    ).toBe("cap_one");
  });
});
