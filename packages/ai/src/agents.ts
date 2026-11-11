import {
  audioCompositionSchema,
  productionPlanSchema,
  type AudioComposition,
  type PermissionClass,
  type AudioTrack,
  type ProductionPlan,
  type Storyboard,
} from "@veyra/schemas";
import { visualTimeline } from "@veyra/motion";
import type { FeedbackInput } from "./index";

/**
 * Deterministic parts of Veyra's business agents. The Director plans phases; the
 * Audio Agent proposes a soundtrack from imported files; the Review Agent routes a
 * correction plan. None of them calls a model: the AI provider is only used by the
 * phases that need it (storyboard, correction plan, expertise).
 */

type Phase = ProductionPlan["phases"][number];
const phase = (
  name: Phase["phase"],
  agent: Phase["agent"],
  dependsOn: Phase["phase"][],
  maxAttempts = 1,
): Phase => ({ phase: name, agent, dependsOn, maxAttempts });

/** Director: phases of a new production. Motion and Audio both depend on the script only. */
export function planProduction(
  brief: { audio: { wanted: boolean; assetIds: string[] } },
  budget: { maxAiCalls: number; maxRenders: number },
): ProductionPlan {
  const audio = brief.audio.wanted && brief.audio.assetIds.length > 0;
  return productionPlanSchema.parse({
    phases: [
      phase("plan", "director", []),
      phase("script", "motion", ["plan"], 2),
      phase("motion", "motion", ["script"], 2),
      ...(audio ? [phase("audio", "audio", ["script"], 2)] : []),
      phase("composition", "engine", audio ? ["motion", "audio"] : ["motion"]),
      phase("render", "engine", ["composition"]),
      phase("qa", "qa-expert", ["render"]),
      phase("human-approval", "human", ["qa"]),
    ],
    budget,
    reason: audio
      ? "Production complète : storyboard, mouvement et bande son préparés en parallèle."
      : brief.audio.wanted
        ? "Son demandé mais aucun fichier audio valide importé : production sans bande son."
        : "Production sans bande son.",
  });
}

/** Director: only the phases a correction needs. Audio-only edits reuse the picture. */
export function planRevisionPhases(
  plan: {
    changes: { patch: Record<string, unknown> }[];
    audioChanges: unknown[];
  },
  budget: { maxAiCalls: number; maxRenders: number },
  sourceAudio?: AudioComposition | null,
) {
  const motion = plan.changes.some((c) => Object.keys(c.patch).length > 0);
  // shortcut: duck windows are absolute and do not follow shifted scenes; a human checks them.
  const warnings =
    plan.changes.some((c) => c.patch.durationMs !== undefined) &&
    sourceAudio?.tracks.some((t) => t.duck.length > 0)
      ? [
          "fenêtres d'atténuation en temps absolu : vérifier après décalage des scènes",
        ]
      : [];
  const audio = plan.audioChanges.length > 0;
  const agents = [
    "review" as const,
    ...(motion ? ["motion" as const] : []),
    ...(audio ? ["audio" as const] : []),
  ];
  const edits = [
    ...(motion ? [phase("motion", "motion", [])] : []),
    ...(audio ? [phase("audio", "audio", [])] : []),
  ];
  const result = productionPlanSchema.parse({
    phases: [
      ...edits,
      phase(
        "composition",
        "engine",
        edits.map((p) => p.phase),
      ),
      phase("render", "engine", ["composition"]),
      phase("qa", "qa-expert", ["render"]),
      phase("human-approval", "human", ["qa"]),
    ],
    budget,
    reason: motion
      ? audio
        ? "Correction image et son : nouveau rendu HyperFrames puis mixage."
        : "Correction de l'image : nouveau rendu HyperFrames ; la bande son suit les scènes."
      : audio
        ? "Correction du son seul : image réutilisée, nouveau mixage."
        : "Aucune modification exprimable : la révision reprend la précédente.",
  });
  return {
    plan: result,
    affectedAgents: agents,
    affectedPhases: result.phases.map((p) => p.phase),
    warnings,
  };
}

/**
 * Director: a natural-language edit of a revision (T129b-2). The plan phase is the tool
 * loop (model decisions); render, QA and human approval stay fixed orchestrator steps.
 */
export function planDirectorRevision(budget: {
  maxAiCalls: number;
  maxRenders: number;
}): ProductionPlan {
  return productionPlanSchema.parse({
    phases: [
      phase("plan", "director", []),
      phase("render", "engine", ["plan"]),
      phase("qa", "qa-expert", ["render"]),
      phase("human-approval", "human", ["qa"]),
    ],
    budget,
    reason:
      "Montage par le Director : outils locaux (lecture, calcul local, révision brouillon) ; action payante ou réseau soumise à votre autorisation ; code généré jamais exécuté ; rendu, QA et validation humaine fixes.",
  });
}

/**
 * Classes granted to the Director's tool loop, derived from its validated plan: local
 * reads and computations always; draft-revision writes only when the plan renders and
 * waits for a human approval. Billable, network and generated code are never granted
 * here: the loop pauses for a human decision on each such call (or refuses it).
 */
export function directorGrants(plan: ProductionPlan): PermissionClass[] {
  const has = (p: Phase["phase"]) => plan.phases.some((x) => x.phase === p);
  return [
    "read-only",
    "local-compute",
    ...(has("render") && has("human-approval")
      ? (["writes-revision-artefacts"] as const)
      : []),
  ];
}

const audioWords =
  /musique|music|\bson\b|sonore|voix|volume|bruit|effet sonore|sfx|bruitage/i;
/** Review Agent: a comment targets the soundtrack when it names a track, a range or sound. */
export function isAudioFeedback(item: FeedbackInput) {
  return Boolean(item.audioTrackId) || audioWords.test(item.text);
}

/** "entre 00:08 et 00:12" → [8000, 12000]; mm:ss with optional tenths. */
function rangeInText(text: string): [number, number] | null {
  const times = [...text.matchAll(/(\d{1,2}):(\d{2})(?:[.,](\d))?/g)].map(
    (m) => (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3] ?? 0) * 100,
  );
  return times.length >= 2 ? [times[0], times[1]] : null;
}

/** Fake provider's rule-based audio planner (simulated, labelled as such by the caller). */
export function simulateAudioChange(
  item: FeedbackInput,
  audio: AudioComposition | null,
) {
  const tracks = audio?.tracks ?? [];
  const text = item.text.toLowerCase();
  const byCategory = (c: AudioTrack["category"]) =>
    tracks.find((t) => t.category === c);
  const target =
    tracks.find((t) => t.id === item.audioTrackId) ??
    (/musique|music/.test(text)
      ? byCategory("music")
      : /voix/.test(text)
        ? byCategory("voiceover")
        : /effet|bruit|sfx/.test(text)
          ? byCategory("sfx")
          : byCategory("music"));
  if (!target) return null;
  const range =
    item.rangeEndMs != null && item.rangeEndMs > item.timestampMs
      ? ([item.timestampMs, item.rangeEndMs] as [number, number])
      : rangeInText(item.text);
  if (/diminue|baisse|moins fort|réduis|atténue|plus bas/.test(text)) {
    if (range)
      return {
        trackId: target.id,
        feedbackId: item.id,
        patch: {
          duck: [
            ...target.duck,
            { startMs: range[0], endMs: range[1], gainDb: -12 },
          ],
        },
        instruction: `Atténuer « ${target.label} » de 12 dB entre ${range[0] / 1000} s et ${range[1] / 1000} s`,
      };
    const gainDb = Math.max(-60, target.gainDb - 6);
    return {
      trackId: target.id,
      feedbackId: item.id,
      patch: { gainDb },
      instruction: `Baisser « ${target.label} » (${target.gainDb} → ${gainDb} dB)`,
    };
  }
  if (/augmente|monte|plus fort|renforce/.test(text)) {
    const gainDb = Math.min(12, target.gainDb + 6);
    return {
      trackId: target.id,
      feedbackId: item.id,
      patch: { gainDb },
      instruction: `Monter « ${target.label} » (${target.gainDb} → ${gainDb} dB)`,
    };
  }
  return null;
}

/** Visual events an effect sound may punctuate, in order of preference. */
const cueEvents = [
  "card-appear",
  "button-appear",
  "metric-count",
  "headline-appear",
];

/**
 * Audio Agent (rules): music bed looped under the whole video, voice-over at the
 * start of the first scene with the music ducked under it, and one effect per
 * punctuating visual event. Works only with files the user imported.
 */
export function proposeAudio(
  storyboard: Storyboard,
  assets: {
    id: string;
    category: AudioTrack["category"] | null;
    durationMs: number;
    label: string;
  }[],
) {
  const warnings: string[] = [];
  const events = visualTimeline(storyboard, {
    num: Math.round(storyboard.fps),
    den: 1,
  });
  const end = Math.max(
    0,
    ...storyboard.scenes.map((s) => s.start + s.duration),
  );
  const first = storyboard.scenes[0];
  const tracks: AudioTrack[] = [];
  const voice = assets.find((a) => a.category === "voiceover");
  const voiceStart = 300;
  const voiceSpan: [number, number] | null = voice
    ? [voiceStart, Math.min(end, voiceStart + voice.durationMs)]
    : null;
  for (const music of assets.filter((a) => a.category === "music"))
    tracks.push({
      id: `atr_music-${music.id.slice(4, 12)}`,
      assetId: music.id,
      category: "music",
      label: music.label,
      anchor: { type: "absolute", atMs: 0 },
      sourceInMs: 0,
      gainDb: -18,
      fadeInMs: 1000,
      fadeOutMs: 1500,
      loop: true,
      duck: voiceSpan
        ? [{ startMs: voiceSpan[0], endMs: voiceSpan[1], gainDb: -10 }]
        : [],
    });
  if (voice && first)
    tracks.push({
      id: `atr_voice-${voice.id.slice(4, 12)}`,
      assetId: voice.id,
      category: "voiceover",
      label: voice.label,
      anchor: {
        type: "event",
        sceneId: first.id,
        event: "scene",
        index: 0,
        edge: "start",
        offsetMs: voiceStart,
      },
      sourceInMs: 0,
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 300,
      loop: false,
      duck: [],
    });
  const sfx = assets.filter((a) => a.category === "sfx");
  if (sfx.length) {
    const visual = events.filter(
      (e) => e.kind === "visual" && cueEvents.includes(e.name),
    );
    if (!visual.length)
      warnings.push(
        "Aucun événement visuel à ponctuer : effets sonores non placés.",
      );
    visual.slice(0, 12).forEach((event, i) => {
      const asset = sfx[i % sfx.length];
      tracks.push({
        id: `atr_sfx-${i}-${asset.id.slice(4, 10)}`,
        assetId: asset.id,
        category: "sfx",
        label: `${asset.label} · ${event.name} ${event.index + 1}`,
        anchor: {
          type: "event",
          sceneId: event.sceneId!,
          event: event.name,
          index: event.index,
          edge: "start",
          offsetMs: 0,
        },
        sourceInMs: 0,
        gainDb: -3,
        fadeInMs: 0,
        fadeOutMs: 0,
        loop: false,
        duck: [],
      });
    });
  }
  for (const a of assets.filter((a) => !a.category))
    warnings.push(`« ${a.label} » sans catégorie : non utilisé.`);
  return {
    composition: audioCompositionSchema.parse({ schemaVersion: 1, tracks }),
    warnings,
  };
}
