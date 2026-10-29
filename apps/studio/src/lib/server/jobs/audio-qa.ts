import { analyzeAudio, detectOnsets, type ResolvedTrack } from '@veyra/audio';
import { newId, type AudioComposition, type QualityCheck } from '@veyra/schemas';
import type { RenderSettings } from './runner';

const check = (
  name: string,
  passed: boolean,
  severity: QualityCheck['severity'],
  evidence: string
): QualityCheck => ({
  id: newId('qck'),
  name,
  passed,
  severity: passed ? 'info' : severity,
  timestamp: 0,
  evidence,
  recommendation: passed ? 'Aucune action' : 'Vérifier la bande son avant validation',
  analysisMode: 'deterministic'
});
const notDone = (name: string, evidence: string): QualityCheck => ({
  ...check(name, false, 'info', evidence),
  analysisMode: 'not-performed'
});

/** Measurements of the final mux, never a qualitative listening assessment. */
export async function audioQualityChecks(
  path: string,
  videoDurationMs: number,
  composition: AudioComposition,
  tracks: ResolvedTrack[],
  settings: RenderSettings['audio']
): Promise<QualityCheck[]> {
  if (!composition.tracks.length) return [];
  const checks = [
    notDone(
      'Écoute qualitative',
      'Mesures techniques uniquement : aucune écoute réelle de la bande son, validation humaine requise.'
    )
  ];
  const qa = settings.qa;
  // Same CPU and wall-clock bounds as the mix; formats stay at defaults since the mux is MP4.
  const limits = { cpuSeconds: settings.cpuSeconds, timeoutMs: settings.timeoutMs };
  let measured;
  try {
    measured = await analyzeAudio(
      path,
      {
        noiseDb: qa.silenceNoiseDb,
        minSilenceMs: qa.silenceMinMs
      },
      limits
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Mesure indisponible';
    checks.push(check('Flux audio', false, 'major', reason));
    for (const name of [
      'Durée audio',
      'Silences inattendus',
      'Écrêtage',
      'Niveau sonore',
      'Synchronisation audio — onsets'
    ])
      checks.push(notDone(name, `Mesure non réalisée : ${reason}`));
    return checks;
  }
  checks.push(
    check(
      'Flux audio',
      measured.codec === 'aac' &&
        measured.sampleRate === settings.mix.sampleRate &&
        measured.channels === settings.mix.channels,
      'major',
      `Mesuré : ${measured.codec}, ${measured.sampleRate} Hz, ${measured.channels} canaux ; attendu : aac, ${settings.mix.sampleRate} Hz, ${settings.mix.channels} canaux.`
    )
  );
  const delta = Math.abs(measured.durationMs - videoDurationMs);
  checks.push(
    check(
      'Durée audio',
      delta <= qa.durationToleranceMs,
      'major',
      `Mesuré : audio ${measured.durationMs} ms, vidéo ${videoDurationMs} ms ; écart ${delta.toFixed(1)} ms, tolérance ${qa.durationToleranceMs} ms.`
    )
  );
  // Merge expected spans so adjacent tracks cannot hide a continuous silence.
  const spans: { start: number; end: number }[] = [];
  for (const track of [...tracks].sort((a, b) => a.startMs - b.startMs)) {
    const end = Math.min(videoDurationMs, track.startMs + track.playMs);
    const last = spans.at(-1);
    if (last && track.startMs <= last.end) last.end = Math.max(last.end, end);
    else spans.push({ start: track.startMs, end });
  }
  const unexpected = measured.silences
    .flatMap((s) =>
      spans.map((span) => ({
        start: Math.max(s.startMs, span.start),
        end: Math.min(s.endMs, span.end)
      }))
    )
    .filter((s) => s.end - s.start >= qa.silenceMinMs);
  checks.push(
    check(
      'Silences inattendus',
      !unexpected.length,
      'minor',
      `Mesuré : ${unexpected.length} silence(s) dans les plages attendues, seuil ${qa.silenceNoiseDb} dB / ${qa.silenceMinMs} ms ; ${JSON.stringify(unexpected)}.`
    )
  );
  checks.push(
    check(
      'Écrêtage',
      Math.max(measured.truePeakDb, measured.peakDb) <= qa.clippingPeakDb,
      'major',
      `Mesuré : crête vraie ${measured.truePeakDb} dBFS, crête ${measured.peakDb} dBFS, échantillons écrêtés estimés ${measured.clippedSamples} ; limite ${qa.clippingPeakDb} dBFS.`
    )
  );
  const target = composition.master.targetLufs;
  checks.push(
    check(
      'Niveau sonore',
      Math.abs(measured.integratedLufs - target) <= qa.loudnessToleranceLu,
      'minor',
      `Mesuré : ${measured.integratedLufs} LUFS ; cible ${target} LUFS ± ${qa.loudnessToleranceLu} LU.`
    )
  );
  const cues = tracks.filter((t) =>
    composition.tracks.some(
      (c) => c.id === t.trackId && c.category === 'sfx' && c.anchor.type === 'event'
    )
  );
  if (cues.length) {
    const isolated = cues.filter(
      (t) =>
        !tracks.some(
          (other) =>
            other.trackId !== t.trackId &&
            other.startMs <= t.startMs + qa.syncToleranceMs &&
            other.startMs + other.playMs >= t.startMs - qa.syncToleranceMs
        )
    );
    if (isolated.length !== cues.length)
      checks.push(
        notDone(
          'Synchronisation audio — onsets masqués',
          `${cues.length - isolated.length} départ(s) non isolables : pistes superposées. Aucune synchronisation acoustique déduite de ce mélange.`
        )
      );
    if (isolated.length) {
      try {
        const onsets = await detectOnsets(
          path,
          {
            noiseDb: qa.silenceNoiseDb,
            minSilenceMs: Math.max(1, qa.syncToleranceMs)
          },
          limits
        );
        const deltas = isolated.map((t) => ({
          piste: t.trackId,
          attenduMs: t.startMs,
          ecartMs: Math.min(...onsets.map((o) => Math.abs(o - t.startMs)))
        }));
        checks.push(
          check(
            'Synchronisation audio — onsets',
            deltas.every((d) => d.ecartMs <= qa.syncToleranceMs),
            'minor',
            `Mesuré : départs [${onsets.join(', ')}] ms ; ${deltas.map((d) => `${d.piste} : attendu ${d.attenduMs} ms, écart ${d.ecartMs} ms`).join(' ; ')} ; tolérance ${qa.syncToleranceMs} ms.`
          )
        );
      } catch (error) {
        checks.push(
          notDone(
            'Synchronisation audio — onsets',
            `Détection non réalisée : ${error instanceof Error ? error.message : 'erreur inconnue'}`
          )
        );
      }
    }
  }
  return checks;
}
