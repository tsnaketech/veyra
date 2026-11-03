import { z } from "zod";
import { idSchema } from "./ids";
import { audioCompositionSchema, audioMixPatchSchema } from "./audio";
import { captionTrackSchema, voiceProviderSchema } from "./captions";
export * from "./ids";
const timestamp = z.number().int().nonnegative();
const base = { createdAt: timestamp, updatedAt: timestamp };
export const renderJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const videoRevisionStatusSchema = z.enum([
  "draft",
  "rendering",
  "qa",
  "awaiting_approval",
  "approved",
  "changes_requested",
  "published",
  "failed",
]);
// draft: saved, editable, never sent. queued/submitted: inside a correction batch.
export const feedbackStatusSchema = z.enum([
  "draft",
  "queued",
  "submitted",
  "applied",
  "rejected",
  "failed",
]);
export const correctionBatchStatusSchema = z.enum([
  "queued",
  "submitted",
  "awaiting_import",
  "planned",
  "applied",
  "rejected",
  "failed",
]);
export const qualityEvaluationStatusSchema = z.enum([
  "pending",
  "awaiting_import",
  "completed",
  "failed",
  "unavailable",
]);
export const aiTaskStatusSchema = z.enum([
  "awaiting_import",
  "imported",
  "failed",
]);
export const transitions = {
  RenderJob: {
    queued: ["running", "cancelled"],
    running: ["succeeded", "failed", "cancelled"],
    succeeded: [],
    failed: [],
    cancelled: [],
  },
  VideoRevision: {
    draft: ["rendering"],
    rendering: ["qa", "failed"],
    qa: ["awaiting_approval", "failed"],
    awaiting_approval: ["approved", "changes_requested"],
    // Corrections never reopen a rendered revision: they create a child revision.
    changes_requested: [],
    approved: ["published"],
    published: [],
    failed: [],
  },
  // Deleting a draft is a removal, not a transition.
  Feedback: {
    draft: ["queued"],
    queued: ["submitted", "failed"],
    submitted: ["applied", "rejected", "failed"],
    failed: ["queued"],
    applied: [],
    rejected: [],
  },
  CorrectionBatch: {
    queued: ["submitted", "awaiting_import", "failed"],
    submitted: ["planned", "failed"],
    awaiting_import: ["planned", "failed"],
    planned: ["applied", "rejected"],
    failed: ["queued"],
    applied: [],
    rejected: [],
  },
  // A failed or unavailable evaluation is never reopened: a new one is requested.
  QualityEvaluation: {
    pending: ["awaiting_import", "completed", "failed", "unavailable"],
    awaiting_import: ["completed", "failed"],
    completed: [],
    failed: [],
    unavailable: [],
  },
  // A failed or stopped run resumes from its first unfinished phase.
  ProductionRun: {
    running: ["waiting", "completed", "failed", "stopped"],
    waiting: ["running", "completed", "stopped"],
    failed: ["running"],
    stopped: ["running"],
    completed: [],
  },
  ProductionPhase: {
    pending: ["running", "skipped"],
    running: ["done", "failed", "waiting"],
    waiting: ["done", "failed"],
    failed: ["pending"],
    done: [],
    skipped: [],
  },
  AiTask: {
    awaiting_import: ["imported", "failed"],
    imported: [],
    failed: [],
  },
} as const;
export type TransitionKind = keyof typeof transitions;
export function assertTransition(
  kind: TransitionKind,
  from: string,
  to: string,
): void {
  const table: Record<string, readonly string[]> = transitions[kind];
  if (!Object.hasOwn(table, from) || !table[from].includes(to)) {
    throw new Error(`Illegal ${kind} transition: ${from} → ${to}`);
  }
}
/**
 * Reference to a registered motion component (@veyra/motion validates id, version
 * and params against the registry). Scenes without one render as plain text.
 */
export const sceneComponentSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.number().int().positive(),
    params: z.record(z.string(), z.json()),
    style: z.record(z.string(), z.json()).default({}),
  })
  .strict();
// Spoken text of a scene; optional so storyboards without voice stay unchanged.
export const sceneNarrationSchema = z
  .object({
    text: z.string().trim().min(1).max(1000),
    voice: z
      .object({
        provider: voiceProviderSchema,
        voiceId: z.string().min(1).max(200).nullable().default(null),
        speakerId: z.number().int().nonnegative().nullable().default(null),
        lengthScale: z.number().min(0.5).max(2).default(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SceneNarration = z.infer<typeof sceneNarrationSchema>;
export const sceneSchema = z.object({
  id: idSchema("scn"),
  start: z.number().nonnegative(),
  duration: z.number().positive(),
  text: z.string(),
  animation: z.record(z.string(), z.json()).default({}),
  component: sceneComponentSchema.optional(),
  narration: sceneNarrationSchema.optional(),
});
export const storyboardSchema = z
  .object({
    scenes: z.array(sceneSchema),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
  })
  .superRefine(({ scenes }, ctx) => {
    const ids = new Set<string>();
    scenes.forEach((scene, i) => {
      if (ids.has(scene.id))
        ctx.addIssue({
          code: "custom",
          message: "Duplicate scene id",
          path: ["scenes", i, "id"],
        });
      ids.add(scene.id);
      if (i && scene.start < scenes[i - 1].start + scenes[i - 1].duration) {
        ctx.addIssue({
          code: "custom",
          message: "Scenes must be ordered and non-overlapping",
          path: ["scenes", i, "start"],
        });
      }
    });
  });
export type Scene = z.infer<typeof sceneSchema>;
export type SceneComponent = z.infer<typeof sceneComponentSchema>;
export type Storyboard = z.infer<typeof storyboardSchema>;
// Scene times and the lookup argument are milliseconds; intervals are half-open.
export function sceneAt(storyboard: Storyboard, ms: number): Scene | undefined {
  return storyboard.scenes.find(
    (scene) => ms >= scene.start && ms < scene.start + scene.duration,
  );
}
export const projectSchema = z.object({
  id: idSchema("prj"),
  name: z.string().min(1),
  resolvedConfig: z.record(z.string(), z.json()),
  ...base,
});
export const assetSchema = z.object({
  id: idSchema("ast"),
  projectId: idSchema("prj"),
  path: z.string().min(1),
  mediaType: z.string().min(1),
  // Set for imported audio: validation result of @veyra/audio (metadata is engine-defined JSON).
  audio: z
    .object({
      status: z.enum(["valid", "invalid"]),
      metadata: z.record(z.string(), z.json()).nullable(),
      error: z.string().nullable(),
      category: z.enum(["music", "voiceover", "sfx", "ambience"]).nullable(),
    })
    .nullable()
    .default(null),
  ...base,
});
export const conversationSchema = z.object({
  id: idSchema("cnv"),
  projectId: idSchema("prj"),
  ...base,
});
export const messageSchema = z.object({
  id: idSchema("msg"),
  conversationId: idSchema("cnv"),
  role: z.enum(["user", "assistant", "system", "tool"]),
  text: z.string(),
  createdAt: timestamp,
});
export const videoRevisionSchema = z.object({
  id: idSchema("rev"),
  projectId: idSchema("prj"),
  parentRevisionId: idSchema("rev").nullable().default(null),
  status: videoRevisionStatusSchema.default("draft"),
  storyboard: storyboardSchema,
  resolvedConfig: z.record(z.string(), z.json()),
  videoPath: z.string().nullable(),
  // Measured from the rendered file; the reference for frame indexing.
  media: z
    .object({
      fpsNum: z.number().int().positive(),
      fpsDen: z.number().int().positive(),
      durationMs: z.number().nonnegative(),
      startMs: z.number(),
      frameCount: z.number().int().nonnegative(),
      constantFrameRate: z.boolean(),
    })
    .nullable()
    .default(null),
  // Soundtrack of this revision (immutable with it); null = silent video.
  audio: audioCompositionSchema.nullable().default(null),
  // Captions of this revision (immutable with it); null = no captions.
  captions: captionTrackSchema.nullable().default(null),
  // HyperFrames output without sound, reused when only the audio changes.
  silentVideoPath: z.string().nullable().default(null),
  error: z.string().nullable(),
  ...base,
});
export const renderJobSchema = z.object({
  id: idSchema("rnd"),
  revisionId: idSchema("rev"),
  status: renderJobStatusSchema.default("queued"),
  progress: z.number().int().min(0).max(100).default(0),
  stage: z.string().default("queued"),
  stderrTail: z.string().max(8192).nullable().default(null),
  resolvedConfig: z.record(z.string(), z.json()).default({}),
  outputPath: z.string().nullable(),
  error: z.string().nullable(),
  ...base,
});
export const feedbackSchema = z.object({
  id: idSchema("fdb"),
  projectId: idSchema("prj"),
  revisionId: idSchema("rev"),
  timestampMs: timestamp,
  // Frame-accurate fields are null on comments created before frame indexing.
  frameIndex: z.number().int().nonnegative().nullable().default(null),
  fpsNum: z.number().int().positive().nullable().default(null),
  fpsDen: z.number().int().positive().nullable().default(null),
  capturePath: z.string().nullable().default(null),
  batchId: idSchema("cbt").nullable().default(null),
  sceneId: idSchema("scn").nullable(),
  // Optional end of a time range (>= timestampMs, checked by the repository) and audio target.
  rangeEndMs: timestamp.nullable().default(null),
  audioTrackId: idSchema("atr").nullable().default(null),
  // Caption cue targeted by the comment; must exist in the revision's captions (checked by the Studio).
  captionCueId: idSchema("cue").nullable().default(null),
  text: z.string().min(1),
  status: feedbackStatusSchema.default("draft"),
  author: z.string().min(1),
  ...base,
});
export const correctionVerdictSchema = z.enum([
  "applied",
  "partially_applied",
  "not_applied",
  // Visible change going against what the comment asked (needs judgement, not PSNR).
  "contradicts_request",
  "unverifiable",
]);
export const qualityCategorySchema = z.enum([
  "technical",
  "content",
  "aesthetic",
]);
const expertEvidence = z.object({
  // File name of an image from the evaluation pack; null for a textual observation.
  image: z.string().nullable(),
  observation: z.string().min(1),
});
export const expertVerdictSchema = z.object({
  feedbackId: idSchema("fdb"),
  verdict: correctionVerdictSchema,
  category: qualityCategorySchema,
  confidence: z.number().min(0).max(1),
  justification: z.string().min(1),
  evidence: z.array(expertEvidence),
});
export const expertFindingSchema = z.object({
  kind: z.enum(["regression", "defect", "observation"]),
  category: qualityCategorySchema,
  sceneId: idSchema("scn").nullable(),
  severity: z.enum(["info", "minor", "major", "critical"]),
  confidence: z.number().min(0).max(1),
  justification: z.string().min(1),
  evidence: z.array(expertEvidence),
});
export const correctionVerificationSchema = z.object({
  feedbackId: idSchema("fdb"),
  verdict: correctionVerdictSchema,
  evidence: z.string().min(1),
});
export const correctionBatchSchema = z.object({
  id: idSchema("cbt"),
  projectId: idSchema("prj"),
  sourceRevisionId: idSchema("rev"),
  // Client-generated key: a resubmitted form returns the existing batch.
  submissionKey: z.string().min(8).max(100),
  status: correctionBatchStatusSchema.default("queued"),
  provider: z.string().min(1),
  feedbackIds: z.array(idSchema("fdb")).min(1),
  planId: idSchema("pln").nullable().default(null),
  resultRevisionId: idSchema("rev").nullable().default(null),
  verification: z.array(correctionVerificationSchema).nullable().default(null),
  error: z.string().nullable().default(null),
  ...base,
});
export const aiTaskSchema = z.object({
  id: idSchema("tsk"),
  projectId: idSchema("prj"),
  kind: z.enum(["storyboard", "plan", "evaluation"]),
  provider: z.string().min(1),
  status: aiTaskStatusSchema.default("awaiting_import"),
  batchId: idSchema("cbt").nullable().default(null),
  input: z.record(z.string(), z.json()),
  dir: z.string().min(1),
  error: z.string().nullable().default(null),
  ...base,
});
export const analysisModeSchema = z.enum([
  "deterministic",
  "not-performed",
  "multimodal",
  "text-only",
  "simulated",
]);
export type AnalysisMode = z.infer<typeof analysisModeSchema>;
export function analysisModesFor(
  findings: { analysisMode: AnalysisMode }[],
): AnalysisMode[] {
  return [...new Set(findings.map((finding) => finding.analysisMode))].sort();
}
export const severitySchema = z.enum(["info", "minor", "major", "critical"]);
const finding = {
  severity: severitySchema,
  timestamp: timestamp,
  evidence: z.string().min(1),
  recommendation: z.string().min(1),
  analysisMode: analysisModeSchema,
};
export const qualityCheckSchema = z
  .object({
    id: idSchema("qck"),
    name: z.string().min(1),
    passed: z.boolean(),
    ...finding,
  })
  .refine(
    (check) => check.analysisMode !== "not-performed" || !check.passed,
    "An unperformed check cannot pass",
  );
export const qualityIssueSchema = z.object({
  id: idSchema("qis"),
  sceneId: idSchema("scn").nullable(),
  ...finding,
});
export const qualityReportSchema = z
  .object({
    id: idSchema("qar"),
    revisionId: idSchema("rev"),
    analysisModes: z.array(analysisModeSchema),
    checks: z.array(qualityCheckSchema),
    issues: z.array(qualityIssueSchema),
    createdAt: timestamp,
  })
  .superRefine((report, ctx) => {
    const derived = analysisModesFor([...report.checks, ...report.issues]);
    if (
      report.analysisModes.length !== derived.length ||
      derived.some((mode) => !report.analysisModes.includes(mode))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["analysisModes"],
        message:
          "analysisModes must equal the unique modes of checks and issues",
      });
    }
  });
// Structured scene edit; the only way a plan can change a storyboard.
export const scenePatchSchema = z
  .object({
    text: z.string().min(1).max(140).optional(),
    durationMs: z.number().int().min(1000).max(15000).optional(),
    enter: z.enum(["fade", "slide-up", "scale"]).optional(),
    animationMs: z.number().int().min(100).max(1500).optional(),
    // Component parameters to merge; the result is revalidated by the registry.
    params: z.record(z.string(), z.json()).optional(),
  })
  .strict();
export type ScenePatch = z.infer<typeof scenePatchSchema>;
export const audioChangeSchema = z.object({
  trackId: idSchema("atr"),
  patch: audioMixPatchSchema,
  feedbackId: idSchema("fdb").nullable().default(null),
  instruction: z.string().min(1),
});
export const revisionPlanSchema = z.object({
  id: idSchema("pln"),
  revisionId: idSchema("rev"),
  feedbackIds: z.array(idSchema("fdb")),
  summary: z.string().default(""),
  changes: z.array(
    z.object({
      feedbackId: idSchema("fdb").nullable().default(null),
      sceneId: idSchema("scn").nullable(),
      instruction: z.string().min(1),
      patch: scenePatchSchema.default({}),
    }),
  ),
  conflicts: z
    .array(
      z.object({
        feedbackIds: z.array(idSchema("fdb")).min(2),
        description: z.string().min(1),
      }),
    )
    .default([]),
  // Soundtrack edits of the plan (mix fields of an existing track), applied with the patches.
  audioChanges: z.array(audioChangeSchema).default([]),
  createdAt: timestamp,
});
export const qualityEvaluationSchema = z
  .object({
    id: idSchema("qev"),
    projectId: idSchema("prj"),
    revisionId: idSchema("rev"),
    baseRevisionId: idSchema("rev"),
    batchId: idSchema("cbt").nullable().default(null),
    evaluator: z.enum(["fake", "anthropic-api", "claude-subscribe"]).nullable(),
    // simulated (rules), multimodal (images actually sent / declared examined) or text-only.
    analysisMode: analysisModeSchema
      .exclude(["not-performed"])
      .nullable()
      .default(null),
    status: qualityEvaluationStatusSchema.default("pending"),
    verdicts: z.array(expertVerdictSchema).default([]),
    findings: z.array(expertFindingSchema).default([]),
    imagesExamined: z.array(z.string()).default([]),
    error: z.string().nullable().default(null),
    ...base,
  })
  // A simulated or image-less evaluation can never be stored as multimodal.
  .superRefine((row, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", path: ["analysisMode"], message });
    if (
      row.evaluator === "fake" &&
      row.analysisMode &&
      row.analysisMode !== "simulated"
    )
      issue("The fake evaluator can only produce simulated evaluations");
    if (row.analysisMode === "simulated" && row.evaluator !== "fake")
      issue("Only the fake evaluator produces simulated evaluations");
    if (row.analysisMode === "multimodal" && !row.imagesExamined.length)
      issue("A multimodal evaluation must list the images examined");
    if (row.analysisMode === "deterministic")
      issue("Measurements are not an expert evaluation");
    if (row.status === "completed" && !row.analysisMode)
      issue("A completed evaluation states its analysis mode");
  });
export type Project = z.infer<typeof projectSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type Message = z.infer<typeof messageSchema>;
export type VideoRevision = z.infer<typeof videoRevisionSchema>;
export type RenderJob = z.infer<typeof renderJobSchema>;
export type Feedback = z.infer<typeof feedbackSchema>;
export type QualityReport = z.infer<typeof qualityReportSchema>;
export type QualityCheck = z.infer<typeof qualityCheckSchema>;
export type QualityIssue = z.infer<typeof qualityIssueSchema>;
export type RevisionPlan = z.infer<typeof revisionPlanSchema>;
export type CorrectionBatch = z.infer<typeof correctionBatchSchema>;
export type CorrectionVerdict = z.infer<typeof correctionVerdictSchema>;
export type AiTask = z.infer<typeof aiTaskSchema>;
export type QualityEvaluation = z.infer<typeof qualityEvaluationSchema>;
export type ExpertVerdict = z.infer<typeof expertVerdictSchema>;
export type ExpertFinding = z.infer<typeof expertFindingSchema>;
export type MediaInfo = NonNullable<VideoRevision["media"]>;
export * from "./frames";
