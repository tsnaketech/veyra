---
name: video-quality-assurance
description: Use when changing QA checks or reports (packages/video deterministicChecks/compareFrames, Studio.review/verifyCorrections, the runner reviewer hook, AiProvider.reviewFrames, QualityReport, batch verification).
---

# QA vidéo

- Contrôles déterministes (ffprobe, `blackdetect`) : `analysisMode: "deterministic"`, preuve = valeurs mesurées.
- Revue qualitative : images au milieu de chaque scène envoyées au modèle → `multimodal`.
  Sans image → `text-only`. Simulateur → `simulated`. Mode assisté : pas de revue
  automatique (rien n'est envoyé). Ne jamais déclarer `multimodal` si le modèle n'a reçu que du texte.
- QA comparatif d'une révision issue d'un lot (`Studio.verifyCorrections`), pour chaque
  commentaire : valeurs du storyboard comparées au patch prévu, puis frames du rendu
  précédent et du nouveau aux mêmes décalages dans la scène (PSNR ffmpeg, seuil
  `quality.correctionCheck.psnrThresholdDb`). Verdicts `applied` (source conforme et
  différence visible), `partially_applied`, `not_applied`, `unverifiable` (comparaison
  impossible) ; preuves dans `batch.verification` et le rapport QA. Scènes non ciblées
  comparées aussi : différence → « Régression possible » (`minor`).
- Expertise QA (`Studio.requestEvaluation`, `packages/ai/src/evaluation.ts`, D015) :
  dossier de preuves aligné (capture exacte, frame alignée, séquences de timing,
  scènes non ciblées) → `QualityEvaluator` du fournisseur (`fake` = `simulated`,
  `anthropic-api` = images envoyées, `claude-subscribe` = export/import, multimodal
  « déclaré »). Toujours passer le résultat par `sanitizeReview`. Consultative :
  ne change aucune révision, aucun état, aucune correction ; indisponible → `unavailable`.
- Consolidation (D016) : `reportLanguage`, rapport en trois parties, garde-fou du
  schéma (simulé jamais multimodal) ; mesurer tout changement d'évaluateur avec
  `pnpm qa:bench` sur `qa/reference/v1` (références à valider par un humain).
- Correction automatique : au plus `maxAutoFixAttempts` (2) nouveaux rendus, uniquement
  pour des contrôles déterministes `major`/`critical` en échec. Les verdicts de
  correction sont `minor` : ils n'en déclenchent jamais.
- Le QA ne valide jamais une révision : elle reste `awaiting_approval` jusqu'à l'action humaine.

Référence : [QUALITY-STANDARDS](../../../docs/video/QUALITY-STANDARDS.md).
