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
