import { describe, expect, it } from "vitest";
import {
  qualityEvaluationSchema,
  assertTransition,
  transitions,
  newId,
  storyboardSchema,
  sceneAt,
  feedbackSchema,
  qualityReportSchema,
  projectSchema,
} from "./index";

describe("state machines", () => {
  for (const kind of Object.keys(transitions) as (keyof typeof transitions)[]) {
    const table: Record<string, readonly string[]> = transitions[kind];
    for (const from of Object.keys(table))
      for (const to of Object.keys(table)) {
        it(`${kind}: ${from} → ${to}`, () => {
          if (table[from].includes(to))
            expect(() => assertTransition(kind, from, to)).not.toThrow();
          else
            expect(() => assertTransition(kind, from, to)).toThrow("Illegal");
        });
      }
  }
  it("rejects unknown states", () => {
    expect(() =>
      assertTransition("RenderJob", "constructor", "running"),
    ).toThrow();
  });
});
it("generates distinct prefixed IDs", () => {
  expect(newId("prj")).toMatch(/^prj_/);
  expect(newId("prj")).not.toBe(newId("prj"));
  expect(
    projectSchema.safeParse({
      id: newId("rev"),
      name: "Demo",
      resolvedConfig: {},
      createdAt: 0,
      updatedAt: 0,
    }).success,
  ).toBe(false);
});
const board = {
  width: 1920,
  height: 1080,
  fps: 30,
  scenes: [
    { id: "scn_one", start: 0, duration: 1000, text: "One", animation: {} },
    { id: "scn_two", start: 1000, duration: 500, text: "Two", animation: {} },
  ],
};
it("locates scenes with half-open millisecond intervals", () => {
  const parsed = storyboardSchema.parse(board);
  expect(sceneAt(parsed, -1)).toBeUndefined();
  expect(sceneAt(parsed, 999)?.id).toBe("scn_one");
  expect(sceneAt(parsed, 1000)?.id).toBe("scn_two");
  expect(sceneAt(parsed, 1500)).toBeUndefined();
});
it("rejects overlap and duplicate scene identities", () => {
  expect(
    storyboardSchema.safeParse({
      ...board,
      scenes: [board.scenes[0], board.scenes[0]],
    }).success,
  ).toBe(false);
});
it("validates feedback reference, author and timestamp", () => {
  const data = {
    id: "fdb_one",
    projectId: "prj_one",
    revisionId: "rev_one",
    timestampMs: 0,
    sceneId: null,
    text: "Change title",
    author: "Test",
    createdAt: 0,
    updatedAt: 0,
  };
  expect(feedbackSchema.parse(data).status).toBe("draft");
  expect(feedbackSchema.safeParse({ ...data, timestampMs: -1 }).success).toBe(
    false,
  );
  expect(
    feedbackSchema.safeParse({ ...data, revisionId: undefined }).success,
  ).toBe(false);
});
it("validates the union of authoritative finding modes", () => {
  const check = {
    id: "qck_one",
    name: "Probe",
    passed: true,
    severity: "info",
    timestamp: 0,
    evidence: "Values",
    recommendation: "None",
    analysisMode: "deterministic",
  };
  const issue = {
    id: "qis_one",
    sceneId: null,
    severity: "minor",
    timestamp: 500,
    evidence: "Text review",
    recommendation: "Revise",
    analysisMode: "text-only",
  };
  const report = {
    id: "qar_one",
    revisionId: "rev_one",
    createdAt: 0,
    checks: [check],
    issues: [issue],
    analysisModes: ["text-only", "deterministic"],
  };
  expect(qualityReportSchema.safeParse(report).success).toBe(true);
  for (const analysisModes of [
    [],
    ["text-only"],
    ["deterministic", "text-only", "simulated"],
    ["deterministic", "deterministic"],
  ]) {
    expect(
      qualityReportSchema.safeParse({ ...report, analysisModes }).success,
    ).toBe(false);
  }
  expect(
    qualityReportSchema.safeParse({ ...report, analysisModes: undefined })
      .success,
  ).toBe(false);
  expect(
    qualityReportSchema.safeParse({
      ...report,
      checks: [{ ...check, analysisMode: undefined }],
    }).success,
  ).toBe(false);
});

describe("quality evaluations never pass a simulation off as multimodal", () => {
  const row = {
    id: "qev_1",
    projectId: "prj_1",
    revisionId: "rev_2",
    baseRevisionId: "rev_1",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
  };
  it.each([
    ["fake", "multimodal", ["a.png"]],
    ["fake", "text-only", []],
    ["claude-subscribe", "simulated", []],
    ["anthropic-api", "multimodal", []],
    ["claude-subscribe", "deterministic", []],
    ["anthropic-api", null, []],
  ] as const)("rejects %s / %s", (evaluator, analysisMode, imagesExamined) => {
    expect(() =>
      qualityEvaluationSchema.parse({
        ...row,
        evaluator,
        analysisMode,
        imagesExamined,
      }),
    ).toThrow();
  });
  it("accepts honest labels", () => {
    expect(
      qualityEvaluationSchema.parse({
        ...row,
        evaluator: "fake",
        analysisMode: "simulated",
      }).analysisMode,
    ).toBe("simulated");
    expect(
      qualityEvaluationSchema.parse({
        ...row,
        evaluator: "claude-subscribe",
        analysisMode: "multimodal",
        imagesExamined: ["a.png"],
      }).imagesExamined,
    ).toEqual(["a.png"]);
  });
});
