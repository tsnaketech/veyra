import { expect, it } from "vitest";
import { z } from "zod";
import {
  agentResultSchema,
  motionCompositionSchema,
  newId,
  productionBriefSchema,
  productionPlanSchema,
  reviewPlanSchema,
  revisionPlanSchema,
  storyboardSchema,
  storyboardSpecification,
  productionRunSchema,
  usageMicroUsd,
  usdToMicroUsd,
  worstCaseMicroUsd,
} from "./index";
import { qualityReportSchema as contractReport } from "./production";
import { inputHash } from "./hash";
import { qualityReportSchema } from "./core";
it("hashes nested JSON independently of key order, preserving array order", () => {
  expect(inputHash({ b: [{ z: 1, a: 2 }], a: 3 })).toBe(
    inputHash({ a: 3, b: [{ a: 2, z: 1 }] }),
  );
  expect(inputHash([1, 2])).not.toBe(inputHash([2, 1]));
  expect(inputHash(null)).toBe(
    "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
  );
  expect(() => inputHash({ a: undefined })).toThrow();
});
it("reuses existing storyboard and quality schemas", () => {
  expect(storyboardSpecification).toBe(storyboardSchema);
  expect(contractReport).toBe(qualityReportSchema);
  expect(
    motionCompositionSchema.safeParse({
      storyboard: { scenes: [], width: 1920, height: 1080, fps: 30 },
      registryVersion: 1,
    }).success,
  ).toBe(true);
});
const result = {
  id: newId("phs"),
  schemaVersion: 1,
  agent: "motion",
  phase: "motion",
  revisionId: newId("rev"),
  dependsOn: [newId("phs")],
  provider: "rules",
  provenance: { inputHash: inputHash({}), createdAt: 0, model: null },
  warnings: [],
  errors: [],
  validation: "valid",
  payload: { value: 1 },
};
it("validates a typed result envelope and new prefixes", () => {
  const schema = agentResultSchema(z.object({ value: z.number() }));
  expect(schema.parse(result).payload).toEqual({ value: 1 });
  for (const agent of ["engine", "human"])
    expect(schema.parse({ ...result, agent }).agent).toBe(agent);
  expect(newId("run")).toMatch(/^run_/);
  for (const patch of [
    { id: "run_a" },
    { dependsOn: ["rev_a"] },
    { revisionId: "phs_a" },
    { schemaVersion: 2 },
    { agent: "unknown" },
    { phase: "unknown" },
    { provider: "unknown" },
    { validation: "ok" },
    { provenance: { ...result.provenance, inputHash: "xyz" } },
    { payload: { value: "1" } },
  ])
    expect(schema.safeParse({ ...result, ...patch }).success).toBe(false);
});
it("extends an existing revision plan and preserves sparse audio patches", () => {
  const plan = revisionPlanSchema.parse({
    id: newId("pln"),
    revisionId: newId("rev"),
    feedbackIds: [],
    changes: [],
    createdAt: 0,
  });
  expect(
    reviewPlanSchema.parse({
      ...plan,
      affectedAgents: ["audio"],
      affectedPhases: ["audio"],
    }).audioChanges,
  ).toEqual([]);
  const extended = reviewPlanSchema.parse({
    ...plan,
    affectedAgents: ["audio"],
    affectedPhases: ["audio"],
    audioChanges: [
      {
        trackId: newId("atr"),
        patch: { gainDb: -3 },
        feedbackId: null,
        instruction: "Réduire",
      },
    ],
  });
  expect(extended.audioChanges[0].patch).toEqual({ gainDb: -3 });
  expect(revisionPlanSchema.parse(plan)).toEqual(plan);
});
it("validates brief and engine/human ownership", () => {
  const brief = {
    prompt: "Démo",
    targetDurationMs: 20000,
    format: { width: 1920, height: 1080, fps: 30 },
    audio: { wanted: true, assetIds: [newId("ast")] },
    constraints: [],
  };
  expect(productionBriefSchema.safeParse(brief).success).toBe(true);
  expect(
    productionBriefSchema.safeParse({ ...brief, targetDurationMs: -1 }).success,
  ).toBe(false);
  const plan = {
    phases: [
      {
        phase: "render",
        agent: "engine",
        dependsOn: ["composition"],
        maxAttempts: 2,
      },
      {
        phase: "human-approval",
        agent: "human",
        dependsOn: ["qa"],
        maxAttempts: 1,
      },
    ],
    budget: { maxAiCalls: 3, maxRenders: 2 },
    reason: "Démo",
  };
  expect(productionPlanSchema.safeParse(plan).success).toBe(true);
  for (const phase of [
    { phase: "render", agent: "director", maxAttempts: 2 },
    { phase: "composition", agent: "motion", maxAttempts: 2 },
    { phase: "human-approval", agent: "qa-expert", maxAttempts: 1 },
    { phase: "motion", agent: "motion", maxAttempts: 6 },
  ])
    expect(
      productionPlanSchema.safeParse({
        ...plan,
        phases: [{ ...phase, dependsOn: [] }],
      }).success,
    ).toBe(false);
});

it("prices calls in whole micro-dollars, rounding up real fractions only", () => {
  const pricing = { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.5 };
  // 0.1 x 3 x 10 is 3.0000000000000004 in floating point: 3 micro-dollars, not 4.
  expect(
    usageMicroUsd(
      { inputUsdPerMTok: 10, outputUsdPerMTok: 0 },
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 3 },
    ),
  ).toBe(3);
  expect(usageMicroUsd(pricing, { input_tokens: 0, output_tokens: 1 })).toBe(2);
  expect(
    worstCaseMicroUsd({ inputUsdPerMTok: 4, outputUsdPerMTok: 20 }, 0, 16000),
  ).toBe(320_000);
  expect(usdToMicroUsd(0.35)).toBe(350_000);
  expect(() => usdToMicroUsd(-1)).toThrow();
  expect(() => usdToMicroUsd(Number.NaN)).toThrow();
  expect(
    productionRunSchema.parse({
      id: "run_1",
      projectId: "prj_1",
      kind: "production",
      plan: {
        phases: [],
        budget: { maxAiCalls: 1, maxRenders: 1 },
        reason: "R",
      },
      createdAt: 1,
      updatedAt: 1,
    }),
  ).toMatchObject({ budgetMicroUsd: 0, spentMicroUsd: 0, reservedMicroUsd: 0 });
});
