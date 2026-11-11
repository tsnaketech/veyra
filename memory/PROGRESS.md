# Progression

2026-10-29 — G1 à G8 terminés (G8 : Motion Engine v0.2, première itération) ;
détail et preuves dans [TASKS](../docs/TASKS.md), comptes dans
[TESTING](../docs/TESTING.md) : 360 tests rapides, 2 tests de rendu réel, 4 E2E réels.
Commits sur `feat/qa-expert-v0.1`, rien n'est poussé.

Prochaine étape : T065 (validation humaine des verdicts de référence QA), T030/T074
(fournisseurs réels), T071 (sous-compositions). Migrations 0000 à 0002 : ne plus les
modifier (D014, D015) ; le Motion Engine n'en a ajouté aucune.

2026-10-29 — Phase A v0.3 (T080) terminée, commitée par l’orchestrateur (7d16462) : contrats purs
inter-agents/audio/temps et événements Motion. Voir [TASKS](../docs/TASKS.md)
et [architecture multi-agents](../docs/ai/MULTI-AGENT-ARCHITECTURE.md).
Contrôles récursifs : 392 tests réussis, check et lint réussis. Aucun moteur audio,
stockage ou parcours UI ajouté à cette phase.

2026-10-29 — Phase B v0.3 (T081–T083) terminée, non commitée : moteur audio
FFmpeg, configuration et mesures ; [pipeline](../docs/video/AUDIO-PIPELINE.md).
412 tests, check et lint réussis (preuves : [TESTING](../docs/TESTING.md)).
Prochaine intégration audio au Studio/orchestrateur à définir ; aucune DB/UI
modifiée. Les quatre documents restaurés conservent les lignes de HEAD et leurs
ajouts seuls ; ne pas lancer Prettier sur Markdown.


2026-10-29 — Phase C v0.3 (T084–T086) terminée, non commitée : orchestration
persistée intégrée au service Studio, correction audio seule avec réutilisation
de l'image, arrêt/reprise depuis SQLite, imports assistés et validation humaine.
Résultats directs : 500 tests, check et lint réussis ; détails dans
[TASKS](../docs/TASKS.md) et [TESTING](../docs/TESTING.md). Les changements déjà
présents ont été conservés ; migrations 0000–0003 et skills intacts.
Limites : E2E et HyperFrames lents non relancés ; coordination multi-processus et
reprise autonome après crash restent hors périmètre (D006). Prochaines tâches
ouvertes : voir TASKS ; aucune commande UI d'orchestration ajoutée.

2026-11-01 — v0.3 phases D et E commitées (d57c381, 3ad6a73, puis corrections de
revue). Développement par sous-agents Claude Code (Architecture, Frontend, Audio
Engineer, Integration Fix, Testing, Independent Reviewer) intégré et revérifié par
le Lead. Limites restantes : voir AUDIO-PIPELINE « Limites connues » et TASKS T094.
Prochaine étape : selon priorité utilisateur ; aucun push ni PR.

2026-11-02 — Audit des skills externes et des candidats kajisho5 :
[SKILLS-STRATEGY](../docs/ai/SKILLS-STRATEGY.md). FFmpeg 9.0.2 recompilé avec
libx264/PNG et installé dans /usr/local (T100 fait, [install_ffmpeg](../docs/install_ffmpeg.md)) :
tests, E2E 6/6 et ffmpeg-skill doctor 42/42 réussis. POC qc-skill (T102) bloqué :
exécution de code externe refusée par l'environnement. Prochaine étape : T095
(cause reproduite).

2026-11-03 — T095 corrigé (`immediateRender: true` sur les entrées, `entry-state.slow.test.ts`) ;
corrige aussi T096 (même cause). POC qc-skill fait sous bwrap sans installation
([QC-SKILL-POC](../docs/research/QC-SKILL-POC.md)) : photosensibilité nouvelle, contraste sur
l'image utile avec zones par texte, luminance légale = faux positifs. Suite proposée : T104.
Vérifié : pnpm test, check, lint, test:slow 3/3, E2E 6/6 ; 18 MP4 de l'E2E en Lavf63.1.102 (FFmpeg 9.0.2).

2026-11-03 — T104 (QA visuelle) : numéros FeatureCards en blanc, contrôles
« Photosensibilité (flashs, mesure technique) » et « Contraste mesuré sur l'image
rendue » dans le rapport QA, sans correction automatique ; détail, commits et
suites (T105–T108) dans [TASKS](../docs/TASKS.md), méthode et limites dans
[QUALITY-STANDARDS](../docs/video/QUALITY-STANDARDS.md). Revue indépendante
(contexte neuf, après blocage d'un premier reviewer) : D1, N1, N2 corrigés ;
critères 1–8 PASS, réserve R1 (comptage global, pas par région) suivie en T109.
Vérifié directement : pnpm test 560, check, lint, test:slow 9/9, E2E 6/6.
`.app-name` maintenu (décision utilisateur, T106).
Prochaine étape : selon priorité utilisateur ; pas de v0.4 avant cette clôture.

2026-11-03 — v0.4 Voice & Captions : brief validé ([plan](../docs/plans/v0.4-voice-captions.md)),
T110–T115 faits sans aucun moteur TTS/ASR (contrats, migration 0005, calque HyperFrames
exact à la frame, livraisons incrustée/propre/les deux, SRT/VTT calés sur la vidéo
exportée, voix importée/simulée, sous-titres de repli approximatifs signalés au QA).
Revue indépendante : D1 (durée non entière de frames) et messages corrigés ; suites
T120, T125, T126. Vérifié directement : pnpm test 635, check, lint, test:slow
adaptateur 16, slow Studio 1, E2E 6/6. Note v0.5 FLORA/Flow :
[note](../docs/plans/v0.5-generative-media-note.md). Aucun moteur installé.
Prochaine étape : dossier POC Piper (T116) à présenter avant toute installation.


2026-11-03/04 — T116 commité (`be69fb8`, aucun téléchargement). Mission Agent Architect :
[AGENT-ARCHITECTURE](../docs/ai/AGENT-ARCHITECTURE.md), [TOOL-REGISTRY](../docs/ai/TOOL-REGISTRY.md),
exemples dans AGENT-WORKFLOWS ; 8 sous-agents de développement dans `.agents/agents`
(lien `.claude/agents`) ; G17 (T127–T136) dans TASKS. Écarts de sécurité P0 :
Studio exposé sur le LAN (choix utilisateur), `runProcess` transmet tout l'environnement
(T132). Prochaine étape recommandée : T132 puis T127 ; POC Piper en attente d'autorisation.

2026-11-04 — Sécurité P0 et registre d'outils : T132 (exécuteur unique, env minimal),
T136/T136b/T136c (Studio sur 127.0.0.1, garde Vite + hook, CSRF, Host, jeton en POST),
T127-sec (sandbox sans $HOME, entrées ffmpeg contraintes, binaires absolus), T127
(registre : 7 outils réels, 3 indisponibles ; portée projet). Revues de sécurité et
indépendante faites, défauts confirmés corrigés. Architecture de la boucle du Director
et des compositions : docs/ai/DIRECTOR-TOOL-LOOP.md, CREATIVE-COMPOSITION.md, D021
proposée. Prochaine étape : T128 (EditOperation), puis T129a (moteur de pas sans IA).


2026-11-10 — Intégration des fournisseurs IA (T137–T145, commits 958e29f..2cab916) :
mode assisté à import automatique (D010 inchangée), enveloppe budgétaire stricte par
production pour anthropic-api et openai-api (D022), couche de capacités et /settings en
cartes, openai-api préparé (indisponible sans tarif sourcé), codex-chatgpt préparé et
désactivé (ambiguïté contractuelle acceptée par l'utilisateur, D023). Recherches :
docs/research/AI-PROVIDER-INTEGRATIONS.md, OPENAI-CODEX-INTEGRATIONS.md,
LOCAL-AI-AND-CHATGPT-APPS.md. Revues : docs/reviews/2026-11-10-provider-integration.md.
À revérifier : tarifs (grille locale), comportement réel de `codex exec` et de
`codex login status` à l'installation. Prochaine étape : T128 puis T129a.

2026-11-11 — T129a (boucle d'outils sans IA, D026) faite, non commitée, non relue :
contrats `packages/schemas/src/loop.ts`, moteur `apps/studio/src/lib/server/tool-loop.ts`
dans la phase `plan` d'un run, migration additive 0008 `loop_steps`, `Orchestrator.wake`.
Preuves et prérequis exacts de T129b : [TASKS](../docs/TASKS.md) (T129a, T129b).
Prochaine étape : revue indépendante de T129a, puis T129b.

2026-11-11 — T146 (limites fournisseurs, fournisseur par projet D024), T147 (POC
`codex-chatgpt` démontré réellement : Codex 0.167.0 npm épinglé, CODEX_HOME dédié,
connexion ChatGPT de l'utilisateur, schéma strict), T128 (EditOperation,
`revision.apply`, D025), T129a (boucle d'outils sans IA, D026), T148 (suites des revues
du 2026-11-11, rapport dans docs/reviews/). Statut contractuel Codex toujours AMBIGU
(accepté par l'utilisateur). Chemins Codex fournis par `VEYRA_CODEX_COMMAND` et
`VEYRA_CODEX_HOME` (voir RUNBOOK). Prochaine étape : T129b (Director IA) selon ses
prérequis dans TASKS, après décision sur D021.
