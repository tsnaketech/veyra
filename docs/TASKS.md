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
