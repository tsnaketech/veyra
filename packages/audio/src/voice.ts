import { resolve } from "node:path";
import {
  audioCompositionSchema,
  newId,
  sceneFallbackWords,
  voiceResultSchema,
  type AudioComposition,
  type Scene,
  type VoiceResult,
} from "@veyra/schemas";
import { fixed } from "./mixing";
import { runAudioProcess } from "./validation";
import type { AudioLimits, AudioMetadata } from "./schemas";

export type VoiceProviderKind = VoiceResult["provider"];
export interface VoiceAvailability {
  ok: boolean;
  reason?: string;
  installHint?: string;
}
/** A synthesis result before the Studio stores the file as an asset. */
export type VoiceSynthesis = Omit<VoiceResult, "assetId">;
export interface VoiceProvider {
  kind: VoiceProviderKind;
  available(): VoiceAvailability;
  /** Absent for "import": an imported voice is validated, never synthesized. */
  synthesize?(
    narration: { sceneId: string; text: string },
    outPath: string,
    limits?: AudioLimits,
  ): Promise<VoiceSynthesis>;
}

/** Rough French speech rate for a simulated voice (≈ 14 characters per second). */
export const estimateSpeechMs = (text: string) =>
  Math.max(500, Math.round([...text.trim()].length * 70));

const importProvider: VoiceProvider = {
  kind: "import",
  available: () => ({ ok: true }),
};
const fakeProvider: VoiceProvider = {
  kind: "fake",
  available: () => ({ ok: true }),
  async synthesize({ sceneId, text }, outPath, limits = {}) {
    const durationMs = estimateSpeechMs(text);
    // Deterministic tone; never a voice, so it can only ever be presented as simulated.
    await runAudioProcess(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=330:sample_rate=48000:duration=${fixed(durationMs / 1000)}`,
        "-ac",
        "2",
        "-c:a",
        "pcm_s16le",
        resolve(outPath),
      ],
      limits,
    );
    const words = sceneFallbackWords([
      { id: sceneId, start: 0, duration: durationMs, narration: { text } },
    ]);
    return {
      sceneId,
      durationMs,
      provider: "fake",
      // Times relative to the start of the voice file, spread over it ("scene").
      words,
      simulated: true,
      provenance: {
        provider: "fake",
        engine: "ffmpeg-lavfi",
        model: null,
        version: null,
        sha256: null,
      },
    };
  },
};
const localTtsProvider: VoiceProvider = {
  kind: "local-tts",
  // shortcut: stub until T116/T117 install and wrap Piper; then probe the installed engine.
  available: () => ({
    ok: false,
    reason: "Moteur non installé",
    installHint:
      "Aucun moteur de synthèse locale n'est encore installable : l'installation explicite arrive avec T116.",
  }),
  async synthesize() {
    throw new Error(
      "Synthèse locale indisponible : moteur non installé (installation explicite prévue avec T116). Aucune voix simulée n'est utilisée à sa place.",
    );
  },
};
const providers: Record<VoiceProviderKind, VoiceProvider> = {
  import: importProvider,
  fake: fakeProvider,
  "local-tts": localTtsProvider,
};
/** Explicit selection: an unavailable provider is reported, never replaced by another. */
export function voiceProvider(kind: VoiceProviderKind): VoiceProvider {
  const provider = providers[kind];
  if (!provider) throw new Error(`Fournisseur de voix inconnu : ${kind}`);
  return provider;
}

/** An imported voice is validated by probeAudio (Studio.importAudio); it carries no word times. */
export const importedVoiceResult = (
  sceneId: string,
  assetId: string,
  metadata: Pick<AudioMetadata, "durationMs">,
) =>
  voiceResultSchema.parse({
    sceneId,
    assetId,
    durationMs: metadata.durationMs,
    provider: "import",
    words: [],
    simulated: false,
    provenance: { provider: "import" },
  });

const DUCK_DB = -10; // same music attenuation as the Audio Agent under a voice-over

/**
 * Places a scene voice as a voiceover track anchored on the scene's start event,
 * replacing that scene's previous voiceover; music is ducked under it with absolute
 * windows (Audio Engine semantics). A voice longer than its scene is not cut and the
 * storyboard is not changed: a warning says so (the Audio Engine only truncates at
 * the video end, which it does not report as an issue).
 */
export function placeSceneVoice(
  composition: AudioComposition | null,
  scene: Pick<Scene, "id" | "start" | "duration">,
  voice: { assetId: string; durationMs: number; label: string },
  videoEndMs: number,
): { composition: AudioComposition; warnings: string[] } {
  const ofScene = (t: AudioComposition["tracks"][number]) =>
    t.category === "voiceover" &&
    t.anchor.type === "event" &&
    t.anchor.sceneId === scene.id;
  const end = scene.start + voice.durationMs;
  const tracks = (composition?.tracks ?? [])
    .filter((t) => !ofScene(t))
    .map((t) =>
      t.category === "music"
        ? {
            ...t,
            // shortcut: a window starting at the scene start is taken as that scene's voice duck.
            duck: [
              ...t.duck.filter((d) => d.startMs !== scene.start),
              {
                startMs: scene.start,
                endMs: Math.min(end, videoEndMs),
                gainDb: DUCK_DB,
              },
            ].sort((a, b) => a.startMs - b.startMs),
          }
        : t,
    );
  tracks.push({
    id: newId("atr"),
    assetId: voice.assetId,
    category: "voiceover",
    label: voice.label,
    anchor: {
      type: "event",
      sceneId: scene.id,
      event: "scene",
      index: 0,
      edge: "start",
      offsetMs: 0,
    },
    sourceInMs: 0,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    loop: false,
    duck: [],
  });
  const warnings: string[] = [];
  const over = voice.durationMs - scene.duration;
  if (over > 0)
    warnings.push(
      `La voix (${(voice.durationMs / 1000).toFixed(1)} s) dépasse la scène de ${(over / 1000).toFixed(1)} s : ${
        end > videoEndMs
          ? "elle sera coupée à la fin de la vidéo"
          : "elle déborde sur la scène suivante"
      }. Le storyboard n'est pas modifié ; allonger la scène est une action séparée.`,
    );
  return {
    composition: audioCompositionSchema.parse({
      schemaVersion: 1,
      master: composition?.master,
      tracks,
    }),
    warnings,
  };
}
