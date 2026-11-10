import { z } from "zod";

// T127: capability registry contract (docs/ai/TOOL-REGISTRY.md § 2 and § 4).
export const permissionClassSchema = z.enum([
  "read-only",
  "local-compute",
  "writes-revision-artefacts",
  "generated-code-execution",
  "network-external",
  "billable",
]);
export const toolMetaSchema = z
  .object({
    // Dotted and stable ("captions.export"); bump `version` on an incompatible change.
    id: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/),
    version: z.number().int().positive(),
    description: z.string().min(1),
    requires: z.array(z.string().min(1)),
    capabilities: z.array(z.string().min(1)),
    permissions: z.array(permissionClassSchema).min(1),
    sideEffects: z.enum(["none", "artefacts", "revision", "external"]),
    network: z.enum(["none", "pinned-destination"]),
    cost: z.object({
      kind: z.enum(["free", "local-cpu", "billable"]),
      estimate: z.string().optional(),
    }),
    limits: z.object({
      timeoutMs: z.number().int().positive(),
      cpuSeconds: z.number().positive().optional(),
      outputBytes: z.number().int().positive().optional(),
    }),
    produces: z.array(z.string().min(1)),
    validation: z.array(z.string().min(1)),
    deterministic: z.boolean(),
  })
  .strict();
export const toolErrorSchema = z.object({
  code: z.enum([
    "unknown-tool",
    "invalid-input",
    "permission-denied",
    "unavailable",
    "timeout",
    "failed",
    "invalid-output",
    // T128: stale parent, missing target or incompatible operations.
    "conflict",
  ]),
  message: z.string().min(1),
  details: z.json().optional(),
  installHint: z.string().optional(),
  retryable: z.boolean(),
});
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const toolArtefactSchema = z.object({
  kind: z.string().min(1),
  // Relative to the project storage root: never absolute, never "..".
  path: z
    .string()
    .min(1)
    .refine(
      (p) => !p.startsWith("/") && !p.split("/").some((s) => !s || s === ".."),
      "Relative path inside the storage root",
    ),
  sha256,
});
const resultBase = {
  toolId: z.string().min(1),
  // Null only for an unknown tool.
  toolVersion: z.number().int().positive().nullable(),
  // inputHash of the raw input; null when it is not plain JSON (refused as invalid-input).
  inputHash: sha256.nullable(),
  durationMs: z.number().nonnegative(),
  artefacts: z.array(toolArtefactSchema),
  simulated: z.boolean(),
};
export const toolResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), ...resultBase, output: z.unknown() }),
  z.object({ ok: z.literal(false), ...resultBase, error: toolErrorSchema }),
]);
export type PermissionClass = z.infer<typeof permissionClassSchema>;
export type ToolMeta = z.infer<typeof toolMetaSchema>;
export type ToolError = z.infer<typeof toolErrorSchema>;
export type ToolArtefact = z.infer<typeof toolArtefactSchema>;
export type ToolResult = z.infer<typeof toolResultSchema>;
