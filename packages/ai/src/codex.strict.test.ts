import { afterAll, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexExecProvider, revisionProposalSchema } from "./index";

/**
 * Audit 2026-11-11 (T147): strict mode answers null for every optional field, and the
 * provider retries with dropNulls. A fake `codex` executable writes a chosen answer;
 * no real Codex binary, no network.
 */
const dir = mkdtempSync(join(tmpdir(), "veyra-codex-strict-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const bin = join(dir, "codex");
writeFileSync(
  bin,
  `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(out, fs.readFileSync(process.env.CODEX_HOME + "/answer.json", "utf8"));
process.stdout.write('{"type":"turn.completed"}\\n');
`,
);
chmodSync(bin, 0o755);
const provider = new CodexExecProvider({
  command: bin,
  env: { HOME: dir, CODEX_HOME: dir },
  timeoutMs: 5000,
});
const ask = (answer: unknown) => {
  writeFileSync(join(dir, "answer.json"), JSON.stringify(answer));
  return provider.ask(revisionProposalSchema, "s", "t", []);
};
// Optional patch fields answered null, as strict mode does.
const strictPatch = {
  text: "Nouveau texte",
  durationMs: null,
  enter: null,
  animationMs: null,
  params: null,
};
const change = (feedbackId: string | null) => ({
  feedbackId,
  sceneId: "scn_one",
  instruction: "Changer le texte",
  patch: strictPatch,
});

it("drops strict-mode nulls of optional fields when required fields are set", async () => {
  const out = await ask({
    summary: "Plan",
    changes: [change("fdb_one")],
    conflicts: [],
    audioChanges: [],
  });
  expect(out.changes[0]).toEqual({
    feedbackId: "fdb_one",
    sceneId: "scn_one",
    instruction: "Changer le texte",
    patch: { text: "Nouveau texte" },
  });
});

// Fixed in T148 (audit 2026-11-11 D2): dropNulls is guided by the original schema, so a
// required nullable field (changes[].feedbackId / sceneId) keeps its null.
it("keeps a required nullable field at null while dropping optional nulls", async () => {
  const out = await ask({
    summary: "Plan",
    changes: [change(null)],
    conflicts: [],
    audioChanges: [],
  });
  expect(out.changes[0].feedbackId).toBeNull();
  expect(out.changes[0].patch).toEqual({ text: "Nouveau texte" });
});

it("accepts a realistic strict revision plan (global change, unlinked audio change)", async () => {
  const out = await ask({
    summary: "Rythme plus lent",
    changes: [
      {
        feedbackId: null,
        sceneId: null,
        instruction: "Allonger chaque scène",
        patch: {
          text: null,
          durationMs: 4000,
          enter: null,
          animationMs: null,
          params: null,
        },
      },
      change("fdb_two"),
    ],
    conflicts: [
      { feedbackIds: ["fdb_a", "fdb_b"], description: "Contradiction" },
    ],
    audioChanges: [
      {
        trackId: "atr_music",
        feedbackId: null,
        instruction: "Baisser la musique",
        patch: {
          gainDb: -6,
          fadeInMs: null,
          fadeOutMs: null,
          duck: null,
          anchor: null,
        },
      },
    ],
  });
  expect(revisionProposalSchema.parse(out)).toEqual(out);
  expect(out.changes[0]).toEqual({
    feedbackId: null,
    sceneId: null,
    instruction: "Allonger chaque scène",
    patch: { durationMs: 4000 },
  });
  expect(out.audioChanges[0].feedbackId).toBeNull();
});
