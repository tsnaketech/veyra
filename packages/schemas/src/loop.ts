import { z } from "zod";
import { idSchema } from "./ids";
import { phaseSchema } from "./production";
import {
  permissionClassSchema,
  toolErrorSchema,
  toolResultSchema,
} from "./tools";

// T129a: controlled tool loop (docs/ai/DIRECTOR-TOOL-LOOP.md § 3).
const toolId = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
const justification = z.string().min(1).max(500);
const callFields = {
  toolId,
  toolVersion: z.number().int().positive(),
  input: z.json(),
  justification,
};
/** Working plan of the Director (T129b): text only, never executed as such. */
export const directorPlanSchema = z
  .object({
    goal: z.string().min(1).max(500),
    steps: z.array(z.string().min(1).max(300)).min(1).max(20),
  })
  .strict();
/**
 * One decision of a step source (scripted or the Director): call a tool, ask a human to
 * authorize one call before it runs, revise the working plan, ask the user a question
 * (a pause distinct from a permission), finish for human approval, or stop.
 * The tool input is validated afterwards by the tool's own schema (double validation).
 */
export const directorStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tool_call"), ...callFields }).strict(),
  z.object({ action: z.literal("request_permission"), ...callFields }).strict(),
  z
    .object({
      action: z.literal("request_approval"),
      revisionId: idSchema("rev").nullable(),
      summary: justification,
    })
    .strict(),
  z
    .object({
      action: z.literal("revise_plan"),
      plan: directorPlanSchema,
      justification,
    })
    .strict(),
  z
    .object({
      action: z.literal("ask_user"),
      question: z.string().min(1).max(1000),
      justification,
    })
    .strict(),
  z.object({ action: z.literal("stop"), reason: justification }).strict(),
]);
/** What the loop hands to the registry for one call (same agent/phase fields as agentResultSchema). */
export const toolInvocationSchema = z
  .object({
    stepId: idSchema("stp"),
    runId: idSchema("run"),
    phaseId: idSchema("phs"),
    agent: z.literal("director"),
    phase: phaseSchema,
    toolId,
    toolVersion: z.number().int().positive(),
    input: z.json(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    // Grants of this call only: phase grants plus a human authorization, never wider.
    grants: z.array(permissionClassSchema),
  })
  .strict();
/**
 * "awaiting-permission" is stored for every human pause (migration 0008 checks the
 * status): an `ask_user` step in that status waits for an answer, not for a permission.
 */
export const loopStepStatusSchema = z.enum([
  "awaiting-permission",
  "authorized",
  "denied",
  "running",
  "done",
  "failed",
  "interrupted",
  "cancelled",
]);
const time = z.number().int().nonnegative();
/** Persisted record of one step (table loop_steps); `result` is bounded (truncated output). */
export const toolExecutionRecordSchema = z.object({
  id: idSchema("stp"),
  runId: idSchema("run"),
  phaseId: idSchema("phs"),
  step: z.number().int().nonnegative(),
  // "engine" for a step the loop forces itself (limit reached).
  origin: z.enum(["source", "engine"]),
  action: z.enum([
    "tool_call",
    "request_permission",
    "request_approval",
    "revise_plan",
    "ask_user",
    "stop",
    "invalid",
  ]),
  request: z.json(),
  invocation: toolInvocationSchema.nullable().default(null),
  status: loopStepStatusSchema,
  result: toolResultSchema.nullable().default(null),
  error: toolErrorSchema.nullable().default(null),
  costMicroUsd: z.number().int().nonnegative().default(0),
  durationMs: z.number().nonnegative().nullable().default(null),
  startedAt: time.nullable().default(null),
  finishedAt: time.nullable().default(null),
  createdAt: time,
  updatedAt: time,
});
export const loopLimitsSchema = z
  .object({
    maxSteps: z.number().int().positive().default(20),
    maxToolCalls: z.number().int().positive().default(40),
    maxConsecutiveFailures: z.number().int().positive().default(3),
    // Bytes of one persisted tool result; larger outputs are truncated.
    maxObservationBytes: z
      .number()
      .int()
      .min(1024)
      .default(16 * 1024),
    // Active wall time of one drive of the loop (human pauses excluded).
    maxWallMs: z
      .number()
      .int()
      .min(1000)
      .default(30 * 60_000),
  })
  .strict();
export const loopStatusSchema = z.enum([
  "running",
  "paused-awaiting-permission",
  "paused-awaiting-answer",
  "stopped",
  "failed",
  "completed",
]);
/** Derived from the persisted steps after every transition (never kept only in memory). */
export const loopStateSchema = z.object({
  runId: idSchema("run"),
  phaseId: idSchema("phs"),
  step: z.number().int().nonnegative(),
  status: loopStatusSchema,
  counters: z.object({
    steps: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    consecutiveFailures: z.number().int().nonnegative(),
  }),
  limits: loopLimitsSchema,
  costMicroUsd: z.number().int().nonnegative(),
  // Last plan of a done revise_plan step.
  plan: directorPlanSchema.nullable().default(null),
  pendingStepId: idSchema("stp").nullable(),
  error: z.string().nullable(),
});
/** Payload of a phase run as a tool loop, persisted in its agent result envelope. */
export const toolLoopOutcomeSchema = z
  .object({
    loop: loopStateSchema,
    revisionId: idSchema("rev").nullable(),
    summary: z.string().min(1),
  })
  .strict();
export type DirectorStep = z.infer<typeof directorStepSchema>;
export type DirectorPlan = z.infer<typeof directorPlanSchema>;
export type ToolInvocation = z.infer<typeof toolInvocationSchema>;
export type ToolExecutionRecord = z.infer<typeof toolExecutionRecordSchema>;
export type LoopLimits = z.infer<typeof loopLimitsSchema>;
export type LoopState = z.infer<typeof loopStateSchema>;
