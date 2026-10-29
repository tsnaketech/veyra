---
name: audio-production
description: Use when changing how a soundtrack is proposed, anchored or imported (packages/ai proposeAudio/simulateAudioChange, AudioComposition and anchors in packages/schemas, Studio.importAudio/reviseAudio, probeAudio validation in packages/audio).
---

# Production audio

- Audio Agent (`proposeAudio`, `packages/ai/src/agents.ts`) : règles déterministes à
  partir des fichiers importés uniquement. Aucune génération, aucun TTS, aucune
  recherche réseau, aucune dépendance payante.
- `AudioComposition` (`packages/schemas/src/core.ts`) : pistes ancrées sur des
  événements de la timeline visuelle ; règles d'ancrage dans
  [MULTI-AGENT-ARCHITECTURE](../../../docs/ai/MULTI-AGENT-ARCHITECTURE.md).
  `resolveAudioComposition` reste pur ; un ancrage inrésolu devient un problème
  visible, jamais une position inventée.
- Import (`Studio.importAudio`) : média non fiable, `probeAudio` complet (lien
  symbolique refusé, taille, format ffprobe autorisé, durée, décodage intégral)
  avant tout placement. L'original est stocké tel quel (`storeOriginal`) et
  jamais modifié ; un refus est expliqué et conservé.
- `reviseAudio` crée une révision enfant à storyboard identique : l'image est
  réutilisée, pas recomposée.
- Chemins confinés à la racine des projets ; processus par argv via
  `runAudioProcess` (prlimit, timeout, `-protocol_whitelist file`).

Vérifier : `pnpm --filter @veyra/audio test`, `pnpm --filter @veyra/ai test`,
`pnpm --filter studio test`, puis `pnpm check`.
Référence : [AUDIO-PIPELINE](../../../docs/video/AUDIO-PIPELINE.md).
