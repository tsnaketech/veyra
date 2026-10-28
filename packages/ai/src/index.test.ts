import { describe, expect, it } from "vitest";
import { sceneAt } from "@veyra/schemas";
import {
  applyProposal,
  createProvider,
  checkClaudeSubscribe,
  AssistedProvider,
  FakeAiProvider,
  toStoryboard,
} from "./index";

const format = { width: 1920, height: 1080, fps: 30 };
const prompt =
  "Crée une vidéo de 20 secondes présentant un service de création de sites web et d'infogérance pour petites entreprises.";

it("turns the reference prompt into a valid 20 s storyboard", async () => {
  const draft = await new FakeAiProvider().generateStoryboard(prompt, {
    targetDurationMs: 15000,
    styleInstructions: "",
  });
  const board = toStoryboard(draft, format);
  const end = board.scenes.at(-1)!;
  expect(end.start + end.duration).toBe(20000);
  expect(board.scenes.length).toBeGreaterThan(1);
  expect(board.scenes[0].text).toMatch(/^Service de création de sites web/);
});

it("maps a timestamped 'slow down' comment to the scene playing at 12 s", async () => {
  const ai = new FakeAiProvider();
  const board = toStoryboard(
    await ai.generateStoryboard(prompt, {
      targetDurationMs: 0,
      styleInstructions: "",
    }),
    format,
  );
  const target = sceneAt(board, 12000)!;
  const plan = await ai.planRevision(board, [
    {
      id: "fdb_1",
      text: "À 12 secondes, ralentis l'animation du texte.",
      timestampMs: 12000,
      sceneId: null,
    },
  ]);
  expect(plan.changes).toEqual([
    expect.objectContaining({
      sceneId: target.id,
      patch: { animationMs: 800 },
    }),
  ]);
  const revised = applyProposal(board, plan.changes, 60000);
  expect(sceneAt(revised, 12000)!.animation.durationMs).toBe(800);
  // The source storyboard is never mutated.
  expect(target.animation.durationMs).toBe(500);
});

it("leaves uninterpretable comments without patch and rejects overlong revisions", async () => {
  const ai = new FakeAiProvider();
  const board = toStoryboard(
    await ai.generateStoryboard("Vidéo de 5 s sur Veyra", {
      targetDurationMs: 0,
      styleInstructions: "",
    }),
    format,
  );
  const plan = await ai.planRevision(board, [
    { id: "fdb_1", text: "Mets plus d'émotion", timestampMs: 0, sceneId: null },
  ]);
  expect(plan.changes[0].patch).toEqual({});
  expect(plan.changes[0].instruction).toMatch(/Non interprété/);
  expect(() =>
    applyProposal(
      board,
      [{ sceneId: board.scenes[0].id, patch: { durationMs: 15000 } }],
      10000,
    ),
  ).toThrow(/exceeds/);
});

it("labels fake review output as simulated and never as multimodal", async () => {
  const [finding] = await new FakeAiProvider().reviewFrames(
    toStoryboard(
      {
        title: "t",
        scenes: [
          { text: "a", durationMs: 1000, enter: "fade", animationMs: 100 },
        ],
      },
      format,
    ),
    [{ timestampMs: 0, path: "/nonexistent.png" }],
  );
  expect(finding.analysisMode).toBe("simulated");
  expect(finding.evidence).toMatch(/aucune analysée/);
});

it("builds only the selected provider and never falls back to the API", () => {
  expect(createProvider("fake", {}, "m").kind).toBe("fake");
  expect(
    createProvider("claude-subscribe", { ANTHROPIC_API_KEY: "dummy" }, "m"),
  ).toMatchObject({
    kind: "claude-subscribe",
    mode: "assisted",
  });
  expect(
    createProvider("anthropic-api", { ANTHROPIC_API_KEY: "dummy" }, "m").kind,
  ).toBe("anthropic-api");
  expect(() => createProvider("anthropic-api", {}, "m")).toThrow(
    /ANTHROPIC_API_KEY/,
  );
});

it("reports conflicting comments on one scene and applies neither", async () => {
  const ai = new FakeAiProvider();
  const board = toStoryboard(
    await ai.generateStoryboard(prompt, {
      targetDurationMs: 0,
      styleInstructions: "",
    }),
    format,
  );
  const plan = await ai.planRevision(board, [
    {
      id: "fdb_a",
      text: "Ralentis ce texte",
      timestampMs: 12000,
      sceneId: null,
    },
    {
      id: "fdb_b",
      text: "Accélère ce texte",
      timestampMs: 12500,
      sceneId: null,
    },
  ]);
  expect(plan.conflicts).toEqual([
    expect.objectContaining({ feedbackIds: ["fdb_a", "fdb_b"] }),
  ]);
  expect(plan.changes.map((change) => change.patch)).toEqual([{}, {}]);
  expect(plan.changes.map((change) => change.feedbackId)).toEqual([
    "fdb_a",
    "fdb_b",
  ]);
});

describe("claude-subscribe detection", () => {
  const runner =
    (responses: Record<string, string | Error>) =>
    async (_: string, args: string[], env: NodeJS.ProcessEnv) => {
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      const response = responses[args.join(" ")];
      if (response instanceof Error) throw response;
      return { stdout: response };
    };
  const version = { "--version": "2.1.312 (Claude Code)" };
  it("is unavailable when Claude Code is not installed", async () => {
    const status = await checkClaudeSubscribe({
      runner: runner({ "--version": new Error("ENOENT") }),
      env: {},
    });
    expect(status).toMatchObject({ available: false, installed: false });
    expect(status.reason).toMatch(/introuvable/);
  });
  it("is unavailable when not logged in", async () => {
    const status = await checkClaudeSubscribe({
      runner: runner({
        ...version,
        "auth status --json": '{"loggedIn":false}',
      }),
      env: {},
    });
    expect(status).toMatchObject({
      available: false,
      installed: true,
      loggedIn: false,
    });
  });
  it("refuses a non-subscription login", async () => {
    const status = await checkClaudeSubscribe({
      runner: runner({
        ...version,
        "auth status --json": '{"loggedIn":true,"authMethod":"api_key"}',
      }),
      env: {},
    });
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/pas par un abonnement/);
  });
  it("accepts a claude.ai login, keeps no identity and flags an API key in the env", async () => {
    const status = await checkClaudeSubscribe({
      runner: runner({
        ...version,
        "auth status --json":
          '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","email":"x@example.com","orgId":"o"}',
      }),
      env: { ANTHROPIC_API_KEY: "dummy" },
    });
    expect(status).toMatchObject({
      available: true,
      subscriptionType: "pro",
      apiKeyInEnvironment: true,
    });
    expect(JSON.stringify(status)).not.toMatch(/example\.com|orgId/);
  });
});

it("exports a self-contained plan request and validates imported results", () => {
  const assisted = new AssistedProvider();
  const board = toStoryboard(
    {
      title: "t",
      scenes: [
        { text: "a", durationMs: 1000, enter: "fade", animationMs: 100 },
      ],
    },
    format,
  );
  const request = assisted.planRequest(board, [
    {
      id: "fdb_1",
      text: "Plus lent",
      timestampMs: 500,
      sceneId: null,
      frameIndex: 15,
      capturePath: "/x.png",
    },
  ]);
  expect(request).toMatchObject({ format: "veyra-ai-task/v1", kind: "plan" });
  expect(request.input.images).toEqual([
    { feedbackId: "fdb_1", file: "frames/fdb_1.png" },
  ]);
  expect(request.outputSchema).toHaveProperty("properties.changes");
  expect(() =>
    assisted.parseResult("plan", { summary: "x", changes: [] }),
  ).toThrow();
  expect(
    assisted.parseResult("plan", { summary: "x", changes: [], conflicts: [] })
      .summary,
  ).toBe("x");
});
