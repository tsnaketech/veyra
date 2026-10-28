import { z } from "zod";
import {
  analysisModeSchema,
  correctionVerdictSchema,
  qualityCategorySchema,
  type CorrectionVerdict,
} from "@veyra/schemas";
import {
  expertReviewSchema,
  type EvaluationInput,
  type ExpertReview,
} from "./evaluation";

/** Versioned QA reference set: inputs plus the verdicts a human expects. */
export const referenceSetSchema = z.object({
  format: z.literal("veyra-qa-reference/v1"),
  /** Who validated the expected verdicts; stays explicit until a human signs off. */
  validation: z.object({
    status: z.enum(["proposed", "human-validated"]),
    note: z.string(),
  }),
  cases: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9-]+$/),
      description: z.string().min(1),
      source: z.enum(["synthetic", "recorded"]),
      reviewedBy: z.string().nullable(),
      // EvaluationInput where image paths are relative to the reference directory.
      input: z.custom<EvaluationInput>(
        (value) => typeof value === "object" && value !== null,
      ),
      expected: z.object({
        verdicts: z.array(
          z.object({
            feedbackId: z.string(),
            verdict: correctionVerdictSchema,
            category: qualityCategorySchema,
          }),
        ),
        regressions: z.array(z.string()),
      }),
    }),
  ),
});
export type ReferenceSet = z.infer<typeof referenceSetSchema>;

export const resultSetSchema = z.object({
  format: z.literal("veyra-qa-results/v1"),
  evaluator: z.enum(["fake", "anthropic-api", "claude-subscribe"]),
  analysisMode: analysisModeSchema,
  note: z.string().default(""),
  cases: z.array(z.object({ caseId: z.string(), review: expertReviewSchema })),
});
export type ResultSet = z.infer<typeof resultSetSchema>;

type Tally = { total: number; correct: number; accuracy: number | null };
const tally = (): Tally => ({ total: 0, correct: 0, accuracy: null });
const finish = (t: Tally) => ({
  ...t,
  accuracy: t.total ? t.correct / t.total : null,
});

/** Accepting a correction that a human would not accept is the costly mistake. */
const notAcceptable: CorrectionVerdict[] = [
  "contradicts_request",
  "not_applied",
  "partially_applied",
];

export interface BenchmarkReport {
  evaluator: ResultSet["evaluator"];
  analysisMode: ResultSet["analysisMode"];
  referenceStatus: ReferenceSet["validation"]["status"];
  overall: Tally;
  byVerdict: Record<string, Tally>;
  byCategory: Record<string, Tally>;
  categoryAgreement: Tally;
  confusion: Record<string, Record<string, number>>;
  criticalErrors: {
    caseId: string;
    feedbackId: string | null;
    reason: string;
  }[];
  regressions: {
    expected: number;
    found: number;
    missed: string[];
    unexpected: string[];
  };
  /** Cases of the reference set without any result: reported, not counted as errors. */
  missingCases: string[];
  coverage: { evaluated: number; total: number };
}

/** Compares expert verdicts to the reference: accuracy, confusion matrix, critical errors. */
export function compareToReference(
  reference: ReferenceSet,
  results: ResultSet,
): BenchmarkReport {
  const overall = tally();
  const categoryAgreement = tally();
  const byVerdict: Record<string, Tally> = {};
  const byCategory: Record<string, Tally> = {};
  const confusion: Record<string, Record<string, number>> = {};
  const criticalErrors: BenchmarkReport["criticalErrors"] = [];
  const regressions = {
    expected: 0,
    found: 0,
    missed: [] as string[],
    unexpected: [] as string[],
  };
  const missingCases: string[] = [];
  for (const item of reference.cases) {
    const review: ExpertReview | undefined = results.cases.find(
      (c) => c.caseId === item.id,
    )?.review;
    if (!review) {
      missingCases.push(item.id);
      continue;
    }
    for (const expected of item.expected.verdicts) {
      const got = review.verdicts.find(
        (v) => v.feedbackId === expected.feedbackId,
      );
      const predicted = got?.verdict ?? "missing";
      const hit = predicted === expected.verdict;
      for (const t of [
        overall,
        (byVerdict[expected.verdict] ??= tally()),
        (byCategory[expected.category] ??= tally()),
      ]) {
        t.total++;
        if (hit) t.correct++;
      }
      categoryAgreement.total++;
      if (got?.category === expected.category) categoryAgreement.correct++;
      const row = (confusion[expected.verdict] ??= {});
      row[predicted] = (row[predicted] ?? 0) + 1;
      if (predicted === "applied" && notAcceptable.includes(expected.verdict))
        criticalErrors.push({
          caseId: item.id,
          feedbackId: expected.feedbackId,
          reason: `acceptée à tort (attendu : ${expected.verdict})`,
        });
      if (predicted === "missing")
        criticalErrors.push({
          caseId: item.id,
          feedbackId: expected.feedbackId,
          reason: "commentaire sans verdict",
        });
    }
    const reported = new Set(
      review.findings
        .filter((f) => f.kind === "regression" && f.sceneId)
        .map((f) => f.sceneId!),
    );
    for (const sceneId of item.expected.regressions) {
      regressions.expected++;
      if (reported.has(sceneId)) regressions.found++;
      else {
        regressions.missed.push(`${item.id}/${sceneId}`);
        criticalErrors.push({
          caseId: item.id,
          feedbackId: null,
          reason: `régression manquée (${sceneId})`,
        });
      }
    }
    for (const sceneId of reported)
      if (!item.expected.regressions.includes(sceneId))
        regressions.unexpected.push(`${item.id}/${sceneId}`);
  }
  const done = (record: Record<string, Tally>) =>
    Object.fromEntries(
      Object.entries(record).map(([key, t]) => [key, finish(t)]),
    );
  return {
    evaluator: results.evaluator,
    analysisMode: results.analysisMode,
    referenceStatus: reference.validation.status,
    overall: finish(overall),
    byVerdict: done(byVerdict),
    byCategory: done(byCategory),
    categoryAgreement: finish(categoryAgreement),
    confusion,
    criticalErrors,
    regressions,
    missingCases,
    coverage: {
      evaluated: reference.cases.length - missingCases.length,
      total: reference.cases.length,
    },
  };
}

const pct = (t: Tally) =>
  t.accuracy === null ? "—" : `${Math.round(t.accuracy * 100)} %`;
const verdicts = correctionVerdictSchema.options;

/** Plain-text report in French, as printed by `pnpm qa:bench`. */
export function formatReport(report: BenchmarkReport): string {
  const lines = [
    `Évaluateur : ${report.evaluator} (${report.analysisMode})`,
    ...(report.analysisMode === "simulated"
      ? [
          "ATTENTION : évaluation simulée (règles sur le storyboard), pas une expertise multimodale.",
        ]
      : []),
    `Références : ${report.referenceStatus === "proposed" ? "proposées, NON validées par un humain" : "validées par un humain"}`,
    "",
    `Cas évalués : ${report.coverage.evaluated}/${report.coverage.total}` +
      (report.missingCases.length
        ? ` (non évalués : ${report.missingCases.join(", ")})`
        : ""),
    `Exactitude globale : ${pct(report.overall)} (${report.overall.correct}/${report.overall.total})`,
    `Catégorie correcte : ${pct(report.categoryAgreement)}`,
    "",
    "Exactitude par catégorie :",
    ...Object.entries(report.byCategory).map(
      ([k, t]) => `  ${k.padEnd(20)} ${pct(t)} (${t.correct}/${t.total})`,
    ),
    "Exactitude par verdict attendu :",
    ...Object.entries(report.byVerdict).map(
      ([k, t]) => `  ${k.padEnd(20)} ${pct(t)} (${t.correct}/${t.total})`,
    ),
    "",
    "Matrice de confusion (lignes : attendu, colonnes : prédit) :",
    `  ${"".padEnd(20)} ${[...verdicts, "missing"].map((v) => v.slice(0, 11).padStart(12)).join("")}`,
    ...verdicts
      .filter((v) => report.confusion[v])
      .map(
        (v) =>
          `  ${v.padEnd(20)} ${[...verdicts, "missing"]
            .map((p) => String(report.confusion[v][p] ?? 0).padStart(12))
            .join("")}`,
      ),
    "",
    `Régressions : ${report.regressions.found}/${report.regressions.expected} trouvées` +
      (report.regressions.unexpected.length
        ? `, ${report.regressions.unexpected.length} signalée(s) en plus`
        : ""),
    `Erreurs critiques : ${report.criticalErrors.length}`,
    ...report.criticalErrors.map(
      (e) =>
        `  - ${e.caseId}${e.feedbackId ? `/${e.feedbackId}` : ""} : ${e.reason}`,
    ),
  ];
  return lines
    .filter((line, i) => line !== "" || lines[i - 1] !== "")
    .join("\n");
}
