import { createHash } from "node:crypto";
import { z } from "zod";
import { idSchema, storyboardSchema, revisionPlanSchema } from "./core";
import { audioMixPatchSchema } from "./audio";
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
export const scriptSpecificationSchema = z.object({
  title: z.string(),
  beats: z.array(
    z.object({
      sceneRef: z.number().int().nonnegative(),
      narration: z.string().optional(),
      intent: z.string(),
    }),
  ),
});
export const storyboardSpecification = storyboardSchema;
export const motionCompositionSchema = z.object({
  storyboard: storyboardSchema,
  registryVersion: z.number().int().nonnegative(),
});
export const reviewPlanSchema = revisionPlanSchema.extend({
  affectedAgents: z.array(agentIdSchema),
  affectedPhases: z.array(phaseSchema),
  audioChanges: z
    .array(
      z.object({
        trackId: idSchema("atr"),
        patch: audioMixPatchSchema,
        feedbackId: idSchema("fdb").nullable(),
        instruction: z.string().min(1),
      }),
    )
    .default([]),
});
export function agentResultSchema<T extends z.ZodType>(payloadSchema: T) {
  return z.object({
    id: idSchema("phs"),
    schemaVersion: z.literal(1),
    agent: agentIdSchema,
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
/** JSON values only: reject lossy inputs rather than hash an ambiguous encoding. */
export function inputHash(value: unknown): string {
  const json = z.json().parse(value);
  const stable = (v: z.infer<ReturnType<typeof z.json>>): string => {
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    if (v !== null && typeof v === "object")
      return `{${Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
        .join(",")}}`;
    return JSON.stringify(v);
  };
  return createHash("sha256").update(stable(json)).digest("hex");
}
