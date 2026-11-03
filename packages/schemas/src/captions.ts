import { z } from "zod";
import { idSchema } from "./ids";

/**
 * How a word time was obtained.
 * - tts: durations returned by the synthesizer for the audio it produced;
 * - aligned: forced alignment on the real audio;
 * - asr: ASR token times (approximate);
 * - scene: spread inside the scene (approximate by construction, always flagged);
 * - manual: edited by the user.
 */
export const captionTimingSchema = z.enum([
  "tts",
  "aligned",
  "asr",
  "scene",
  "manual",
]);
export type CaptionTiming = z.infer<typeof captionTimingSchema>;
export const isApproximateTiming = (timing: CaptionTiming) =>
  timing === "asr" || timing === "scene";

export const voiceProviderSchema = z.enum(["import", "local-tts", "fake"]);
const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
// One displayable line: no line break (SRT/VTT blocks), not blank.
const textLine = z.string().regex(/^[^\r\n]*\S[^\r\n]*$/);
const ms = z.number().nonnegative();
// BCP-47-like tag (fr, fr-FR, pt-BR...).
const language = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);

export const captionWordSchema = z
  .object({
    text: textLine,
    startMs: ms,
    endMs: ms,
    confidence: z.number().min(0).max(1).nullable().default(null),
    timing: captionTimingSchema,
    sceneId: idSchema("scn").nullable().default(null),
  })
  .strict()
  .refine((w) => w.endMs >= w.startMs, "A word ends after it starts");

// Data only: the compositor maps these closed values to CSS, never free CSS.
export const captionStyleSchema = z
  .object({
    position: z.enum(["bottom", "top", "middle"]).default("bottom"),
    // Percent of the frame height.
    safeMarginPct: z.number().min(0).max(20).default(5),
    font: z.enum(["inter", "system-sans", "serif"]).default("inter"),
    // Percent of the frame height; 2.6 is the MOTION-ENGINE text floor.
    sizePct: z.number().min(2.6).max(8).default(4.2),
    textColor: hex.default("#FFFFFF"),
    background: z.enum(["none", "band", "box"]).default("box"),
    backgroundColor: hex.default("#0B0D17"),
    backgroundOpacity: z.number().min(0).max(1).default(0.72),
    outline: z.boolean().default(false),
    maxLines: z.number().int().min(1).max(3).default(2),
    maxCharsPerLine: z.number().int().min(16).max(80).default(42),
    animation: z
      .enum(["none", "fade", "pop", "word-highlight", "karaoke"])
      .default("fade"),
    highlightColor: hex.default("#FDE047"),
  })
  .strict();

export const captionRulesSchema = z
  .object({
    minDurationMs: z.number().int().min(100).max(10000).default(800),
    maxDurationMs: z.number().int().min(500).max(20000).default(7000),
    maxCps: z.number().min(5).max(40).default(17),
    minGapMs: z.number().int().min(0).max(1000).default(80),
  })
  .strict()
  .refine(
    (r) => r.maxDurationMs > r.minDurationMs,
    "maxDurationMs must exceed minDurationMs",
  );

export const captionCueSchema = z
  .object({
    id: idSchema("cue"),
    wordStart: z.number().int().nonnegative(),
    // Exclusive.
    wordEnd: z.number().int().positive(),
    startMs: ms,
    endMs: ms,
    lines: z.array(textLine).min(1).max(3),
  })
  .strict()
  .refine((c) => c.wordEnd > c.wordStart, "A cue holds at least one word")
  .refine((c) => c.endMs > c.startMs, "A cue ends after it starts");

export const captionProvenanceSchema = z
  .object({
    provider: z.enum([
      "script",
      "import",
      "local-tts",
      "local-asr",
      "alignment",
      "manual",
      "fake",
    ]),
    engine: z.string().nullable().default(null),
    model: z.string().nullable().default(null),
    version: z.string().nullable().default(null),
    sha256: z.string().nullable().default(null),
  })
  .strict();

export const captionTrackSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: idSchema("cap"),
    language: language.default("fr"),
    words: z.array(captionWordSchema),
    cues: z.array(captionCueSchema),
    // prefault: an omitted style/rules is parsed, so inner defaults apply.
    style: captionStyleSchema.prefault({}),
    rules: captionRulesSchema.prefault({}),
    provenance: captionProvenanceSchema,
  })
  .strict()
  .superRefine(({ words, cues }, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    words.forEach((word, i) => {
      if (i && word.startMs < words[i - 1].endMs)
        issue(
          ["words", i, "startMs"],
          "Words must be ordered, non-overlapping",
        );
    });
    const ids = new Set<string>();
    cues.forEach((cue, i) => {
      if (ids.has(cue.id)) issue(["cues", i, "id"], "Duplicate cue id");
      ids.add(cue.id);
      const prev = cues[i - 1];
      if (prev && cue.wordStart < prev.wordEnd)
        issue(["cues", i, "wordStart"], "Cue word ranges must be ordered");
      if (prev && cue.startMs < prev.endMs)
        issue(["cues", i, "startMs"], "Cues must be ordered, non-overlapping");
      if (cue.wordEnd > words.length) {
        issue(["cues", i, "wordEnd"], "Cue word range outside words");
        return;
      }
      if (cue.startMs > words[cue.wordStart].startMs)
        issue(["cues", i, "startMs"], "Cue starts after its first word");
      if (cue.endMs < words[cue.wordEnd - 1].endMs)
        issue(["cues", i, "endMs"], "Cue ends before its last word");
    });
  });

export type CaptionWord = z.infer<typeof captionWordSchema>;
export type CaptionStyle = z.infer<typeof captionStyleSchema>;
export type CaptionRules = z.infer<typeof captionRulesSchema>;
export type CaptionCue = z.infer<typeof captionCueSchema>;
export type CaptionProvenance = z.infer<typeof captionProvenanceSchema>;
export type CaptionTrack = z.infer<typeof captionTrackSchema>;
export type VoiceProvider = z.infer<typeof voiceProviderSchema>;

// Provider results. A simulated (fake) result only carries "scene" times, and a
// result is simulated exactly when its provenance is "fake": never presented as real.
type ResultLike = {
  words: CaptionWord[];
  simulated: boolean;
  provenance: CaptionProvenance;
};
function checkResult(real: readonly CaptionTiming[]) {
  return (result: ResultLike, ctx: z.RefinementCtx) => {
    if (result.simulated !== (result.provenance.provider === "fake"))
      ctx.addIssue({
        code: "custom",
        path: ["simulated"],
        message: "A result is simulated exactly when its provider is fake",
      });
    const allowed = result.simulated ? ["scene"] : real;
    result.words.forEach((word, i) => {
      if (!allowed.includes(word.timing))
        ctx.addIssue({
          code: "custom",
          path: ["words", i, "timing"],
          message: `Timing ${word.timing} not allowed in this result`,
        });
    });
  };
}
const resultBase = {
  words: z.array(captionWordSchema),
  provenance: captionProvenanceSchema,
  simulated: z.boolean(),
};
export const voiceResultSchema = z
  .object({
    sceneId: idSchema("scn"),
    assetId: idSchema("ast"),
    durationMs: z.number().positive(),
    provider: voiceProviderSchema,
    ...resultBase,
  })
  .strict()
  // Only a synthesizer reports word times for the audio it produced; an imported
  // voice carries none (they come from an AlignmentProvider).
  .superRefine(checkResult(["tts"]))
  .refine(
    (r) => (r.provider === "fake") === r.simulated,
    "Only the fake voice provider is simulated",
  )
  .refine(
    (r) => r.provider !== "import" || r.words.length === 0,
    "An imported voice carries no word times",
  );
export const transcriptionResultSchema = z
  .object({
    language,
    text: z.string(),
    ...resultBase,
  })
  .strict()
  .superRefine(checkResult(["asr"]));
export const alignmentResultSchema = z
  .object({
    // Indices of script words that could not be aligned.
    unaligned: z.array(z.number().int().nonnegative()),
    ...resultBase,
  })
  .strict()
  .superRefine(checkResult(["aligned", "tts"]));
export type VoiceResult = z.infer<typeof voiceResultSchema>;
export type TranscriptionResult = z.infer<typeof transcriptionResultSchema>;
export type AlignmentResult = z.infer<typeof alignmentResultSchema>;
