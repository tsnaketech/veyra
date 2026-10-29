import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnthropicQualityEvaluator,
  AssistedProvider,
  FakeQualityEvaluator,
  sanitizeReview,
  toStoryboard,
  type EvaluationInput,
} from "./index";

const format = { width: 1920, height: 1080, fps: 30 };
const before = toStoryboard(
  {
    title: "t",
    scenes: [
      {
        text: "Petite entreprise, grandes ambitions",
        durationMs: 5000,
        enter: "fade",
        animationMs: 500,
      },
      {
        text: "Nous créons votre site",
        durationMs: 5000,
        enter: "slide-up",
        animationMs: 500,
      },
      {
        text: "Contactez-nous",
        durationMs: 5000,
        enter: "fade",
        animationMs: 500,
      },
    ],
  },
  format,
);
const [s1, s2, s3] = before.scenes;
/** New storyboard = old one with per-scene edits, ids kept. */
const edited = (
  edits: Record<string, { text?: string; animationMs?: number }>,
) => ({
  ...before,
  scenes: before.scenes.map((scene) => ({
    ...scene,
    text: edits[scene.id]?.text ?? scene.text,
    animation: {
      ...scene.animation,
      durationMs: edits[scene.id]?.animationMs ?? scene.animation.durationMs,
    },
  })),
});
const comment = (feedbackId: string, text: string, sceneId: string) => ({
  feedbackId,
  text,
  frameIndex: 0,
  timestampMs: 0,
  sceneId,
  alignedTimestampMs: 0,
  plannedChanges: [],
  inConflict: false,
});
const input = (
  after: typeof before,
  comments: EvaluationInput["comments"],
  images: EvaluationInput["images"] = [],
): EvaluationInput => ({
  language: "fr",
  brief: { prompt: "p", styleInstructions: "sobre", palette: {}, fonts: [] },
  before: { revisionId: "rev_a", storyboard: before },
  after: { revisionId: "rev_b", storyboard: after },
  comments,
  measurements: [],
  images,
});

describe("simulated evaluator (rules on storyboards, never images)", () => {
  const evaluate = (
    after: typeof before,
    comments: EvaluationInput["comments"],
  ) => new FakeQualityEvaluator().evaluate(input(after, comments));
  it("recognises a correctly applied correction", async () => {
    const { review, analysisMode } = await evaluate(
      edited({ [s1.id]: { animationMs: 800 } }),
      [comment("fdb_1", "Ralentis l'animation", s1.id)],
    );
    expect(analysisMode).toBe("simulated");
    expect(review.imagesExamined).toEqual([]);
    expect(review.verdicts[0]).toMatchObject({
      verdict: "applied",
      category: "content",
    });
    expect(review.verdicts[0].justification).toMatch(/^Simulé/);
  });
  it("flags a visible change that goes against the request", async () => {
    const { review } = await evaluate(
      edited({ [s1.id]: { animationMs: 300 } }),
      [comment("fdb_1", "Ralentis l'animation", s1.id)],
    );
    expect(review.verdicts[0].verdict).toBe("contradicts_request");
  });
  it("reports a partial correction", async () => {
    const { review } = await evaluate(
      edited({ [s1.id]: { animationMs: 800 } }),
      [
        comment(
          "fdb_1",
          "Ralentis et remplace le texte par « Grand impact »",
          s1.id,
        ),
      ],
    );
    expect(review.verdicts[0].verdict).toBe("partially_applied");
  });
  it("says unverifiable when the intent cannot be checked", async () => {
    const { review } = await evaluate(before, [
      comment("fdb_1", "La musique est trop forte", s2.id),
    ]);
    expect(review.verdicts[0]).toMatchObject({
      verdict: "unverifiable",
      confidence: 0,
    });
  });
  it("reports a regression on an untouched scene", async () => {
    const { review } = await evaluate(
      edited({
        [s1.id]: { animationMs: 800 },
        [s3.id]: { text: "Appelez-nous" },
      }),
      [comment("fdb_1", "Ralentis l'animation", s1.id)],
    );
    expect(review.findings).toEqual([
      expect.objectContaining({ kind: "regression", sceneId: s3.id }),
    ]);
  });
});

it("writes simulated texts in the configured language and asks experts for it", async () => {
  const en = {
    ...input(before, [comment("fdb_1", "Ralentis l'animation", s1.id)]),
    language: "en" as const,
  };
  const { review } = await new FakeQualityEvaluator().evaluate(en);
  expect(review.verdicts[0].justification).toMatch(
    /^Simulated \(storyboard rules/,
  );
  const request = new AssistedProvider().evaluationRequest(input(before, []));
  expect(request.instructions).toMatch(/en français\.$/);
  expect(new AssistedProvider().evaluationRequest(en).instructions).toMatch(
    /in English\.$/,
  );
});

describe("expert results are validated against the evaluation pack", () => {
  const image = {
    file: "fdb_1-after-aligned.png",
    path: "/x.png",
    revision: "after" as const,
    role: "aligned" as const,
    feedbackId: "fdb_1",
    sceneId: s1.id,
    frameIndex: 15,
    timestampMs: 500,
    offsetMs: 500,
  };
  it("drops unknown ids and images, and fills missing comments as unverifiable", () => {
    const pack = input(
      before,
      [comment("fdb_1", "a", s1.id), comment("fdb_2", "b", s2.id)],
      [image],
    );
    const review = sanitizeReview(
      {
        verdicts: [
          {
            feedbackId: "fdb_1",
            verdict: "applied",
            category: "content",
            confidence: 0.9,
            justification: "ok",
            evidence: [
              { image: image.file, observation: "visible" },
              { image: "/etc/passwd", observation: "x" },
            ],
          },
          {
            feedbackId: "fdb_zzz",
            verdict: "applied",
            category: "content",
            confidence: 1,
            justification: "x",
            evidence: [],
          },
        ],
        findings: [
          {
            kind: "observation",
            category: "aesthetic",
            sceneId: "scn_unknown",
            severity: "info",
            confidence: 0.5,
            justification: "rythme",
            evidence: [],
          },
        ],
        imagesExamined: [image.file, "other.png"],
      },
      pack,
    );
    expect(review.verdicts.map((v) => [v.feedbackId, v.verdict])).toEqual([
      ["fdb_1", "applied"],
      ["fdb_2", "unverifiable"],
    ]);
    expect(review.verdicts[0].evidence[1]).toMatchObject({ image: null });
    expect(review.findings[0].sceneId).toBeNull();
    expect(review.imagesExamined).toEqual([image.file]);
  });
  it("API evaluator is multimodal only when images were really sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "veyra-eval-"));
    const path = join(dir, "a.png");
    writeFileSync(path, "png");
    const claimed = {
      verdicts: [],
      findings: [],
      imagesExamined: ["invented.png"],
    };
    const evaluator = new AnthropicQualityEvaluator(
      async () => claimed as never,
    );
    const withImages = await evaluator.evaluate(
      input(before, [], [{ ...image, path }]),
    );
    expect(withImages).toMatchObject({ analysisMode: "multimodal" });
    expect(withImages.review.imagesExamined).toEqual([image.file]);
    const textOnly = await evaluator.evaluate(input(before, []));
    expect(textOnly.analysisMode).toBe("text-only");
  });
  it("assisted request carries brief, comments and relative images only", () => {
    const request = new AssistedProvider().evaluationRequest(
      input(before, [comment("fdb_1", "a", s1.id)], [image]),
    );
    expect(request).toMatchObject({
      kind: "evaluation",
      format: "veyra-ai-task/v1",
    });
    expect(JSON.stringify(request)).not.toContain("/x.png");
    expect((request.input.images as { path: string }[])[0].path).toBe(
      `images/${image.file}`,
    );
    expect(
      (request.input.brief as { styleInstructions: string }).styleInstructions,
    ).toBe("sobre");
    expect(() =>
      new AssistedProvider().parseResult("evaluation", {
        verdicts: [],
        findings: [],
      }),
    ).toThrow();
  });
});

it("keeps measured audio facts separate from listening and removes audio judgments", async () => {
  const pack = input(before, [
    comment("fdb_audio", "Baisse la musique", s1.id),
  ]);
  pack.audio = {
    present: true,
    listened: false,
    measurements: ["mesuré — Niveau sonore : -16 LUFS"],
    feedbackIds: ["fdb_audio"],
  };
  const fake = await new FakeQualityEvaluator().evaluate(pack);
  expect(
    fake.review.findings.some((f) =>
      f.justification.includes("Audio non écouté"),
    ),
  ).toBe(true);
  const clean = sanitizeReview(
    {
      verdicts: [
        {
          feedbackId: "fdb_audio",
          verdict: "applied",
          category: "content",
          confidence: 1,
          justification: "La musique sonne parfaitement",
          evidence: [],
        },
      ],
      findings: [
        {
          kind: "observation",
          category: "aesthetic",
          sceneId: null,
          severity: "info",
          confidence: 1,
          justification: "La qualité sonore est excellente",
          evidence: [],
        },
      ],
      imagesExamined: [],
    },
    pack,
  );
  expect(clean.verdicts[0]).toMatchObject({
    verdict: "unverifiable",
    confidence: 0,
  });
  expect(clean.findings).toHaveLength(1);
  expect(clean.findings[0].justification).toContain("Audio non écouté");
  const request = new AssistedProvider().evaluationRequest(pack);
  expect(JSON.stringify(request)).toContain("mesuré — Niveau sonore");
  expect(JSON.stringify(request)).toContain("PAS écouté");
});
