# Vérifications

## Commandes

| Commande (racine) | Portée | Coût |
|---|---|---|
| `pnpm test` (`pnpm -r test`) | Vitest : contrats et calcul des frames, config, stockage, vidéo (clips ffmpeg 0,6 s, extraction par index, PSNR), adaptateur (doublures), IA simulée et détection Claude Code (commande simulée), migration 0001, SQLite/repo/runner, service Studio (vrais MP4 ffmpeg 1080p générés par un moteur de test) | ~1 min, sans réseau ni clé |
| `pnpm check` | `tsc` des packages, `svelte-check` du Studio | Rapide |
| `pnpm lint` | Prettier, ESLint (Studio) | Rapide |
| `pnpm --filter @veyra/hyperframes-adapter test:slow` | Rendu HyperFrames réel 6 s sous bwrap, ffprobe | ~6 s, Chrome requis |
| `pnpm --filter studio test:e2e` | Playwright : build, serveur, parcours complet avec rendu réel, sélection de frame, lot, QA comparatif, IA simulée | ~45 s, Chrome requis |
| Test manuel `claude-subscribe` | Voir ci-dessous ; utilise l'abonnement de l'utilisateur | Manuel, hors CI |
| `pnpm --filter @veyra/hyperframes-adapter test:slow` (inclut `motion.slow.test.ts` et `entry-state.slow.test.ts`) | Rendu réel des 5 composants (20 s) : `check` sans erreur, animations mesurées ; entrées cachées avant leur début (frames 0–12, sauts `snapshot --at`, retour à 0) | ~40 s, Chrome requis |
| `pnpm qa:bench --evaluator fake` | Compare le simulateur au jeu de référence `qa/reference/v1` | Rapide ; **mesure les règles du simulateur, pas une expertise** |
| `pnpm qa:bench --results <fichier>` | Compare des résultats d'expert (`veyra-qa-results/v1`) aux références ; `--json <sortie>`, `--fail-on-critical` | Rapide ; résultats produits ailleurs (mode assisté ou API) |

Critère de réussite : 0 échec. Les tests E2E utilisent une base et une racine
média temporaires neuves (`VEYRA_E2E_ROOT`) et `VEYRA_AI_PROVIDER=fake`.
Aucun test automatique n'appelle une IA réelle ni Claude Code : la détection est
testée avec une commande simulée. La page `/settings` de l'E2E exécute
`claude --version` / `claude auth status` si Claude Code est installé (lecture
seule, aucune requête modèle) ; son résultat n'est pas vérifié par le test.

### Test manuel `claude-subscribe`

1. Studio isolé : `DATABASE_URL=/tmp/v.db VEYRA_PROJECTS_ROOT=/tmp/vp VEYRA_AI_PROVIDER=claude-subscribe pnpm --filter studio dev`.
2. `/settings` : `claude-subscribe` « Disponible » (Claude Code connecté par claude.ai).
3. Projet → prompt de référence → « Importer le résultat » après
   `/veyra-assisted-task <dossier>` dans Claude Code → rendu réel.
4. Deux frames annotées → « Envoyer les corrections à l'IA (2) » → traiter le
   dossier du plan dans Claude Code → importer → appliquer → verdicts de correction.
Critère : v2 rendue, verdicts `applied` pour des corrections réellement appliquées.

## Résultats du 2026-10-29, passage à HyperFrames 0.8.214 (exécutés directement)

| Commande | Résultat |
|---|---|
| `pnpm -r test`, `pnpm -r check`, `pnpm -r lint` | 360 réussis ; réussis |
| `pnpm test:slow` | 2 rendus réels réussis ; 4 E2E réussis (1,6 min) |
| `pnpm motion:previews --demo` | 5 aperçus `check` sans erreur ; images octet pour octet identiques à celles de 0.8.209 |
| Démo 0.8.209 vs 0.8.214 (`ffmpeg … psnr`) | PSNR infini sur les 600 images : rendu identique au pixel ; seuls les octets du conteneur MP4 diffèrent |

## Résultats du 2026-10-29, Motion Engine v0.2 (exécutés directement)

| Commande | Résultat |
|---|---|
| `pnpm -r test` | **360 réussis, 0 échec** : schemas 231, config 25, storage 10, motion 6, ai 31, video 6, hyperframes-adapter 18, studio 33 |
| `pnpm -r check`, `pnpm -r lint` | Réussis |
| `test:slow` (adaptateur) | **2 réussis** : rendu texte 6 s ; rendu réel des 5 composants, 20 s, `check` sans erreur de lint/exécution/mise en page/contraste, frames différentes début/fin dans chaque scène |
| `pnpm test:e2e` | **4 réussis, 1,7 min** ; dont catalogue, composition SaaS, correction du bouton d'un composant, conservation des autres, verdict `applied`, export MP4 20 s |
| `pnpm motion:previews --demo` | 5 aperçus `check` sans erreur (après correction du contraste du surtitre et des textes < 28 px que `check` avait signalés) ; démo 20 s 1080p h264 |

## Résultats du 2026-10-28, consolidation QA Expert v0.1 (exécutés directement)

| Commande | Résultat |
|---|---|
| `pnpm -r test` | **343 réussis, 0 échec** : schemas 231, config 25, storage 10, ai 25, video 6, hyperframes-adapter 16, studio 30 |
| `pnpm -r check`, `pnpm -r lint` | Réussis |
| `drizzle-kit check` / `generate` | « Everything's fine » ; « No schema changes » ; migrations 0000–0002 inchangées |
| `test:slow` (adaptateur) | 1 réussi |
| `pnpm --filter studio test:e2e` | **3 réussis, 45,8 s** ; trois sections, confiance « fixe du simulateur », note sur les estimations, preuves non examinées |
| `pnpm qa:bench --results qa/reference/v1/results/independent-review-2026-10-28.json` | 1/10 cas couverts ; 4/4 verdicts et catégories corrects ; régression 1/1 ; 0 erreur critique |
| `pnpm qa:bench --evaluator fake` | 10/10 cas ; exactitude 92 % (12/13), catégorie 85 % ; échec attendu sur le cas technique (visible seulement sur images) ; 0 erreur critique |

Ces scores portent sur des références **non encore validées par un humain**.

## Résultats du 2026-10-28, expertise QA (exécutés directement)

| Commande | Résultat |
|---|---|
| `pnpm -r test` | **329 réussis, 0 échec** : schemas 224, config 25, storage 10, ai 19, video 6, hyperframes-adapter 16, studio 29 |
| `pnpm -r check`, `pnpm -r lint` | Réussis |
| `test:slow` (adaptateur) | 1 réussi |
| `pnpm --filter studio test:e2e` | **3 réussis, 45,6 s** ; l'expertise simulée s'affiche « Simulée », jamais « Multimodale » |
| Revue indépendante sur rendus HyperFrames réels | Voir ci-dessous |

### Revue indépendante des cas (2026-10-28)

Projet de 5 scènes rendu par HyperFrames en `claude-subscribe` ; 4 annotations ; plan
volontairement imparfait importé et appliqué (scène 2 allongée d'1 s : scènes
suivantes décalées). La demande d'expertise exportée (30 images exactes) a été
traitée par un **sous-agent Claude neuf**, sans accès au code ni aux réponses
attendues, avec le seul skill `veyra-assisted-task` ; résultat importé par l'UI.

| Cas | Commentaire | Mesure (storyboard + PSNR) | Expert indépendant |
|---|---|---|---|
| Correction appliquée | « ralentis son entrée » (500 → 1200 ms) | applied | **applied**, contenu, 0,85 |
| Visible mais contraire | « Ralentis l'apparition » (500 → 150 ms) | applied (faux positif) | **contradicts_request**, contenu, 0,90 |
| Partielle | « Remplace le texte … et ralentis » (texte seul) | applied (faux positif) | **partially_applied**, contenu, 0,80 |
| Invérifiable | « Le son est trop fort » | not_applied | **unverifiable**, contenu, 0,90 |
| Régression | scène finale modifiée sans demande | « Régression possible » | **regression**, majeur, 0,95 |
| Fournisseur indisponible | — | conservée | `unavailable` (test `evaluation.test.ts`) |

Mode affiché : « Multimodale — images déclarées examinées par Claude Code » (17
images déclarées sur 30). Désaccords avec la mesure signalés (3). Constats en plus :
durée 26 s au lieu de 25 s (contenu), entrée de 150 ms proche d'une coupe
(esthétique). Lacune trouvée par la revue et corrigée : les séquences n'étaient
jointes que si le plan touchait au timing ; elles le sont désormais pour toute
scène commentée.

## Résultats du 2026-10-28, annotations et fournisseurs (exécutés directement)

| Commande | Résultat |
|---|---|
| `pnpm -r test` | **291 réussis, 0 échec** : schemas 199, config 25, storage 10, ai 11, video 5, hyperframes-adapter 16, studio 25 |
| `pnpm -r check` | Réussi ; Studio 0 erreur, 0 avertissement |
| `pnpm -r lint` | Réussi |
| `test:slow` (adaptateur) | **1 réussi** (rendu réel 6 s) |
| `pnpm --filter studio test:e2e` | **3 réussis, 46,4 s** ; frame 360 = 00:12.000, ← → ±1 frame, capture, lot unique, plan, v2, verdict `applied` mesuré sur les rendus HyperFrames réels, validation, MP4 20 s |
| Test manuel `claude-subscribe` | **Réussi** : détection « Disponible (pro) » ; storyboard exporté, traité par une session Claude Code via le skill, importé, rendu ; lot de 2 annotations (frames 75 et 390) exporté avec images, plan importé et appliqué ; verdicts `applied` (PSNR min 18,7 et 24,0 dB) |

Résultat antérieur (MVP) : 197 tests, 3 E2E en 31,0 s.

## Traçabilité

| Exigences | Preuves |
|---|---|
| R2, R5 | `packages/schemas/src/index.test.ts` (transitions exhaustives, IDs, intervalles) ; `repo.test.ts` (immuabilité, transitions illégales) |
| R3, R4 | `packages/config/src/index.test.ts` (4 extensions, couches, verrous, versions, Markdown inerte, configs réelles) ; E2E « settings never display secret values » |
| R1, R6 | `repo.test.ts` ; E2E (commentaire à 00:12 rattaché à la révision et à la scène) |
| R7 | `runner.test.ts` (provenance simulée), `packages/ai` (simulateur jamais `multimodal`) ; E2E (rapport « Déterministe » + « Simulé ») |
| R8, R12 | E2E : validation humaine puis export ; route média refuse l'export hors `approved` |
| R9 | `sandbox.test.ts` (argv, refus sans bwrap) ; `render.slow.test.ts` (rendu réel sous bwrap) |
| R10, R11 (service) | `apps/studio/src/lib/server/studio.test.ts` : annotation sans appel IA ni rendu, persistance, édition/suppression ; lot idempotent (un seul appel de plan), plan, révision enfant, verdicts `applied`/`not_applied` sur vrais MP4, absence de régression, validation humaine ; commentaires ajoutés pendant l'analyse hors lot ; erreur fournisseur → commentaires conservés, relance, aucun changement de fournisseur ; mode assisté (export, rejet d'un résultat invalide, import) ; auto-correction ≤ 2 ; refus sans IA |
| R13 (frames) | `packages/schemas/src/frames.test.ts` (30, 25, 29,97, 23,976 i/s, aller-retour de chaque frame, PTS tronqués, décalage, bornes) ; `packages/video` (fréquence mesurée, extraction par index) ; E2E |
| R14 (fournisseurs) | `packages/ai/src/index.test.ts` (fournisseur choisi uniquement, clé absente → erreur, détection : non installé, non connecté, connexion non abonnement, abonnement + clé API signalée, aucune identité conservée) ; E2E `/settings` |
| Migration | `apps/studio/src/lib/server/db/migration.test.ts` (0000 → 0001 : statuts, fournisseurs, clés étrangères ; 0001 → 0002 : tâches conservées, `evaluation` accepté) |
| R16 (Motion Engine) | `packages/motion/src/index.test.ts` (registre, échappement, rejets, durées, format français) ; `packages/ai/src/motion.test.ts` (composition, validation, corrections ciblées, conservation) ; `compose.test.ts` (clips, injection) ; `motion.slow.test.ts` (rendu réel) ; `apps/studio/src/lib/server/motion.test.ts` (parcours service, `check` → QA, pas de nouveau rendu inutile) ; E2E Motion Engine |
| R15 (consolidation) | `packages/schemas` (garde-fou : simulé jamais multimodal, multimodal sans image refusé) ; `ui.spec.ts` (libellés de mode et de confiance) ; `packages/ai/src/benchmark.test.ts` (exactitude, matrice, erreurs critiques, cohérence du jeu de référence, résultat enregistré) ; `evaluation.test.ts` (langue) ; E2E |
| R15 (expertise) | `packages/ai/src/evaluation.test.ts` (5 cas simulés, validation des résultats, `multimodal` seulement si images envoyées, requête assistée sans chemin local) ; `apps/studio/src/lib/server/evaluation.test.ts` (lot réel : appliquée, contraire, partielle, invérifiable, régression, preuves alignées avec décalage de 1 s, ancienne révision intacte, validation humaine ; fournisseur indisponible ou absent ; import assisté : rejet d'un résultat invalide, images hors dossier ignorées, `text-only` sans image) ; E2E ; revue indépendante ci-dessus |
| R10, R11 | `packages/ai/src/index.test.ts` (prompt de référence → 20 s ; « à 12 s, ralentis » → scène à 12 s, 500 → 800 ms) ; E2E `apps/studio/tests/mvp.e2e.ts` (prompt → rendu réel → QA → commentaire → plan → v2 → validation → MP4 de 20 s vérifié par ffprobe) ; E2E mobile (onglets) |

## Non couvert

- Fournisseur `anthropic-api` réel : seulement typé, jamais appelé (pas de clé).
- Fréquence variable (VFR) : seulement signalée, pas indexée (D012).
- `AnthropicQualityEvaluator` : seulement testé avec un `parse` simulé (pas de clé).
- Tests Vitest navigateur (projet `client`) : aucun.
- Accessibilité : pas d'audit outillé ; navigation clavier vérifiée par lecture du code seulement.

## Résultats du 2026-10-29, v0.3 Phase A (exécutés directement)

| Commande | Résultat |
|---|---|
| `pnpm -r test` | 392 réussis, 0 échec, 24 fichiers : schemas 256, config 25, storage 10, motion 13, ai 31, video 6, hyperframes-adapter 18, studio 33 |
| `pnpm -r check`, `pnpm -r lint` | Réussis ; Svelte : 0 erreur, 0 avertissement |

32 nouveaux tests couvrent contrats audio/production, ancrages, hash stable et
événements visuels (FPS entiers et fractionnaires). Rendus lents et E2E non relancés.

## Résultats du 2026-10-29, v0.3 Phase B (exécutés directement)

| Commande | Résultat |
|---|---|
| `pnpm -r test` | 412 réussis, 0 échec, 28 fichiers : schemas 256, config 26, storage 10, motion 13, ai 31, video 6, hyperframes-adapter 18, audio 19, studio 33 |
| `pnpm -r check` | Réussi ; Svelte : 0 erreur, 0 avertissement |
| `pnpm -r lint` | Réussi ; Prettier et ESLint |

Mode hors ligne forcé par `npm_config_offline=true`. Les tests audio génèrent
leurs fixtures FFmpeg dans des répertoires temporaires et les nettoient : formats,
limites, décodage, synchronisation, niveaux, silence, crêtes, mux et intégrité des
sources. Premier passage global : timeout Vitest de 5 s du test fades/ducking sous
charge ; délai des tests d'intégration audio porté à 30 s, puis passage réussi
(audio : 5,18 s pour les 19 tests). Les limites du moteur restent inchangées.
Rendus HyperFrames lents et E2E non relancés. Aucun Markdown passé à Prettier.

## Résultats du 2026-10-29, v0.3 Phase C (exécutés directement)

| Commande | Résultat |
|---|---|
| `pnpm check` | Réussi ; Svelte : 0 erreur, 0 avertissement, 1128 fichiers examinés |
| `pnpm lint` | Réussi ; Prettier et ESLint ; Markdown exclu temporairement, fichier ignore restauré ensuite |
| `pnpm test` | 500 réussis, 0 échec, 31 fichiers : schemas 317, config 26, storage 10, motion 13, ai 39, video 6, hyperframes-adapter 18, audio 19, studio 52 |

Les 14 tests de `apps/studio/src/lib/server/production.test.ts` couvrent SQLite
migrée en mémoire, dépendances, parallélisme Motion/Audio, tentatives et budget IA,
arrêt/reprise idempotente, attente externe, drives concurrents, rollback atomique,
validation humaine, imports assistés récents et anciens, reconstruction des runners
après changement d'instance Studio et reprise d'un rendu échoué dans un enfant.
Les WAV music/sfx sont générés localement par FFmpeg ; la correction de musique
entre 8 et 12 s crée un duck sans nouveau rendu image et conserve le parent.
Les 38 tests Studio existants passent sans nouvelle modification.

Un passage intermédiaire, lancé avant la dernière correction de reprise du rendu,
a échoué sur ce nouveau scénario ; le test ciblé puis le passage global final
sur les fichiers stabilisés ont réussi (Studio : 123,55 s).
Aucun Markdown passé à Prettier. Aucun appel fournisseur réel, E2E ou rendu
HyperFrames lent exécuté pour cette phase ; les rendus d'intégration utilisent
`colorEngine` et FFmpeg.

## Résultats du 2026-10-29, v0.3 Phase D (relancés par le Lead après intégration)

| Commande | Résultat |
|---|---|
| `pnpm check` | Réussi ; Svelte : 0 erreur, 0 avertissement |
| `pnpm lint` | Réussi ; Prettier et ESLint |
| `pnpm test` | 508 réussis, 0 échec : schemas 317, config 26, storage 10, motion 13, ai 40, video 6, hyperframes-adapter 18, audio 19, studio 59 |
| `pnpm --filter studio test:e2e` | **5 réussis, 2,0 min** ; dont « audio UI » : import WAV, arrêt/reprise de production, pistes et chronologie, commentaire de plage sur une piste, bande son modifiée avec image réutilisée, contrôle « Non réalisé » affiché |

Un premier passage E2E a échoué (5 min) : nom de stockage `ast_<uuid>-…` affiché à la
place du nom d'origine ; corrigé dans le Studio, l'attente du test est conservée.
Le délai d'attente de `awaiting_approval` du parcours MVP passe à 90 s : la QA
(contrôles audio inclus) se termine après l'apparition du lecteur.

## Résultats du 2026-10-29, v0.3 Phase E (relancés par le Lead après intégration)

| Commande | Résultat |
|---|---|
| `pnpm check` / `pnpm lint` | Réussis |
| `pnpm --filter studio build` | Réussi ; plus d'externalisation de `node:crypto` dans le bundle client |
| `pnpm test` | 517 réussis : schemas 317, config 26, storage 10, motion 13, ai 41, video 6, hyperframes-adapter 18, audio 19, studio 67 |
| `pnpm --filter studio test:e2e` | **6 réussis, 2,7 min** ; `v03-audiovisual.e2e.ts` 37,6 s sur rendu HyperFrames réel |

Parcours `v03-audiovisual` : projet, composition SaaS, import de deux WAV générés
par FFmpeg, trois pops ancrés sur `card-appear`, MP4 vérifié par ffprobe (h264 +
aac 48 kHz, 2 canaux, 20 s), onsets mesurés à 0,06–0,08 ms des événements visuels
(tolérance 40 ms), commentaire de plage 8–12 s, plan audio, révision v3 avec image
identique au bit près et v2 inchangée, QA « Mesuré » / « Non réalisé », verdict
`applied` (−11,9 dB mesurés), validation humaine et run `completed`.
Limite : la musique bouclée chevauche les pops, le contrôle d'onsets de
l'application est donc `not-performed` ; la synchronisation est prouvée par la
mesure indépendante du test. Démo réelle : `projects/_demo/demo-audio.mp4`
(ignoré par git) produite dans le worktree du Testing Agent.
