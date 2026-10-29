import { describe, expect, it } from "vitest";
import {
  applyProposal,
  FakeAiProvider,
  instructions,
  toStoryboard,
  storyboardDraftSchema,
} from "./index";

const format = { width: 1920, height: 1080, fps: 30 };
const saas =
  "Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.";

describe("composition with motion components", () => {
  it("lets the simulator compose a SaaS video from the five registered components", async () => {
    const draft = await new FakeAiProvider().generateStoryboard(saas, {
      targetDurationMs: 20000,
      styleInstructions: "",
    });
    const board = toStoryboard(draft, format);
    expect(board.scenes.map((s) => s.component?.id)).toEqual([
      "animated-title",
      "feature-cards",
      "product-mockup",
      "metrics-counter",
      "call-to-action",
    ]);
    expect(board.scenes.map((s) => s.duration)).toEqual([
      4000, 5000, 4000, 4000, 3000,
    ]);
    expect(board.scenes[0].component).toMatchObject({
      version: 1,
      params: { kicker: "Pilot" },
    });
    expect(board.scenes[0].text).toBe(board.scenes[0].component!.params.title);
    expect(board.scenes[0].text).toBe(
      "Une application SaaS de gestion pour petites équipes",
    );
  });
  it("keeps plain text scenes for other prompts", async () => {
    const draft = await new FakeAiProvider().generateStoryboard(
      "Crée une vidéo de 20 secondes présentant un service de création de sites web et d'infogérance pour petites entreprises.",
      { targetDurationMs: 20000, styleInstructions: "" },
    );
    expect(toStoryboard(draft, format).scenes.every((s) => !s.component)).toBe(
      true,
    );
  });
  it("validates components, parameters and durations from any model output", () => {
    const scene = {
      durationMs: 3000,
      enter: "fade" as const,
      animationMs: 800,
    };
    const ok = {
      title: "t",
      scenes: [
        {
          ...scene,
          component: {
            id: "call-to-action",
            params: { headline: "Go", buttonLabel: "Essai" },
          },
        },
      ],
    };
    expect(toStoryboard(ok as never, format).scenes[0].text).toBe("Go");
    expect(() =>
      storyboardDraftSchema.parse({
        title: "t",
        scenes: [{ ...scene, component: { id: "html-embed", params: {} } }],
      }),
    ).toThrow();
    expect(() =>
      storyboardDraftSchema.parse({ title: "t", scenes: [scene] }),
    ).toThrow(/texte ou un composant/);
    const tooLong = {
      title: "t",
      scenes: [
        { ...scene, durationMs: 9000, component: ok.scenes[0].component },
      ],
    };
    expect(() => toStoryboard(tooLong as never, format)).toThrow(/hors de/);
  });
  it("applies natural-language corrections to the targeted component and keeps the others", async () => {
    const ai = new FakeAiProvider();
    const board = toStoryboard(
      await ai.generateStoryboard(saas, {
        targetDurationMs: 20000,
        styleInstructions: "",
      }),
      format,
    );
    const cta = board.scenes[4];
    const title = board.scenes[0];
    const plan = await ai.planRevision(board, [
      {
        id: "fdb_1",
        text: "Change le bouton en « Démarrer maintenant »",
        timestampMs: cta.start + 1000,
        sceneId: cta.id,
      },
      {
        id: "fdb_2",
        text: "Remplace le titre par « Gérez tout, simplement »",
        timestampMs: 1000,
        sceneId: title.id,
      },
    ]);
    expect(plan.changes[0].patch).toEqual({
      params: { buttonLabel: "Démarrer maintenant" },
    });
    const revised = applyProposal(board, plan.changes, 60000);
    expect(revised.scenes[4].component!.params).toMatchObject({
      buttonLabel: "Démarrer maintenant",
      headline: cta.component!.params.headline,
    });
    expect(revised.scenes[0]).toMatchObject({
      text: "Gérez tout, simplement",
      component: { params: { title: "Gérez tout, simplement" } },
    });
    // Untouched components and the source storyboard are preserved.
    expect(revised.scenes.slice(1, 4)).toEqual(board.scenes.slice(1, 4));
    expect(board.scenes[4].component!.params.buttonLabel).toBe(
      "Essai gratuit 14 jours",
    );
  });
  it("rejects parameter patches that break the component schema or target text scenes", async () => {
    const ai = new FakeAiProvider();
    const board = toStoryboard(
      await ai.generateStoryboard(saas, {
        targetDurationMs: 20000,
        styleInstructions: "",
      }),
      format,
    );
    expect(() =>
      applyProposal(
        board,
        [{ sceneId: board.scenes[1].id, patch: { params: { cards: [] } } }],
        60000,
      ),
    ).toThrow();
    const text = toStoryboard(
      {
        title: "t",
        scenes: [
          { text: "x", durationMs: 2000, enter: "fade", animationMs: 500 },
        ],
      },
      format,
    );
    expect(() =>
      applyProposal(
        text,
        [{ sceneId: text.scenes[0].id, patch: { params: { a: 1 } } }],
        60000,
      ),
    ).toThrow(/pas de composant/);
    expect(() =>
      applyProposal(
        board,
        [{ sceneId: board.scenes[4].id, patch: { durationMs: 9000 } }],
        60000,
      ),
    ).toThrow(/hors de/);
  });
  it("describes the registry to models without allowing code", () => {
    const prompt = instructions.storyboard({
      targetDurationMs: 20000,
      styleInstructions: "",
    });
    for (const id of [
      "animated-title",
      "feature-cards",
      "product-mockup",
      "metrics-counter",
      "call-to-action",
    ])
      expect(prompt).toContain(id);
    expect(prompt).toMatch(/aucun code, aucun HTML/);
  });
});
