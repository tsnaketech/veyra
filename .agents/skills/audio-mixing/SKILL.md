---
name: audio-mixing
description: Use when touching mixing, mux or audio measurements (packages/audio buildMixArgs/mixToWav/muxAudio/analyzeAudio/detectOnsets), the audio QA checks (apps/studio/src/lib/server/jobs/audio-qa.ts) or config/audio.yaml.
---

# Mixage et QA audio

- `buildMixArgs` produit uniquement des arguments : aucun label utilisateur ni
  chemin dans le graphe de filtres, nombres validés puis formatés. Tout processus
  passe par `runAudioProcess` (argv sans shell, prlimit CPU/taille, timeout, logs
  bornés à 2 Mio, `-protocol_whitelist file`).
- Sorties écrites dans un temporaire voisin puis renommées ; une sortie identique
  à une entrée est refusée. Les sources ne sont jamais modifiées.
- Mesures : `ebur128` (LUFS intégré, true peak), `astats` (crête), `silencedetect`.
  Valeur illisible = erreur, jamais de valeur de repli. Garder le journal par
  trame d'`ebur128` (`framelog=quiet` fausse le résumé sous FFmpeg 5.1).
- QA (`audioQualityChecks`) : mesures `deterministic` avec seuils `qa` de
  `config/audio.yaml` et limites `cpuSeconds`/`timeoutMs` ; « Écoute
  qualitative » toujours `not-performed`. Une mesure n'est pas une écoute :
  ne jamais déclarer une écoute, la validation humaine reste obligatoire.
  `not-performed` ne peut pas réussir et n'est pas compté comme un échec.
- La synchronisation par onsets ne vaut que pour un effet isolé ; superposé à
  une autre piste, le contrôle est `not-performed`.
- Aucun contrôle audio ne déclenche de nouveau rendu automatique.

Vérifier avec de vrais médias FFmpeg (lavfi `sine`, `anullsrc`, sinus écrêté,
trou de silence), jamais avec des mesures simulées :
`pnpm --filter @veyra/audio test`, `pnpm --filter studio test`, `pnpm check`.
Référence : [AUDIO-PIPELINE](../../../docs/video/AUDIO-PIPELINE.md#audio-qa),
[QUALITY-STANDARDS](../../../docs/video/QUALITY-STANDARDS.md).
