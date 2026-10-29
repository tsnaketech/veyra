import { describe, expect, it } from "vitest";
import {
  FakeAiProvider,
  isAudioFeedback,
  planProduction,
  planRevisionPhases,
  proposeAudio,
  simulateAudioChange,
  toStoryboard,
} from "./index";

const budget = { maxAiCalls: 4, maxRenders: 3 };
const format = { width: 1920, height: 1080, fps: 30 };
const saas =
  "Crée une vidéo de 20 secondes présentant « Pilot », une application SaaS de gestion pour petites équipes.";
const board = async () =>
  toStoryboard(
    await new FakeAiProvider().generateStoryboard(saas, {
      targetDurationMs: 20000,
      styleInstructions: "",
    }),
    format,
  );
const assets = [
  {
    id: "ast_music-1",
    category: "music" as const,
    durationMs: 8000,
    label: "Musique",
  },
  {
    id: "ast_voice-1",
    category: "voiceover" as const,
    durationMs: 4000,
    label: "Voix",
  },
  { id: "ast_pop-1", category: "sfx" as const, durationMs: 80, label: "Pop" },
];

describe("Director", () => {
  it("plans Motion and Audio in parallel after the script when audio files exist", () => {
    const plan = planProduction(
      { audio: { wanted: true, assetIds: ["ast_1"] } },
      budget,
    );
    const of = (name: string) => plan.phases.find((p) => p.phase === name)!;
    expect(plan.phases.map((p) => p.phase)).toEqual([
      "plan",
      "script",
      "motion",
      "audio",
      "composition",
      "render",
      "qa",
      "human-approval",
    ]);
    expect(of("motion").dependsOn).toEqual(["script"]);
    expect(of("audio").dependsOn).toEqual(["script"]);
    expect(of("composition").dependsOn).toEqual(["motion", "audio"]);
    expect(of("render").agent).toBe("engine");
    expect(of("human-approval").agent).toBe("human");
  });
  it("drops the audio phase without files and says why", () => {
    const plan = planProduction(
      { audio: { wanted: true, assetIds: [] } },
      budget,
    );
    expect(plan.phases.some((p) => p.phase === "audio")).toBe(false);
    expect(plan.reason).toMatch(/aucun fichier audio/);
  });
  it("selects only the phases a correction needs", () => {
    const audioOnly = planRevisionPhases(
      { changes: [{ patch: {} }], audioChanges: [{}] },
      budget,
    );
    expect(audioOnly.affectedAgents).toEqual(["review", "audio"]);
    expect(audioOnly.affectedPhases).toEqual([
      "audio",
      "composition",
      "render",
      "qa",
      "human-approval",
    ]);
    expect(audioOnly.plan.reason).toMatch(/image réutilisée/);
    const motion = planRevisionPhases(
      { changes: [{ patch: { text: "x" } }], audioChanges: [] },
      budget,
    );
    expect(motion.affectedAgents).toEqual(["review", "motion"]);
    expect(motion.affectedPhases[0]).toBe("motion");
    const both = planRevisionPhases(
      { changes: [{ patch: { durationMs: 5000 } }], audioChanges: [{}] },
      budget,
    );
    expect(both.affectedAgents).toEqual(["review", "motion", "audio"]);
  });
});

describe("Review Agent (audio comments)", () => {
  const music = {
    id: "atr_music",
    assetId: "ast_music-1",
    category: "music" as const,
    label: "Musique",
    anchor: { type: "absolute" as const, atMs: 0 },
    sourceInMs: 0,
    gainDb: -18,
    fadeInMs: 0,
    fadeOutMs: 0,
    loop: true,
    duck: [],
  };
  const audio = {
    schemaVersion: 1 as const,
    tracks: [music],
    master: { targetLufs: -16, truePeakDb: -1 },
  };
  const comment = (text: string, extra = {}) => ({
    id: "fdb_1",
    text,
    timestampMs: 8000,
    sceneId: null,
    ...extra,
  });
  it("recognises sound comments", () => {
    expect(isAudioFeedback(comment("Diminue la musique"))).toBe(true);
    expect(isAudioFeedback(comment("Ralentis le titre"))).toBe(false);
    expect(isAudioFeedback(comment("x", { audioTrackId: "atr_music" }))).toBe(
      true,
    );
  });
  it("turns 'entre 00:08 et 00:12, diminue la musique' into a duck on that range", () => {
    const change = simulateAudioChange(
      comment(
        "Entre 00:08 et 00:12, diminue la musique pour mieux entendre la voix off.",
      ),
      audio,
    );
    expect(change).toMatchObject({
      trackId: "atr_music",
      patch: { duck: [{ startMs: 8000, endMs: 12000, gainDb: -12 }] },
    });
    const ranged = simulateAudioChange(
      comment("Baisse le son", {
        rangeEndMs: 10000,
        audioTrackId: "atr_music",
      }),
      audio,
    );
    expect(ranged?.patch).toEqual({
      duck: [{ startMs: 8000, endMs: 10000, gainDb: -12 }],
    });
    expect(
      simulateAudioChange(comment("Monte la musique"), audio)?.patch,
    ).toEqual({ gainDb: -12 });
    expect(
      simulateAudioChange(comment("Musique trop jazzy"), audio),
    ).toBeNull();
  });
  it("routes audio comments to audioChanges, not to scene patches", async () => {
    const plan = await new FakeAiProvider().planRevision(
      await board(),
      [comment("Entre 00:08 et 00:12, diminue la musique")],
      audio,
    );
    expect(plan.changes).toEqual([]);
    expect(plan.audioChanges).toHaveLength(1);
  });
});

describe("Audio Agent", () => {
  it("places music, voice-over and one effect per punctuating visual event", async () => {
    const storyboard = await board();
    const { composition, warnings } = proposeAudio(storyboard, assets);
    expect(warnings).toEqual([]);
    const music = composition.tracks.find((t) => t.category === "music")!;
    expect(music).toMatchObject({
      loop: true,
      gainDb: -18,
      duck: [{ startMs: 300, endMs: 4300, gainDb: -10 }],
    });
    expect(
      composition.tracks.find((t) => t.category === "voiceover")!.anchor,
    ).toMatchObject({
      type: "event",
      sceneId: storyboard.scenes[0].id,
      event: "scene",
      offsetMs: 300,
    });
    const cards = storyboard.scenes.find(
      (s) => s.component?.id === "feature-cards",
    )!;
    const pops = composition.tracks.filter((t) => t.category === "sfx");
    expect(
      pops.filter(
        (t) => t.anchor.type === "event" && t.anchor.sceneId === cards.id,
      ),
    ).toHaveLength(3);
    expect(new Set(composition.tracks.map((t) => t.id)).size).toBe(
      composition.tracks.length,
    );
  });
  it("warns about files without category instead of guessing", async () => {
    const { composition, warnings } = proposeAudio(await board(), [
      { id: "ast_x", category: null, durationMs: 1000, label: "inconnu" },
    ]);
    expect(composition.tracks).toEqual([]);
    expect(warnings[0]).toMatch(/sans catégorie/);
  });
});
