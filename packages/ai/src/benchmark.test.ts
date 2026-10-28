import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareToReference,
  formatReport,
  referenceSetSchema,
  resultSetSchema,
  type ReferenceSet,
  type ResultSet,
} from "./benchmark";

const referenceDir = join(import.meta.dirname, "../../../qa/reference/v1");
const verdict = (feedbackId: string, v: string, category = "content") => ({
  feedbackId,
  verdict: v,
  category,
  confidence: 0.5,
  justification: "j",
  evidence: [],
});
const reference = {
  format: "veyra-qa-reference/v1",
  validation: { status: "proposed", note: "n" },
  cases: [
    {
      id: "a",
      description: "d",
      source: "synthetic",
      reviewedBy: null,
      input: {},
      expected: {
        verdicts: [
          {
            feedbackId: "fdb_1",
            verdict: "contradicts_request",
            category: "content",
          },
          { feedbackId: "fdb_2", verdict: "applied", category: "technical" },
        ],
        regressions: ["scn_5"],
      },
    },
    {
      id: "b",
      description: "d",
      source: "synthetic",
      reviewedBy: null,
      input: {},
      expected: {
        verdicts: [
          {
            feedbackId: "fdb_3",
            verdict: "unverifiable",
            category: "aesthetic",
          },
        ],
        regressions: [],
      },
    },
  ],
} as unknown as ReferenceSet;

describe("comparison with the reference verdicts", () => {
  const results = {
    format: "veyra-qa-results/v1",
    evaluator: "claude-subscribe",
    analysisMode: "multimodal",
    note: "",
    cases: [
      {
        caseId: "a",
        review: {
          verdicts: [
            verdict("fdb_1", "applied"),
            verdict("fdb_2", "applied", "content"),
          ],
          findings: [],
          imagesExamined: [],
        },
      },
    ],
  } as unknown as ResultSet;
  const report = compareToReference(reference, results);
  it("computes accuracy by category and the confusion matrix on evaluated cases", () => {
    expect(report.coverage).toEqual({ evaluated: 1, total: 2 });
    expect(report.missingCases).toEqual(["b"]);
    expect(report.overall).toMatchObject({
      total: 2,
      correct: 1,
      accuracy: 0.5,
    });
    expect(report.byCategory.technical).toMatchObject({ total: 1, correct: 1 });
    expect(report.byCategory.content).toMatchObject({ total: 1, correct: 0 });
    expect(report.categoryAgreement).toMatchObject({ correct: 1, total: 2 });
    expect(report.confusion).toEqual({
      contradicts_request: { applied: 1 },
      applied: { applied: 1 },
    });
  });
  it("lists false acceptances and missed regressions as critical errors", () => {
    expect(report.criticalErrors.map((e) => e.reason)).toEqual([
      "acceptée à tort (attendu : contradicts_request)",
      "régression manquée (scn_5)",
    ]);
    const text = formatReport(report);
    expect(text).toMatch(/Erreurs critiques : 2/);
    expect(text).toMatch(/NON validées par un humain/);
  });
  it("warns when the evaluator was simulated", () => {
    const simulated = compareToReference(reference, {
      ...results,
      evaluator: "fake",
      analysisMode: "simulated",
    });
    expect(formatReport(simulated)).toMatch(
      /évaluation simulée.*pas une expertise multimodale/,
    );
  });
});

describe("versioned reference set", () => {
  const set = referenceSetSchema.parse(
    JSON.parse(readFileSync(join(referenceDir, "cases.json"), "utf8")),
  );
  it("is internally consistent and honest about its validation status", () => {
    expect(set.cases.length).toBeGreaterThanOrEqual(10);
    expect(new Set(set.cases.map((c) => c.id)).size).toBe(set.cases.length);
    const verdicts = new Set(
      set.cases.flatMap((c) => c.expected.verdicts.map((v) => v.verdict)),
    );
    expect([...verdicts].sort()).toEqual([
      "applied",
      "contradicts_request",
      "not_applied",
      "partially_applied",
      "unverifiable",
    ]);
    for (const item of set.cases) {
      if (set.validation.status === "proposed")
        expect(item.reviewedBy).toBeNull();
      const comments = item.input.comments.map((c) => c.feedbackId);
      expect(item.expected.verdicts.map((v) => v.feedbackId).sort()).toEqual(
        [...comments].sort(),
      );
      const scenes = item.input.after.storyboard.scenes.map((s) => s.id);
      for (const scene of item.expected.regressions)
        expect(scenes).toContain(scene);
      for (const image of item.input.images)
        expect(existsSync(join(referenceDir, image.path))).toBe(true);
    }
  });
  it("ships a recorded expert result that matches the result format", () => {
    const recorded = resultSetSchema.parse(
      JSON.parse(
        readFileSync(
          join(referenceDir, "results/independent-review-2026-10-28.json"),
          "utf8",
        ),
      ),
    );
    expect(recorded).toMatchObject({
      evaluator: "claude-subscribe",
      analysisMode: "multimodal",
    });
    expect(recorded.cases[0].review.imagesExamined.length).toBeGreaterThan(0);
  });
});
