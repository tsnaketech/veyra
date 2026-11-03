import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { voiceResultSchema, type AudioComposition } from "@veyra/schemas";
import { probeAudio } from "./validation";
import { resolveAudioComposition } from "./timeline";
import {
  estimateSpeechMs,
  importedVoiceResult,
  placeSceneVoice,
  voiceProvider,
} from "./voice";

describe("voice providers", () => {
  it("selects providers explicitly; local-tts is unavailable and never falls back", async () => {
    expect(voiceProvider("import").available()).toEqual({ ok: true });
    expect(voiceProvider("import").synthesize).toBeUndefined();
    expect(voiceProvider("fake").available().ok).toBe(true);
    const tts = voiceProvider("local-tts");
    expect(tts.available()).toEqual({
      ok: false,
      reason: "Moteur non installé",
      installHint: expect.stringMatching(/pnpm voice:install piper.*T116/),
    });
    await expect(
      tts.synthesize!({ sceneId: "scn_a", text: "Bonjour" }, "/dev/null"),
    ).rejects.toThrow(/moteur non installé.*Aucune voix simulée/);
    expect(() => voiceProvider("x" as never)).toThrow(/inconnu/);
  });

  it("fake synthesizes a real, simulated WAV with scene timings only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "veyra-voice-"));
    try {
      const out = join(dir, "v.wav");
      const text = "Pilot simplifie la gestion des équipes.";
      const result = await voiceProvider("fake").synthesize!(
        { sceneId: "scn_a", text },
        out,
      );
      expect(result).toMatchObject({ simulated: true, provider: "fake" });
      expect(result.durationMs).toBe(estimateSpeechMs(text));
      expect(result.words.map((w) => w.timing)).toEqual(Array(6).fill("scene"));
      expect(result.words.at(-1)!.endMs).toBe(result.durationMs);
      // The contract accepts it once stored as an asset.
      voiceResultSchema.parse({ ...result, assetId: "ast_x" });
      const metadata = await probeAudio(out);
      expect(Math.abs(metadata.durationMs - result.durationMs)).toBeLessThan(
        30,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an imported voice has no word times", () => {
    expect(
      importedVoiceResult("scn_a", "ast_v", { durationMs: 1234 }),
    ).toMatchObject({ provider: "import", words: [], simulated: false });
  });
});

describe("placeSceneVoice", () => {
  const scenes = [
    { id: "scn_a", start: 0, duration: 4000 },
    { id: "scn_b", start: 4000, duration: 3000 },
  ];
  const music: AudioComposition = {
    schemaVersion: 1,
    master: { targetLufs: -16, truePeakDb: -1 },
    tracks: [
      {
        id: "atr_music",
        assetId: "ast_m",
        category: "music",
        label: "m",
        anchor: { type: "absolute", atMs: 0 },
        sourceInMs: 0,
        gainDb: -18,
        fadeInMs: 0,
        fadeOutMs: 0,
        loop: true,
        duck: [{ startMs: 100, endMs: 900, gainDb: -6 }],
      },
    ],
  };

  it("anchors on the scene start event and replaces that scene's previous voice", () => {
    const first = placeSceneVoice(
      music,
      scenes[1],
      { assetId: "ast_v1", durationMs: 2000, label: "v1" },
      7000,
    );
    expect(first.warnings).toEqual([]);
    const voice = first.composition.tracks.find(
      (t) => t.category === "voiceover",
    )!;
    expect(voice.anchor).toEqual({
      type: "event",
      sceneId: "scn_b",
      event: "scene",
      index: 0,
      edge: "start",
      offsetMs: 0,
    });
    expect(first.composition.tracks[0].duck).toEqual([
      { startMs: 100, endMs: 900, gainDb: -6 },
      { startMs: 4000, endMs: 6000, gainDb: -10 },
    ]);
    const other = placeSceneVoice(
      first.composition,
      scenes[0],
      { assetId: "ast_va", durationMs: 1000, label: "va" },
      7000,
    );
    const second = placeSceneVoice(
      other.composition,
      scenes[1],
      { assetId: "ast_v2", durationMs: 1500, label: "v2" },
      7000,
    );
    const voices = second.composition.tracks.filter(
      (t) => t.category === "voiceover",
    );
    expect(voices.map((t) => t.assetId)).toEqual(["ast_va", "ast_v2"]);
    expect(second.composition.tracks[0].duck.at(-1)).toEqual({
      startMs: 4000,
      endMs: 5500,
      gainDb: -10,
    });
    // The Audio Engine resolves it at the scene start of the visual timeline.
    const events = scenes.map((s) => ({
      id: `${s.id}:scene:0`,
      kind: "scene" as const,
      sceneId: s.id,
      name: "scene",
      index: 0,
      startMs: s.start,
      endMs: s.start + s.duration,
      startFrame: 0,
      endFrame: 0,
      source: "motion" as const,
    }));
    const meta = { format: "wav", codec: "pcm_s16le", sampleRate: 48000 };
    const assets = new Map(
      ["ast_m", "ast_va", "ast_v2"].map((id) => [
        id,
        {
          path: `/x/${id}.wav`,
          metadata: { ...meta, channels: 2, durationMs: 1500, sizeBytes: 1 },
        },
      ]),
    );
    const resolved = resolveAudioComposition(
      second.composition,
      events,
      assets,
      7000,
    );
    expect(resolved.issues).toEqual([]);
    expect(
      resolved.tracks.find((t) => t.category === "voiceover" && t.startMs > 0),
    ).toMatchObject({ startMs: 4000, playMs: 1500 });
  });

  it("warns when the voice is longer than the scene, without changing anything else", () => {
    const inside = placeSceneVoice(
      null,
      scenes[0],
      { assetId: "ast_v", durationMs: 5200, label: "v" },
      7000,
    );
    expect(inside.warnings[0]).toMatch(
      /dépasse la scène de 1\.2 s : elle déborde sur la scène suivante.*action séparée/,
    );
    expect(inside.composition.tracks[0].durationMs).toBeUndefined();
    const last = placeSceneVoice(
      null,
      scenes[1],
      { assetId: "ast_v", durationMs: 4000, label: "v" },
      7000,
    );
    expect(last.warnings[0]).toMatch(/coupée à la fin de la vidéo/);
  });
});
