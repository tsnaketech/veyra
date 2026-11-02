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
[SKILLS-STRATEGY](../docs/ai/SKILLS-STRATEGY.md). **À revérifier en reprise** : le
FFmpeg 9.0.2 de `/usr/local/bin` (sans libx264 ni PNG) casse le rendu et les tests
(T100) ; tant qu'il n'est pas corrigé, lancer les tests avec `PATH=/usr/bin:$PATH`.
POC qc-skill (T102) bloqué : exécution de code externe refusée par l'environnement.
Prochaine étape : T100, puis T095 (cause reproduite).
