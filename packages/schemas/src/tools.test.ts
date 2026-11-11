import { expect, it } from "vitest";
import { toolArtefactSchema, toolMetaSchema, toolResultSchema } from "./index";

const meta = {
  id: "media.inspect",
  version: 1,
  description: "Mesure",
  requires: ["ffprobe"],
  capabilities: [],
  permissions: ["read-only"],
  sideEffects: "none",
  network: "none",
  cost: { kind: "free" },
  limits: { timeoutMs: 1000 },
  produces: [],
  validation: ["zod"],
  deterministic: true,
};
const hash = "a".repeat(64);

it("accepts a dotted tool id and refuses unknown keys or permissions", () => {
  expect(toolMetaSchema.parse(meta)).toEqual(meta);
  for (const bad of [
    { ...meta, id: "inspect" },
    { ...meta, id: "Media.Inspect" },
    { ...meta, permissions: ["shell"] },
    { ...meta, permissions: [] },
    { ...meta, run: "x" },
  ])
    expect(toolMetaSchema.safeParse(bad).success).toBe(false);
});

it("keeps artefact paths relative to the storage root", () => {
  const ok = {
    kind: "png",
    path: "prj_a/tool-calls/tcl_b/f.png",
    sha256: hash,
  };
  expect(toolArtefactSchema.parse(ok)).toEqual(ok);
  for (const path of ["/etc/passwd", "prj_a/../x", "prj_a//x", ""])
    expect(toolArtefactSchema.safeParse({ ...ok, path }).success).toBe(false);
});

it("discriminates ok and error results", () => {
  const base = {
    toolId: "media.inspect",
    toolVersion: 1,
    inputHash: hash,
    durationMs: 3,
    artefacts: [],
    simulated: false,
    cost: { kind: "local-cpu", microUsd: 0 },
  };
  expect(
    toolResultSchema.parse({ ...base, ok: true, output: { a: 1 } }).ok,
  ).toBe(true);
  expect(
    toolResultSchema.safeParse({
      ...base,
      ok: false,
      error: {
        code: "unavailable",
        message: "x",
        installHint: "y",
        retryable: false,
      },
    }).success,
  ).toBe(true);
  expect(
    toolResultSchema.safeParse({
      ...base,
      ok: false,
      error: { code: "crashed", message: "x", retryable: false },
    }).success,
  ).toBe(false);
});
