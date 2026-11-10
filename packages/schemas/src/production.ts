import { z } from "zod";
import { idSchema, storyboardSchema, revisionPlanSchema } from "./core";
export { qualityReportSchema } from "./core";

// Veyra business agents, not Claude Code development subagents.
export const agentIdSchema = z.enum([
  "director",
  "motion",
  "audio",
  "review",
  "qa-expert",
]);
export const phaseSchema = z.enum([
  "brief",
  "plan",
  "script",
  "motion",
  "audio",
  "composition",
  "render",
  "qa",
  "human-approval",
]);
export const productionBriefSchema = z.object({
  prompt: z.string().min(1),
  targetDurationMs: z.number().positive(),
  format: z.object({
    width: storyboardSchema.shape.width,
    height: storyboardSchema.shape.height,
    fps: storyboardSchema.shape.fps,
  }),
  audio: z.object({ wanted: z.boolean(), assetIds: z.array(idSchema("ast")) }),
  constraints: z.array(z.string()),
});
export const productionPlanSchema = z.object({
  phases: z.array(
    z
      .object({
        phase: phaseSchema,
        agent: z.union([agentIdSchema, z.enum(["engine", "human"])]),
        dependsOn: z.array(phaseSchema),
        maxAttempts: z.number().int().min(1).max(5),
      })
      .refine(
        (p) =>
          p.phase === "composition" || p.phase === "render"
            ? p.agent === "engine"
            : p.phase === "human-approval"
              ? p.agent === "human"
              : agentIdSchema.safeParse(p.agent).success,
        "Invalid phase owner",
      ),
  ),
  budget: z.object({
    maxAiCalls: z.number().int().nonnegative(),
    maxRenders: z.number().int().nonnegative(),
  }),
  reason: z.string().min(1),
});
export const storyboardSpecification = storyboardSchema;
export const motionCompositionSchema = z.object({
  storyboard: storyboardSchema,
  registryVersion: z.number().int().nonnegative(),
});
// The revision plan already carries patches and audio changes; review adds the routing.
export const reviewPlanSchema = revisionPlanSchema.extend({
  affectedAgents: z.array(agentIdSchema),
  affectedPhases: z.array(phaseSchema),
});
export function agentResultSchema<T extends z.ZodType>(payloadSchema: T) {
  return z.object({
    id: idSchema("phs"),
    schemaVersion: z.literal(1),
    // Engine and human phases are attributed to themselves, as in the plan.
    agent: z.union([agentIdSchema, z.enum(["engine", "human"])]),
    phase: phaseSchema,
    revisionId: idSchema("rev").nullable(),
    dependsOn: z.array(idSchema("phs")),
    provider: z.enum([
      "fake",
      "anthropic-api",
      "claude-subscribe",
      "openai-api",
      "codex-chatgpt",
      "rules",
      "engine",
      "human",
    ]),
    provenance: z.object({
      inputHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
      createdAt: z.number().int().nonnegative(),
      model: z.string().nullable(),
    }),
    warnings: z.array(z.string()),
    errors: z.array(z.string()),
    validation: z.enum(["pending", "valid", "invalid", "needs-human"]),
    payload: payloadSchema,
  });
}
export type ProductionBrief = z.infer<typeof productionBriefSchema>;
export type ProductionPlan = z.infer<typeof productionPlanSchema>;
export type Phase = z.infer<typeof phaseSchema>;
export type AgentId = z.infer<typeof agentIdSchema>;
export type ReviewPlan = z.infer<typeof reviewPlanSchema>;

const time = z.number().int().nonnegative();
export const microUsdSchema = z.number().int().nonnegative();
const microUsd = microUsdSchema;
export const productionRunStatusSchema = z.enum([
  "running",
  "waiting",
  "completed",
  "failed",
  "stopped",
]);
export const productionPhaseStatusSchema = z.enum([
  "pending",
  "running",
  "done",
  "failed",
  "waiting",
  "skipped",
]);
/** One orchestrated production or revision, with its Director plan and budget usage. */
export const productionRunSchema = z.object({
  id: idSchema("run"),
  projectId: idSchema("prj"),
  kind: z.enum(["production", "revision"]),
  status: productionRunStatusSchema.default("running"),
  brief: productionBriefSchema.nullable().default(null),
  plan: productionPlanSchema,
  sourceRevisionId: idSchema("rev").nullable().default(null),
  revisionId: idSchema("rev").nullable().default(null),
  aiCalls: z.number().int().nonnegative().default(0),
  // Spend envelope (D022), in integer micro-dollars; 0 authorizes no billable call.
  budgetMicroUsd: microUsd.default(0),
  spentMicroUsd: microUsd.default(0),
  reservedMicroUsd: microUsd.default(0),
  error: z.string().nullable().default(null),
  createdAt: time,
  updatedAt: time,
});
/** Persisted state of one phase; `result` is the agent result envelope once done. */
export const productionPhaseSchema = z.object({
  id: idSchema("phs"),
  runId: idSchema("run"),
  phase: phaseSchema,
  agent: z.union([agentIdSchema, z.enum(["engine", "human"])]),
  status: productionPhaseStatusSchema.default("pending"),
  attempts: z.number().int().nonnegative().default(0),
  inputHash: z.string().nullable().default(null),
  result: z.record(z.string(), z.json()).nullable().default(null),
  error: z.string().nullable().default(null),
  startedAt: time.nullable().default(null),
  finishedAt: time.nullable().default(null),
  createdAt: time,
  updatedAt: time,
});
export type ProductionRun = z.infer<typeof productionRunSchema>;
export type ProductionPhase = z.infer<typeof productionPhaseSchema>;

/** Local price list of one model, in USD per million tokens (= micro-dollars per token). */
export type ModelPricing = {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
};
/** Subset of the Messages API `usage` object that is billed. */
export type BilledUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};
// Float noise (0.1 * 3 = 0.30000000000000004) must not add a micro-dollar; real fractions round up.
const ceilMicro = (x: number) => Math.ceil(Math.round(x * 1000) / 1000);
/**
 * Upper bound of one call: every input token billed at the cache-write rate (x1.25, the
 * dearest input tier) and the whole `max_tokens` billed as output (thinking included).
 */
export function worstCaseMicroUsd(
  pricing: ModelPricing,
  inputTokens: number,
  maxTokens: number,
) {
  return ceilMicro(
    inputTokens * 1.25 * pricing.inputUsdPerMTok +
      maxTokens * pricing.outputUsdPerMTok,
  );
}
/** Observed cost from `response.usage`: cache writes x1.25, cache reads x0.1. */
export function usageMicroUsd(pricing: ModelPricing, usage: BilledUsage) {
  const input =
    usage.input_tokens +
    1.25 * (usage.cache_creation_input_tokens ?? 0) +
    0.1 * (usage.cache_read_input_tokens ?? 0);
  return ceilMicro(
    input * pricing.inputUsdPerMTok +
      usage.output_tokens * pricing.outputUsdPerMTok,
  );
}
export function usdToMicroUsd(usd: number) {
  if (!Number.isFinite(usd) || usd < 0)
    throw new Error("Montant en USD invalide");
  return Math.round(usd * 1e6);
}
export const formatUsd = (micro: number) => (micro / 1e6).toFixed(4);
/** Refusal raised before a billable call that would overrun the run's envelope. */
export class BudgetExceededError extends Error {
  constructor(
    readonly spentMicroUsd: number,
    readonly reservedMicroUsd: number,
    readonly budgetMicroUsd: number,
    readonly neededMicroUsd: number,
  ) {
    const held = reservedMicroUsd
      ? ` (dont ${formatUsd(reservedMicroUsd)} $ réservés)`
      : "";
    super(
      `Budget insuffisant : ${formatUsd(spentMicroUsd + reservedMicroUsd)} $ dépensés${held}, ` +
        `${formatUsd(budgetMicroUsd)} $ autorisés, ${formatUsd(neededMicroUsd)} $ nécessaires`,
    );
    this.name = "BudgetExceededError";
  }
}
