# Tâches

Statuts : à faire | en cours | bloquée | terminée. Exigences : [PRD](PRD.md).
Commandes et comptes exacts : [TESTING](TESTING.md).

## G1 — Fondations (phase 1) — terminée le 2026-10-27

| ID | Travail et fichiers | Exigences | Statut / preuve |
|---|---|---|---|
| T001 | Workspace pnpm, manifests, `tsconfig.base.json` | — | Terminée ; `pnpm install` |
| T002 | `packages/schemas` : contrats, IDs, transitions | R2, R5 | Terminée ; Vitest schemas |
| T003 | `packages/config` et `config/` | R3, R4 | Terminée ; Vitest config |
| T004 | Schéma Drizzle, dépôt métier | R1, R5, R6 | Terminée ; `repo.test.ts` |
| T005 | docs/, memory/, AGENTS.md | — | Terminée ; relecture |

Réalisées par Codex (exécutant `/route`), relues et revérifiées par Claude :
install, tests, check, lint et build relancés indépendamment.

## G3 — Moteur vidéo (phase 3) — terminée le 2026-10-28

| ID | Travail et fichiers | Exigences | Statut / preuve |
|---|---|---|---|
| T010 | QA à modes mixtes (`analysisModes`) | R7 | Terminée ; Vitest schemas |
| T011 | `packages/storage` | R1, R9 | Terminée ; 10 tests |
| T012 | `packages/video` (ffprobe, blackdetect, frames) | R7 | Terminée ; 4 tests sur clips réels |
| T013 | `packages/hyperframes-adapter` (compose, sandbox, moteur) | R9 | Terminée ; 16 tests + `test:slow` réel réussi après correction de `compose` (lint HyperFrames) et de la capture stdout |
| T014 | File de rendu en processus, état `failed` | R5 | Terminée ; `runner.test.ts` |

Codex a écrit T010–T014 ; sa session s'est interrompue (limite d'usage) avant
la fin des docs. Claude a diagnostiqué l'échec du rendu réel et repris
l'implémentation à la demande de l'utilisateur.

## G4 — IA, interface et parcours MVP (phases 2, 4, 5) — terminée le 2026-10-28

Point de validation du groupe : `mvp.e2e.ts` vert avec rendu réel.

| ID | Travail et fichiers | Exigences | Statut / preuve |
|---|---|---|---|
| T020 | `packages/ai` : interface, simulateur étiqueté, `AnthropicProvider` | R7, R10, R11 | Terminée pour le simulateur (5 tests) ; **chemin Claude non vérifié** (pas de clé) |
| T021 | `studio.ts` : prompt, rendu, QA qualitative, auto-correction ≤ 2, commentaires, plans, révisions enfants, validation, fichiers | R1, R6, R8, R10, R11 | Terminée ; `studio.test.ts` (3 tests) |
| T022 | Schémas : `parentRevisionId`, `failed`, patches de plan ; migration fusionnée (D008) | R5, R11 | Terminée ; Vitest schemas + repo |
| T023 | Interface : `/`, `/projects/[id]`, `/settings`, route média, design system, logo officiel | R8, R12 | Terminée ; E2E + captures desktop/mobile relues |
| T024 | Skills `.agents/skills/*` (lien `.claude/skills`) | — | Terminée ; relecture |
| T025 | Parcours E2E Playwright avec rendu réel | R1–R12 | Terminée ; 3 tests réussis |
| T026 | Documentation et mémoire | — | Terminée ; relecture |

## G5 — Annotations par frame, lots de corrections, fournisseurs — terminée le 2026-10-28

Point de validation : `studio.test.ts` et `mvp.e2e.ts` verts, test manuel `claude-subscribe` réussi.

| ID | Travail et fichiers | Exigences | Statut / preuve |
|---|---|---|---|
| T040 | Audit initial : rapport précédent confirmé (197 tests, check, lint verts) ; aucun écart | — | Terminée |
| T041 | Décision `claude-subscribe` assisté après lecture des conditions officielles (D010, D011) | R14 | Terminée ; choix de l'utilisateur |
| T042 | Calcul des frames `packages/schemas/src/frames.ts` ; `media` mesuré par rendu ; `FramePlayer.svelte` | R13 | Terminée ; `frames.test.ts`, E2E |
| T043 | Annotations : migration 0001 (D014), repo, `addAnnotation`/edit/delete, capture par index, route `/captures` | R13 | Terminée ; `migration.test.ts`, `repo.test.ts`, `studio.test.ts` |
| T044 | Lots : `submitBatch` idempotent, plan unique, conflits, relance, rejet ; UI de sélection et d'envoi | R13 | Terminée ; `studio.test.ts`, E2E |
| T045 | Fournisseurs : `createProvider` sans repli, `AssistedProvider`, `checkClaudeSubscribe`, `/settings`, skill `veyra-assisted-task` | R14 | Terminée ; `packages/ai` (11 tests), E2E, test manuel |
| T046 | QA comparatif `verifyCorrections` (verdicts, régressions, PSNR) | R13 | Terminée ; `studio.test.ts`, E2E sur rendus réels |
| T047 | Docs, skills, mémoire | — | Terminée ; relecture |

## G6 — Expertise QA (Video QA Expert) — terminée le 2026-10-28

Point de validation : `evaluation.test.ts`, E2E et revue indépendante sur rendus réels.

| ID | Travail et fichiers | Exigences | Statut / preuve |
|---|---|---|---|
| T050 | Audit QA : mesures conservées ; limite constatée (sens du changement non jugé) | R15 | Terminée ; D015 |
| T051 | Schémas : `contradicts_request`, catégories, `QualityEvaluation` ; migration 0002 | R15 | Terminée ; schemas, `migration.test.ts` |
| T052 | `extractFramesByIndex` (un décodage, frames exactes) | R15 | Terminée ; `packages/video` |
| T053 | `QualityEvaluator` : simulé, API, assisté ; `sanitizeReview` | R15 | Terminée ; `evaluation.test.ts` (ai) |
| T054 | `Studio.requestEvaluation`, dossier de preuves aligné, import assisté, UI, route `/qa-images` | R15 | Terminée ; `evaluation.test.ts` (studio), E2E |
| T055 | Revue indépendante des 6 cas | R15 | Terminée ; TESTING ; lacune des séquences corrigée |

## G7 — Consolidation QA Expert v0.1 — terminée le 2026-10-28

| ID | Travail | Statut / preuve |
|---|---|---|
| T060 | Revue des changements non commités (aucun secret, fichiers ignorés corrects) | Terminée |
| T061 | Langue des rapports (`reportLanguage`, `fr` par défaut) | Terminée ; tests ai |
| T062 | Rapport en trois parties, preuves citées / non examinées, confiance estimée | Terminée ; E2E |
| T063 | Garde-fou simulé ≠ multimodal (schéma + affichage) | Terminée ; schemas, `ui.spec.ts` |
| T064 | Jeu de référence `qa/reference/v1` et `pnpm qa:bench` | Terminée ; `benchmark.test.ts` |
| T065 | Validation humaine des verdicts attendus du jeu de référence | **À faire (humain)** |

## G8 — Motion Engine v0.2, première itération — terminée le 2026-10-29

Point de validation : `motion.slow.test.ts` et E2E Motion Engine (rendus réels).

| ID | Travail | Statut / preuve |
|---|---|---|
| T070 | Audit compositeur, adaptateur, extension HyperFrames (catalogue tiers exclu, D017) | Terminée |
| T071a | `@veyra/motion` : registre et 5 composants ; intégration `compose` ; `check` dans le moteur | Terminée ; commit d758dfb |
| T071b | Storyboard et IA : composition, corrections `text`/`params`, QA de composition | Terminée ; commit 6af557e |
| T071c | Studio : composants par scène, composition, page Composants, aperçus réels, E2E | Terminée ; commit f9d1d6a |
| T072 | Démo 20 s à 5 composants (`pnpm motion:previews --demo`) | Terminée ; non versionnée |

## À faire

| ID | Travail | Dépendance |
|---|---|---|
| T030 | Valider `AnthropicProvider` avec une vraie clé : storyboard, plan, revue multimodale ; ajouter un test coûteux séparé | Clé fournie par l'utilisateur |
| T031 | Vérifier les licences HyperFrames et GSAP pour redistribution | — |
| T032 | Panneaux redimensionnables ; test avec un lecteur d'écran réel (audit contraste/cibles fait le 2026-10-28, DESIGN) | — |
| T034 | Valider `AnthropicQualityEvaluator` avec une clé (coût par évaluation à mesurer) | T030 |
| T071 | Une sous-composition HyperFrames par scène (avertissement `nested_structure_needs_subcomposition`) | — |
| T073 | Images utilisateur dans ProductMockup (assets locaux, sans réseau) | — |
| T074 | Composition par composants avec `anthropic-api` et `claude-subscribe` réels (non mesurée) | T030 |
| T037 | Rendre les cas synthétiques du jeu de référence avec images, pour mesurer un expert multimodal sur 10 cas | T065 |
| T035 | Indexation VFR par timestamps de présentation, si des médias importés sont annotés | Besoin produit |
| T036 | Option d'appel direct `claude -p` pour un usage strictement personnel, si l'utilisateur la décide | Décision utilisateur (D010) |
| T033 | Extraire `apps/worker` si multi-instance ou reprise après crash requise (D006) | Besoin produit |

## G9 — v0.3 Phase A : contrats audiovisuels et inter-agents

| ID | Travail | Statut / preuve |
|---|---|---|
| T080 | Schémas timeline/audio/production, ancrages et hash ; événements du registre ; architecture multi-agents | Terminée le 2026-10-29 ; 392 tests réussis, check et lint réussis ; commit 7d16462 |

## G10 — v0.3 Phase B : moteur audio

Groupe indivisible : validation → résolution/mixage → mesures et tests réels.
Point de validation : fixtures FFmpeg, sources inchangées, contrôles récursifs.

| ID | Travail | Statut / preuve |
|---|---|---|
| T081 | Package audio, validation des médias et limites, configuration | Terminée ; `packages/audio/src/validation.test.ts`, configuration réelle chargée ; installation hors ligne réussie depuis le store local copié |
| T082 | Résolution des ancrages, mixage WAV et mux AAC atomiques | Terminée ; `timeline.test.ts`, `mixing.test.ts` : onsets ±40 ms, fades, ducking ≥6 dB, mux 3 s, empreintes des sources inchangées et sortie préservée après échec |
| T083 | Mesures, tests FFmpeg, documentation et vérification globale | Terminée ; `analysis.test.ts` ; 412 tests réussis (19 audio), `pnpm -r check` et `pnpm -r lint` réussis ; détail dans TESTING |

## G11 — v0.3 Phase C : orchestration Studio

Groupe indivisible : runs persistés → intégration production/révision → tests.
Point de validation : contrôles racine et parcours audio réel sans nouveau rendu image.

| ID | Travail | Statut / preuve |
|---|---|---|
| T084 | Intégration Studio : production, import assisté et ancien format, corrections audio/image, approbation, arrêt/reprise, snapshot | Terminée ; `production.test.ts` (production, audio, import, approbation et reprise depuis SQLite), 38 tests Studio existants inchangés réussis |
| T085 | Orchestrateur : dépendances parallèles, tentatives, budget IA, attente externe, reprise idempotente et exclusion des drives concurrents | Terminée ; `apps/studio/src/lib/server/production.test.ts` : parallélisme, budget, tentatives, reprise, exclusion mutuelle, rollback et rendu enfant après échec |
| T086 | Tests SQLite/FFmpeg, contrôles racine et documentation | Terminée le 2026-10-29 ; `pnpm check`, `pnpm lint`, `pnpm test` réussis directement : 500 tests, 31 fichiers, dont 52 Studio (14 nouveaux). Détail dans TESTING ; E2E et rendus HyperFrames lents non relancés |

## G12 — v0.3 Phase D : interface et QA audio

Groupe indivisible : mesures audio → verdicts et expertise honnête → interface accessible.

| ID | Travail | Statut / preuve |
|---|---|---|
| T087 | Contrôles audio déterministes configurables et écoute non réalisée | Terminée ; `jobs/audio-qa.test.ts` (7 tests, médias FFmpeg réels : flux, durée, silences, écrêtage, niveau, onsets, média illisible, limites de ressources) |
| T088 | Vérification des corrections audio et faits mesurés pour l'expert | Terminée ; verdict `applied` du ducking mesuré (`production.test.ts`), expertise simulée « audio non écouté » (`packages/ai/src/evaluation.test.ts`) |
| T089 | Panneaux production/audio, actions et annotations par plage/piste | Terminée ; E2E « audio UI » (import, arrêt/reprise, pistes, commentaire de plage, image réutilisée) ; FramePlayer conservé |
| T090 | Tests, E2E si Chrome disponible, documentation et mémoire | Terminée le 2026-10-29 ; 508 tests, 5/5 E2E (2,0 min), check et lint réussis, relancés par le Lead ; détail dans TESTING |

## G13 — v0.3 Phase E : corrections d'audit et validation réelle

| ID | Travail | Statut / preuve |
|---|---|---|
| T091 | Corrections de l'audit d'architecture : reprise après crash, révision suivie par run, payloads validés par phase, attribution engine/human, garde VFR, avertissements ducking et ancrages, budget de rendus, `inputHash` hors bundle client, D019 | Terminée ; tests ciblés dans `production.test.ts`, `studio.test.ts`, `agents.test.ts`, `production.test.ts` (schemas) |
| T092 | Validation conservée quand l'utilisateur valide pendant l'expertise QA | Terminée ; runner `human-approval` ; test de régression (échoue sans le correctif) |
| T093 | E2E audiovisuel réel en 11 étapes et migration 0003 → 0004 | Terminée ; `tests/v03-audiovisual.e2e.ts` (onsets à ≤ 0,1 ms de card-appear, ffprobe aac 48 kHz 20 s, image réutilisée au bit près, duck mesuré −11,9 dB), `db/migration.test.ts` |
| T094 | Revue indépendante et corrections | Terminée ; revue par un sous-agent sans code écrit : 0 critique, 2 majeures, 6 mineures. Corrigées avec tests (rouges sans correctif) : validation pendant un arrêt (M1), reprise d'un run interrompu puis arrêté (M2), import assisté refusé sans verrou (m1), promesse non gérée (m2), boucle avec point d'entrée refusée (m3), lecture bornée à la source (m4). Limites documentées : m5, m6 et points « Info » ([AUDIO-PIPELINE](video/AUDIO-PIPELINE.md)) |

## G14 — Suites de l'évaluation des skills créatifs (à planifier)

Source : [OPENMONTAGE-SKILLS-EVALUATION](research/OPENMONTAGE-SKILLS-EVALUATION.md), sections 8, 11 et 12.

| ID | Travail | Statut / preuve attendue |
|---|---|---|
| T095 | `animated-title` (`reveal: words`) : supprimer le « flash » du titre complet avant la révélation | **Fait le 2026-11-03** : `immediateRender: true` sur les entrées (`compose.ts`) ; `entry-state.slow.test.ts` (frames 0–12 du MP4, `snapshot --at 3.5,0.1,2,0`) ; frame 0 : 13 493 → 0 pixels de texte ; mesures dans [SKILLS-STRATEGY § 6.1](ai/SKILLS-STRATEGY.md#61-gsap-compatible-avec-hyperframes-rendu-réel) |
| T096 | `feature-cards` : supprimer la double entrée des cartes ; `call-to-action` : titre avant bouton et mention | **Fait par T095** (même cause) : cartes 1 767 → 0 pixels à la frame 0, bouton 8 293 → 0 ; planches vérifiées (titre, puis bouton, puis mention) |
| T097 | Mots orphelins et `align: left` déséquilibré dans les composants | À faire ; aperçus réels |
| T098 | Enrichir `prompt-to-video` et `instructions.storyboard` : règles de récit et règle anti-provisoires (pas de « alterner align ») | À faire après T095–T097 ; nouvel A/B ≥ 3 essais, ablation et relecture humaine |
| T099 | Règles sonores de l'Audio Agent (une musique, niveau et avance des effets, transitions) | À faire ; validation à l'écoute humaine |

## G15 — Skills externes et v0.4 (à planifier)

Source : [SKILLS-STRATEGY](ai/SKILLS-STRATEGY.md), sections 2, 6, 8 et 11. Audit du 2026-11-02 : documentation, `.gitignore` et consignes de skills seulement.

| ID | Travail | Statut / preuve attendue |
|---|---|---|
| T100 | FFmpeg de la machine : recompiler 9.0.2 avec libx264, zlib, freetype, libass, x265, mp3lame, opus et vidstab ; actualiser RUNBOOK | **Fait le 2026-11-02** ([install_ffmpeg](install_ffmpeg.md)) : `test:slow` 2/2, `pnpm test` réussi, `check`/`lint` OK, E2E 6/6 (course corrigée dans `v03-audiovisual.e2e.ts`), `ffmpeg-skill doctor` 42/42 |
| T101 | Normalisation de sonie dans l'Audio Engine (`loudnorm` en deux passes, cible dans `config/audio.yaml`) et contrôle « Diffusion » consultatif | À faire ; contrôle « Niveau sonore » réussi sur un rendu réel |
| T102 | POC qc-skill (commit `a53c30d`) sous bwrap : photosensibilité BT.1702, contraste WCAG par zone, plage de luminance sur les vidéos du banc A/B | **Fait le 2026-11-03** : [QC-SKILL-POC](research/QC-SKILL-POC.md) ; sans `pip install`, `--unshare-all`, 15 requêtes |
| T103 | POC Three.js (copie locale épinglée, `hf-seek`, rendu WebGL sous bwrap) | Seulement sur besoin produit approuvé ; aucune dépendance avant |
| T104 | Video QA : contrôle photosensibilité et contraste mesurés sur le rendu, en TypeScript dans `packages/video` ; zones fournies par HyperFrames ; numéros FeatureCards lisibles | **Fait le 2026-11-03** : commits `5285059` (numéros blancs, contraste pixels 2,0–2,4 → 11,1–12,6:1, HF 3 → 0 échecs), `e9dfae4`, `800dbf1`, `12ec2a4`, `1051dd2`, puis commit final (revue : D1 surcomptage du regroupement de flashs ; contre-revues : N1 et N2, balayages échelonnés sous-comptés ; corrigés avec tests 24/30/60 i/s). Méthode, seuils et limites : [QUALITY-STANDARDS](video/QUALITY-STANDARDS.md) (aucune certification BT.1702, flashs rouges non évalués, pas de correction automatique). Vérifié : `pnpm test` 560, `check`, `lint`, `test:slow` 9/9, E2E 6/6 (lancés par l'intégrateur ; revue : mêmes suites sauf E2E final) ; revue indépendante, contexte neuf, 3 contre-revues : critères 1–8 PASS, réserve R1 documentée (T109). Le premier reviewer s'est bloqué sans conclusion ; artefacts hors dépôt (`kajisho5-lab/t104/review*`) |
| T105 | Contraste mesuré : texte sur fond rayé, image ou superposition qui passe le contrôle DOM d'HyperFrames n'est jamais remesuré (zones = échecs HF seulement) | À faire si un composant pose du texte sur fond non uni ; nécessite les boîtes des textes réussis |
| T106 | `.app-name` (ProductMockup) en accent violet : 3,02–3,12:1 mesuré sur rendu (grand texte gras, seuil 3:1 respecté, marge faible) | Maintenu tel quel (décision utilisateur du 2026-11-03) ; passer en blanc si le seuil devient 4,5:1 ([MOTION-ENGINE](video/MOTION-ENGINE.md)) |
| T107 | `measureTextContrast` ignore `start_time` du flux (seek relatif à 0) | Sans effet sur les rendus HyperFrames (`start_time=0`, sans B-frames) ; à traiter avant de mesurer des médias importés |
| T108 | Photosensibilité : flashs rouges saturés et motifs réguliers non évalués | Seulement sur besoin (diffusion réglementée : outil certifié) ; ne pas revendiquer de conformité d'ici là |
| T109 | Photosensibilité : comptage par région (réserve R1) — régions déphasées d'une image (volet, entrées échelonnées) comptées double : 1,5–2 Hz par région ou 3 coupes complémentaires/s étalées sur 2 images → `major` à tort | À faire avant tout usage bloquant du verdict ; cas de reproduction : `kajisho5-lab/t104/review2/zz-review2-fn4.test.ts.txt` ; aujourd'hui sans correction automatique, validation humaine obligatoire |

## G16 — v0.4 Voice & Captions (validé le 2026-11-03)

Brief : [v0.4-voice-captions](plans/v0.4-voice-captions.md) (périmètre, architecture, risques, critères CA-1 à CA-V8) ; moteurs : [comparatif](research/V04-VOICE-CAPTIONS-ENGINES.md). Aucune installation ni téléchargement avant approbation explicite.

| ID | Travail | Statut / preuve attendue |
|---|---|---|
| T110 | Brief, comparatif des moteurs, décision D020 | **Fait le 2026-11-03** : périmètre et ordre validés (brief § 10) ; D020 après les POC moteurs |
| T111 | Contrats Zod (narration, sous-titres, providers), `groupCaptions`, SRT/WebVTT | **Fait le 2026-11-03** (`6488db0`) : `captions.test.ts`, `captions-format.test.ts` ; temps exportés arrondis vers le bas (cue visible exactement sur ses frames à 24/30/60/29,97, revu sur 57 143 cues par cadence) |
| T112 | Migration 0005 (`captions`, `caption_cue_id`), dépôt, révisions | **Fait le 2026-11-03** (`8c71cb1`) : migration additive (2 `ALTER TABLE ADD`), test 0004→0005, sous-titres immuables et hérités comme la bande son |
| T113 | Calque de sous-titres HyperFrames, styles, animations | **Fait le 2026-11-03** (`5e49629`) : rendus réels 24/30/60 i/s, bande présente exactement sur [startFrame, endFrame), `snapshot --at` dans le désordre, word-highlight frame exact ; sortie identique sans sous-titres |
| T114 | Livraisons incrustée / propre / les deux ; export quantifié | **Fait le 2026-11-03** (`5754448`, correctifs de revue) : SRT/VTT re-quantifiés sur la vidéo exportée mesurée, contrôle « calage des exports » ; rendus réels 24/30 i/s (bande = frames des SRT/VTT relus, absente de la vidéo propre) ; durée non entière de frames (2 750 ms à 30 i/s) rendue et vérifiée |
| T115 | `VoiceProvider` import + fake ; repli `scene` | **Fait le 2026-11-03** (`724a846`, correctifs de revue) : `voice.test.ts` (audio 5, studio 11) ; `voice-captions.slow.test.ts` (Studio + HyperFrames réel : narration FR, voix importée — tonalité, **pas de parole** — et simulée, livraison « les deux », SRT/VTT = frames mesurées, audio AAC dans les deux MP4, QA « précision des temps » `minor`, remplacement de voix CA-6, révisions intactes CA-4) |
| T116 | Installation explicite des moteurs, `voice:doctor`, sidecars sans réseau ; dossier POC Piper | **Outillage fait le 2026-11-03, non validé par revue** : `config/voice.yaml` + schéma `voice` (Piper candidat, URL des roues et empreinte d'`onnx` nulles = « à relever ») ; `engines.test.ts` (audio, 8 : états, verrou, confirmation/refus, refus non épinglé, nettoyage sur écart) ; `engine-sandbox.test.ts` (adaptateur, bwrap réel : connexion loopback hôte refusée `ECONNREFUSED`, racine moteur `EROFS`, sortie inscriptible ; échoue si `--unshare-net` est retiré) ; `pnpm voice:doctor` → « non installé » ; `pnpm voice:install piper` (entrée fermée) → plan affiché, bloqué (code 2), aucun fichier créé. **Approbation** utilisateur toujours requise avant tout téléchargement ; POC → T117 |
| T117 | POC puis `local-tts` Piper (`fr_FR-mls-medium`, candidats) | Après approbation ; écoute, RTF, RAM, temps par mot ; CA-V1, CA-V2 |
| T118 | `local-asr` whisper.cpp, modèle léger vs `large-v3-turbo` quantifié | Après approbation ; CA-V3 |
| T119a | Étude de l'alignement forcé (API torchaudio ≥ 2.9, alternative maintenue sur CPU) | À faire ; aucune installation de torch avant accord |
| T119 | Alignement `ctc` retenu par T119a | Après approbation ; CA-V7 |
| T120 | QA sous-titres et voix | En partie : « calage des exports » et « précision des temps » faits ; restent lisibilité (CPS, longueur), contraste et zone sûre des cues, QA de la vidéo propre en mode « les deux », écart voix ↔ script |
| T121 | Studio : narration, voix, édition des sous-titres, livraison | À faire ; E2E |
| T122 | Review Agent : commentaires sur cue | À faire |
| T123 | E2E sans moteur ; E2E moteurs réels (sauté avec raison) | À faire |
| T124 | Revue indépendante, documentation, mémoire | À faire |
| T125 | Suites de revue T111–T115 : proposer l'allongement d'une scène quand sa voix déborde (brief § 4.4, aujourd'hui avertissement seul) ; ne pas perdre les cues édités à la main lors d'un regroupement (à traiter avec T121) ; fenêtre d'atténuation de l'Audio Agent remplacée par `placeSceneVoice` ; `pictureKey` ignore toute clé `narration` | À faire ; revue du 2026-11-03 |
| T126 | Point à surveiller : une fois sur 7 exécutions, v1 sans vidéo dans `voice-captions.slow.test.ts` (non reproduit, peut-être dû à des modifications concurrentes) | Le test affiche désormais l'erreur ; relancer `test:unit --project slow` en cas de récidive |

## G17 — Agents et outils (studio de montage piloté par l'IA)

Architecture : [AGENT-ARCHITECTURE](ai/AGENT-ARCHITECTURE.md), outils : [TOOL-REGISTRY](ai/TOOL-REGISTRY.md), note : [AI-native](plans/ai-native-editing-studio-note.md). Mission Agent Architect du 2026-11-03 : 4 audits (capacités, sécurité, tests, format des sous-agents) ; 8 sous-agents de développement dans `.agents/agents` (lien `.claude/agents`), contrôlés par `packages/config/src/agents.test.ts`.

| ID | Travail | Statut / preuve attendue |
|---|---|---|
| T132 | P0 : exécuteur de processus unique (env minimal obligatoire, `-protocol_whitelist file` dans `probe`, prlimit pour `packages/video`) ; corriger SECURITY sur la propagation des clés | Fait (2026-11-04, non commité) : `runProcess` = exécuteur unique (env en liste blanche jamais hérité, refus des clés de type secret et des shells, prlimit par défaut pour ffmpeg/ffprobe, `streamFrames` via l'exécuteur), `fileInput`/`mediaPath` sur toutes les entrées vidéo, Sandbox/`runEngine`/`runAudioProcess` sur le même env, `checkClaudeSubscribe` en liste blanche ; [SECURITY](SECURITY.md#exécuteur-de-processus-t132). Preuves : `packages/video/src/process.test.ts` (6), `apps/studio/src/lib/server/jobs/process-env.test.ts` (7, ffmpeg/ffprobe réels derrière un enregistreur ; échouent si l'env parent est réinjecté), `engine-sandbox.test.ts` (bwrap réel), test `claude` réel factice dans `packages/ai` ; `pnpm test` (676), `pnpm check`, `pnpm lint`, `test:slow` adaptateur 16/16, Studio slow 1/1, E2E 6/6 |
| T136b | Correctifs des revues Security Reviewer et Testing Engineer : accès Studio (plugin Vite devant sources, statiques et HMR ; CSRF dans tous les modes ; `Host` de bouclage ; formulaire POST au lieu de `?access=` ; redirection fixe) ; exécution (sandbox sans `/run` de l'hôte, `--new-session`, `--unshare-ipc/uts/cgroup` ; PATH fixe ; limites par nom de base ; liens symboliques refusés ; `-format_whitelist`) | **Fait le 2026-11-04** : `access.test.ts` (8), `access.slow.test.ts` (6 sur vrais serveurs), `process-policy.test.ts` (15, ffmpeg/ffprobe réels : HLS, ffconcat, liens, PATH), `engine-sandbox.test.ts` (bwrap réel : sockets D-Bus et XDG introuvables), `process-env.test.ts` (12) ; `pnpm test` 702, `check`, `lint`, `test:slow` 16, slow Studio 7 (+1 ignoré), E2E 6/6. Résiduels : sockets sous des chemins montés en lecture (`$HOME`), `runProcess` primitive bas niveau (liste blanche de binaires avec T127) |
| T137 | Mode assisté : import automatique et actualisation (D010 : lancement de Claude Code toujours manuel) | **Fait le 2026-11-04 (commit 958e29f)** : `Studio.watchAssistedTasks` (passage toutes les 2 s depuis `jobs/index.ts`, `unref`) appelle `importTask` pour chaque `result.json` stable entre deux passages, une fois par version (taille + mtime) ; erreur journalisée une fois, sans contenu brut (`JSON invalide`) ; lecture `O_NOFOLLOW`/fichier régulier/≤ 1 Mo ; `runId` et `parentRevisionId` du même projet ; effet et passage `imported` dans une transaction ; run arrêté : script enregistré, message « Reprendre » ; page actualisée toutes les 2 s en attente ; skill inchangé sur le fond (écrit seulement `result.json`, aucune commande, conforme à CLAUDE.md). Preuves : `production.test.ts` (8 nouveaux : import auto, fichier partiel, JSON invalide non retenté, lien et dossier refusés, ids étrangers, course surveillance/clic, rollback, run arrêté) ; `pnpm test` (Studio 139), `pnpm check`, `pnpm lint`, E2E 6/6. Pas d'E2E dédié : Playwright force `VEYRA_AI_PROVIDER=fake` |
| T127 | Registre d'outils : descripteurs Zod → JSON Schema, classes de permission, disponibilité ; outils opérationnels (inspection, frame, modification de scène, piste audio, sous-titres, vérification de composition) ; indisponibles déclarés (local-tts, ASR, alignement). Critères de sécurité issus de la revue du 2026-11-04 : N2 (`$HOME` masqué dans la sandbox), N7 (toute entrée ffmpeg via `fileInput`, `-i` sans liste de formats refusé), N8 (binaires en chemins absolus, crochet de test hors de l'API publique) | **Registre fait le 2026-11-04, non validé par revue** : contrat `packages/schemas/src/tools.ts` (+ préfixe `tcl`) ; registre `apps/studio/src/lib/server/tools/registry.ts`, 7 outils réels et 3 bouchons (`tools.ts`, [TOOL-REGISTRY § 3 bis](ai/TOOL-REGISTRY.md)). Preuves : `schemas/src/tools.test.ts` (3) ; `tools/registry.test.ts` (5 : découverte et JSON Schemas, outil inconnu, entrée invalide ou non JSON sans exécution, sortie invalide, délai, échec sans pile ni secret, permission absente, indisponibles avec `installHint`) ; `tools/tools.test.ts` (5, Studio réel + colorEngine — ffmpeg réel, **pas** HyperFrames : ffprobe/ffmpeg réels derrière le shim enregistreur, aucun secret chez l'enfant, PNG + sha256 hors du dossier de révision, entrée invalide = aucun processus, `scene.patch` deep-equal, `audio.track.update` refusé sans permission puis révision enfant avec parent et sha256 du MP4 inchangés, sous-titres approximatifs et SRT/VTT sur frames mesurées) ; `tools/tools.slow.test.ts` (1 : `hyperframes check` réel sous bwrap, 6 sections). `pnpm test` 723, `check` 0 erreur, `lint` OK, slow Studio 8 (+1 ignoré). Hors de cette tâche (autre ingénieur, en cours) : N2, N7, N8. Non branché sur une route ni persisté (T129) ; revue indépendante du 2026-11-04 : D1–D5 corrigés (entrée profonde ou trop grande, délai non réessayable pour un outil à effet de bord, masquage avant troncature, permissions validées, portée projet), `pnpm test` 729, slow Studio 8 (+1 ignoré), E2E 6/6 |
| T127-sec (N2/N7/N8) | Critères de sécurité de T127 (revue du 2026-11-04). N2 : `/home` et `$HOME` masqués par tmpfs dans bwrap, remontés en lecture seule seulement le cache Chrome et les polices HyperFrames, les dossiers de polices utilisateur, le `node_modules` du CLI et le préfixe de node (`sandbox.ts`). N7 : l'exécuteur refuse avant lancement tout `-i` ffmpeg/ffprobe sans `-protocol_whitelist file` et `-format_whitelist` (démultiplexeurs de `MEDIA_FORMATS`/`IMAGE_FORMATS`), sauf `-f lavfi` juste avant ; `-protocol_whitelist` ≠ `file` refusé. N8 : binaires nus résolus une fois sous `/usr/local/bin`, `/usr/bin`, `/bin` (`systemBinary`, aussi après `prlimit --`) ; dossier de node en dernier dans le PATH enfant ; `setChildPathPrefixForTests` déplacé vers `@veyra/video/testing` | **Fait le 2026-11-04** (non commité) : `engine-sandbox.test.ts` (bwrap réel : fichier et socket créés sous le vrai `$HOME`, `~/.ssh`, `~/.claude`, `~/.config` invisibles ; mutation sans tmpfs → échec), `process-policy.test.ts` (21, ffmpeg réel : `-i` nu, `file,pipe`, `hls` refusés avant lancement par enregistreur ; faux `ffmpeg` à côté d'une copie de node jamais exécuté ; mutations N7 ×2 et N8 → échec), `process-env.test.ts` (12) ; nécessité des remontées vérifiée en les retirant (sans Chrome : `render exited 1` ; sans `node_modules` : `lint exited 1`) ; `pnpm test` 723 (dont schemas 356, travail concurrent sur le registre), `check` 0 erreur, `lint`, `test:slow` 16, slow Studio 8 (+1 ignoré), E2E 6/6. Résiduels : racine hors `/home` lisible, sockets sous chemins remontés connectables, lavfi `movie=` et filtres `movie=` non contrôlés, tmpfs non bornés |
| T133 | P1 : budget unique des appels facturables (`reviewFrames`, `requestEvaluation`, hors run), décrément avant l'appel | **Couverte par T138** (enveloppe par run, réservation avant l'appel, appels hors run imputés au run de la révision ou refusés) |
| T138 | Enveloppe budgétaire stricte par production ([D022](DECISIONS.md#d022--enveloppe-budgétaire-stricte-par-production)) : contrats et dépôt (commit 958e29f), puis branchement des appels `anthropic-api` | **Fait le 2026-11-10 (commit 8fa2f11)** : `AnthropicProvider` reçoit la clé de `$app/env/private` (`anthropicClient`, `maxRetries: 0`), `CallMeter` (`before`/`after`) fourni par le Studio, `countTokens` puis réservation du pire cas, `max_tokens` = réservation, `{ signal, timeout }`, erreurs SDK traduites sans contenu, repli serveur retiré ; `config/models.json` : `pricing` (source, date), `maxTokens` 16000, `callTimeoutMs` 120000 ; Studio : `callFor` (refus sans run, sans tarif ou si l'enveloppe ne couvre pas `max_tokens`, avant `countTokens`), `runOf` (run producteur, `origin.runId` ajouté aux révisions des runs de révision), `AbortController` par run déclenché par « Arrêter », pas de nouvel essai sur `BudgetExceededError` ; UI : champ « Enveloppe autorisée (USD) » (anthropic-api seulement, pire cas storyboard estimé), « Augmenter » et autorisé/dépensé/réservé dans ProductionPanel, modèle/tarif/source dans `/settings` ; libellé `[API Anthropic — modèle]` et `provenance.model`. Preuves : `packages/ai/src/billing.test.ts` (6 : clé explicite malgré `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` d'environnement, `maxRetries` 0, refus sans compteur, ordre count → réservation → appel → règlement, `max_tokens`/signal/délai, pas de `fallbacks`, erreurs traduites, refus du modèle réglé) ; `apps/studio/src/lib/server/production.test.ts` (5, client simulé : refus à 0 sans `countTokens` ni repli, dépassement après comptage puis reprise après augmentation, plusieurs appels et plan de lot hors run sur une enveloppe, abort réel via Arrêter, appel sans run refusé) ; `pnpm test` (752), `pnpm check`, `pnpm lint`, E2E fake 6/6. Aucun appel réel à l'API |
| T134 | P1 : QA Expert isolé (entrée sans `plannedChanges` ni contexte du planificateur) | À faire ; test espion de l'entrée |
| T135 | `colorEngine` déclaré `test-color` (ne plus se présenter comme HyperFrames) | À faire |
| T128 | `EditOperation` (union typée) et graphe d'invalidation des artefacts | À faire |
| T129 | Director : `ToolPlan` en données (un appel), validé, budgété, exécuté par l'orchestrateur | À faire ; décision sur D007 |
| T130 | Cache de rendu par scène (décision complétant D019) | À faire |
| T131 | POC DSL de composition originale (primitives et tweens en données) | À faire |
| T136 | Studio exposé sur le LAN sans authentification : `127.0.0.1` ou authentification + CSRF | Décision utilisateur |
| T139 | Capacités déclarées par fournisseur (Zod) et `/settings` en cartes (statut, disponibilité, auth, modèles, capacités, limites, coût, action nécessaire) ; indisponible = non sélectionnable ; `ProviderId` étendu, aucun repli (D011, [D023](DECISIONS.md#d023--fournisseurs-openai-et-codex)) | **Fait le 2026-11-10 (commit c5f5b5d)** : `packages/ai/src/capabilities.ts`, `providerAvailability` et refus serveur dans `chooseProvider` (`jobs/index.ts`). Preuves : `providers.test.ts` (aucun `prepared`/`simulated` déclaré `operational`), E2E `settings never display secret values` étendu (6 cartes, statuts « Préparé »/« Simulé », `local` désactivé) ; `pnpm test` 769, `pnpm check`, `pnpm lint`, E2E 6/6. Changement : `claude-subscribe` n'est plus sélectionnable si Claude Code n'est pas détecté |
| T140 | `openai-api` : Responses API, sortie structurée, D022 | **Code livré le 2026-11-10 (commit c5f5b5d), jamais appelé réellement ; inutilisable au rendu jusqu'au correctif T145 (images), utilisable ensuite en texte seul** : `openai.ts` (SDK `openai` 7.47.0 épinglé, `maxRetries: 0`, `{ signal, timeout }`, `store: false`, `zodTextFormat` si le schéma est accepté en strict — revue et expertise — sinon `json_schema` non strict — storyboard et plan —, revalidation Zod, erreurs traduites) ; borne d'entrée hors ligne : octets UTF-8 + 256. Preuves : `providers.test.ts` (client simulé : réservation avant l'appel et règlement par `usage`, refus sans enveloppe, images refusées sans borne puis `input_image` avec borne, sortie invalide, erreur SDK sans contenu ; `createProvider` sans clé/modèle/tarif → indisponible) ; `production.test.ts` (enveloppe Studio : refus à 0, coût constaté, libellé `[API OpenAI — …]`). **Restent** : tarif OpenAI sourcé dans `config/models.json` (aucun aujourd'hui → indisponible), borne sourcée des jetons d'image, essai réel avec la clé de l'utilisateur |
| T141 | `codex-chatgpt` préparé (D023) | **Fait le 2026-11-10 (commit c5f5b5d), désactivé par défaut, jamais lancé réellement** : `codex.ts` (`codex exec` via `runProcess`, options du rapport § 7 + `--output-last-message`, env HOME/CODEX_HOME, refus si `OPENAI_API_KEY`/`CODEX_API_KEY`, dossier vide, Zod) ; `runProcess` accepte un `AbortSignal` et `CODEX_HOME` ; activation `/settings` (`app_settings.codexChatgptEnabled`). Preuves : `providers.test.ts` (faux binaire `codex` : sortie valide → storyboard, invalide → erreur, clé présente → refus sans lancement, délai et abort → processus mort, sonde inactive tant que désactivé puis `--version` + `login status`). **Restent** : essai par l'utilisateur après installation ; `codex login status` et `--` non documentés dans le rapport, à vérifier |
| T142 | Fournisseur local | À faire ; POC soumis à autorisation (téléchargement de modèle) ; étude [LOCAL-AI-AND-CHATGPT-APPS](research/LOCAL-AI-AND-CHATGPT-APPS.md) ; déclaré `prepared` dans les capacités |
| T143 | Remplacement du fournisseur par projet | **Fait le 2026-11-10 dans T146 (commit ab1f15d)** : [D024](DECISIONS.md#d024--fournisseur-ia-par-projet), colonne `projects.ai_provider` (migration 0007), sélecteur sur la page projet ; preuves sous T146 |
| T144 | ChatGPT → Veyra (application ChatGPT, Sign in with ChatGPT) | Étude faite ([LOCAL-AI-AND-CHATGPT-APPS](research/LOCAL-AI-AND-CHATGPT-APPS.md), [OPENAI-CODEX-INTEGRATIONS](research/OPENAI-CODEX-INTEGRATIONS.md)) ; non engagé |
| T145 | Suites des revues du 2026-11-10 ([rapport](reviews/2026-11-10-provider-integration.md)) : I1, I2, M1, M2 (controllers), M4 et durcissements | **Fait le 2026-11-10 (commit 2cab916)** : capacité `images` respectée (`structured.ts` : revue `not-performed`, plan et expertise en texte seul, signalés) ; revue qualitative optionnelle (`Studio.review` : refus d'enveloppe ou erreur → « Revue IA non effectuée : raison », rendu conservé ; `runner.ts` n'en fait pas un défaut) ; `settleSafely` (`index.ts`, `openai.ts`) ; `callFor` : une réservation à la fois ; `controllers` purgé (fin de run, arrêt) ; `readResult` en lecture bornée ; `baseURL` explicite (`baseUrls` de `config/models.json`) ; plafond `maxBudgetUsd` (20 $) au formulaire et dans `raiseBudget`/`sendPrompt` ; sonde Codex : connexion ChatGPT exigée ; RUNBOOK (`CODEX_HOME` dédié, argv visible via `ps`), D022, SECURITY. Preuves : `providers.test.ts` (texte seul openai, sonde clé API refusée), `billing.test.ts` (`*_BASE_URL` ignorés, règlement en échec), `config/index.test.ts` (plafond, HTTPS), `production.test.ts` (revue openai non effectuée, enveloppe 0,33 $ → rendu gardé, double réservation refusée, plafond, `controllers` vides, `result.json` > 1 Mo) ; `pnpm test` 777 (Studio 152, ai 67, config 39), `pnpm check` 0 erreur, `pnpm lint` EXIT 0, E2E fake 6/6. Aucun appel réseau ni binaire codex réel. Limite : un choix `claude-subscribe` déjà enregistré n'est pas revérifié au démarrage (M3, non traité) ; réservations orphelines après arrêt brutal toujours non libérées |
| T146 | Limites de la couche fournisseurs (suites de T145 et M2/M3 de la [revue](reviews/2026-11-10-provider-integration.md)) | **Fait le 2026-11-10 (commit ab1f15d)** : (1) réservations orphelines comptées comme dépensées au démarrage (`Orchestrator.settleOrphanReservations`, appelé par le constructeur du `Studio` ; `repo.reservedRuns`), message dans la conversation ; (2) choix global enregistré revérifié en arrière-plan au démarrage (`jobs/index.ts`, sonde existante de `/settings`) : sans IA active tant que non vérifié, « Fournisseur enregistré indisponible : raison » dans `/settings` et la page projet, sans repli ni effacement ; (3) revue IA non effectuée : badge « Revue IA non effectuée » + raison dans le rapport QA et le panneau de validation (`skippedAiReviews`, `ui.ts`), jamais comptée réussie ; (4) T143 / D024 : `projects.ai_provider` (0007), `aiProviderIdSchema`, `Studio.aiFor`/`providerFor`, cache par id, `VEYRA_AI_PROVIDER` verrouille tout. Preuves : `production.test.ts` (base fichier rouverte, 0,3 $ réservés → 0 réservé, 0,3 $ dépensés, message, nouvelle réservation possible) ; `jobs/providers.test.ts` (env et sonde Claude Code simulés : démarrage non bloqué, erreur explicite, choix conservé ; projet `fake` effectif, `anthropic-api` refusé sans clé, projet indisponible → erreur et `sendPrompt` refusé, retour au global) ; `ui.test.ts`. `pnpm test` EXIT 0, 780 tests (Studio 155) ; `pnpm check` 0 erreur ; `pnpm lint` EXIT 0 ; E2E fake 6/6. Aucun appel réseau ni binaire codex/claude réel. Limites : page projet sur la dernière disponibilité connue (pas de sonde à chaque actualisation) ; badge et sélecteur sans test E2E (fake verrouillé) |
| T147 | POC `codex-chatgpt` réel ([étude § 10](research/OPENAI-CODEX-INTEGRATIONS.md)) | **En cours : préparation faite le 2026-11-10 (non commitée), démonstration réelle en attente** de la connexion de l'utilisateur. Codex 0.167.0 installé par l'intégrateur (npm épinglé, attestations vérifiées), `CODEX_HOME` dédié (700). `codex.ts` : chemin d'image avec virgule refusé, `-c cli_auth_credentials_store="file"` (exec et sonde), `-c web_search="disabled"` en plus de `tools.web_search=false`, `--` conservé (à valider sur le vrai binaire) ; sonde : code 0 **et** « ChatGPT » sur stderr. `config/models.json` : `codexChatgpt.command` et `codexHome` renseignés (activation toujours dans `/settings`). Preuves : `providers.test.ts` (faux binaire : nouvelles options, `--` avant le prompt, virgule refusée sans lancement, sonde `-c … login status`, « ChatGPT » avec code 1 refusé). Préparé, **non exécuté** : `codex.real.test.ts` (`VEYRA_CODEX_REAL`, commande dans RUNBOOK) : sonde, storyboard, brief hostile (`pwned.txt`, événements `--json`), annulation à 2 s, env sans clé API. Aucun binaire codex réel lancé, aucun appel réseau |
