import { expect, it } from "vitest";
import {
  directorStepSchema,
  loopLimitsSchema,
  toolInvocationSchema,
  toolLoopOutcomeSchema,
} from "./index";

const call = {
  toolId: "media.inspect",
  toolVersion: 1,
  input: { revisionId: "rev_1" },
  justification: "Mesurer la vidéo",
};

it("accepts the four step actions and refuses anything else", () => {
  for (const step of [
    { action: "tool_call", ...call },
    { action: "request_permission", ...call },
    { action: "request_approval", revisionId: "rev_1", summary: "Prêt" },
    { action: "stop", reason: "Rien à faire" },
  ])
    expect(directorStepSchema.safeParse(step).success).toBe(true);
  for (const step of [
    { action: "shell", command: "rm -rf /" },
    { action: "tool_call", ...call, argv: ["-i", "x"] },
    { action: "tool_call", ...call, toolId: "../etc" },
    { action: "tool_call", ...call, justification: "" },
    { action: "tool_call", ...call, input: { f: () => 1 } },
    { action: "stop" },
  ])
    expect(directorStepSchema.safeParse(step).success).toBe(false);
});

it("defaults the loop limits to DIRECTOR-TOOL-LOOP § 4 and keeps invocations strict", () => {
  expect(loopLimitsSchema.parse({})).toEqual({
    maxSteps: 20,
    maxToolCalls: 40,
    maxConsecutiveFailures: 3,
    maxObservationBytes: 16384,
  });
  const invocation = {
    stepId: "stp_1",
    runId: "run_1",
    phaseId: "phs_1",
    agent: "director",
    phase: "plan",
    toolId: "media.inspect",
    toolVersion: 1,
    input: {},
    inputHash: "a".repeat(64),
    grants: ["read-only"],
  };
  expect(toolInvocationSchema.safeParse(invocation).success).toBe(true);
  expect(
    toolInvocationSchema.safeParse({ ...invocation, grants: ["root"] }).success,
  ).toBe(false);
  expect(
    toolLoopOutcomeSchema.safeParse({ summary: "x", revisionId: null }).success,
  ).toBe(false);
});
