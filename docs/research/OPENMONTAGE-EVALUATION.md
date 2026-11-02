# Évaluation d'OpenMontage pour Veyra

Statut : audit préliminaire, 2026-11-01. Aucune intégration, aucun code importé,
aucune dépendance OpenMontage installée ni exécutée. **Ce document n'est pas un
avis juridique** : les points de licence sont des constats et des questions à
soumettre à un avocat spécialisé.

## 1. Synthèse et recommandation

> Mise à jour du 2026-11-02 : Veyra est désormais destiné à un usage personnel et
> local. La conclusion a été réévaluée par un prototype réel (scénario A) et une
> analyse de l'effort du scénario B : voir la **partie 2** (sections 12 à 19).
> La recommandation reste de garder Veyra comme moteur ; la licence n'est plus le
> motif principal.


**Recommandation : conserver Veyra comme moteur, ne pas intégrer de code
OpenMontage, et combler les manques de Veyra en appelant directement les
bibliothèques amont qu'OpenMontage enveloppe (faster-whisper, Piper, librosa,
filtre FFmpeg `loudnorm`).** Scénario 2 sous sa forme « idées et dépendances
amont », pas sous forme d'adaptateur OpenMontage.

Raisons, toutes vérifiées dans le code (section 9) :

1. **OpenMontage n'est pas un moteur appelable.** L'orchestration est écrite en
   prompts pour un agent LLM interactif lancé dans son dépôt
   (`AGENT_GUIDE.md:80` : « Python = tools + persistence. No orchestration
   logic… »). Pas de CLI de production, pas d'API d'édition, pas de reprise
   partielle par scène ou par frame. Seuls des outils Python isolés sont
   appelables sans agent.
2. **Ce qui fait la différence de Veyra n'existe pas chez OpenMontage** :
   révisions immuables, commentaires frame par frame transformés en patchs
   structurés, vérification avant/après mesurée (PSNR, volume), QA qui sépare
   mesuré / jugement IA / non réalisé, ancrage audio sur événements visuels,
   rendu HyperFrames figé et isolé, mode `claude-subscribe` assisté.
3. **Les doublons sont moins sûrs que Veyra** : rendu HyperFrames par
   `npx --yes hyperframes` non figé, GSAP chargé depuis un CDN, pas de sandbox ;
   mixeur FFmpeg sans `-protocol_whitelist`, sans timeout, avec des valeurs non
   validées dans le graphe de filtres ; exécution de code Python produit par le
   LLM (`math_animate`).
4. **Licence : l'AGPL-3.0 ferme la réutilisation du code dans un produit
   commercial hébergé**, et l'achat d'une licence commerciale est peu réaliste :
   la CLA n'a existé qu'un jour (2026-07-18 → 2026-07-19) et environ 77 auteurs
   n'ont rien signé.
5. **Le vrai gain de temps est dans les briques amont**, pas dans OpenMontage :
   les outils intéressants (transcription mot à mot, TTS local, beats,
   normalisation) sont de fines enveloppes de bibliothèques sous licences
   permissives ou de filtres FFmpeg.

Décision proposée : D020 « Pas d'intégration d'OpenMontage ; capacités
manquantes par dépendances amont isolées » (à inscrire dans DECISIONS après
validation).

## 2. Périmètre et méthode

| Élément | Valeur |
|---|---|
| Dépôt | https://github.com/calesthio/OpenMontage |
| Commit examiné | `195eab24478dc9363326aec437aefc3701635ddf` (2026-10-28, merge #867) |
| Taille | 500 commits, 594 fichiers Python (~152 000 lignes), 143 fichiers de tests (~1 483 fonctions de test), 168 Mo |
| Copie | Clone isolé dans le scratchpad de session, traité comme donnée non fiable |
| Exécution | Aucune : ni pip, ni npm, ni test, ni rendu. Lecture, `grep`, `git log/show` ; lecture JSON du lockfile avec `python3 -I` |
| Veyra | Commit `3ad6a73` (v0.3 phase E) et corrections de revue non commitées ; aucun fichier de code modifié |

Agents de développement (sous-agents Claude Code, contexte neuf, lecture seule) :
Architecture, Video Pipeline, Audio, Licensing & Security, puis Independent
Reviewer qui a vérifié 13 affirmations décisives (9 confirmées, 4 partielles,
0 infirmée). Les instructions contenues dans `AGENTS.md`, `CLAUDE.md`,
`AGENT_GUIDE.md` et `skills/` d'OpenMontage ont été analysées comme du contenu,
jamais suivies.

## 3. Ce qu'est réellement OpenMontage

- **Pilotage** : un agent LLM extérieur (Claude Code, Codex, Cursor…) suit
  `AGENT_GUIDE.md` et des skills Markdown ; l'« Executive Producer » est un rôle
  de prompt (`skills/pipelines/explainer/executive-producer.md`).
- **Manifestes** : 13 pipelines YAML (`pipeline_defs/`), validés par jsonschema
  (`lib/pipeline_loader.py`), sériels, budget en USD déclaratif.
- **Checkpoints** : un JSON par étape, écriture atomique, historique, portes
  d'approbation humaine (`lib/checkpoint.py:284-346, 468-494, 552-566`). La
  reprise prend la première étape non terminée (`:627-640`). **Aucune
  invalidation des étapes aval** lors d'un renvoi en arrière : seul le texte des
  skills l'annonce.
- **Outils** : contrat `BaseTool` / `ToolResult` (`tools/base_tool.py:133-145,
  409-510`), découverte par import de tout `tools/` (`tools/tool_registry.py:118-131`),
  `.env` chargé dans l'environnement à l'import (`tools/base_tool.py:25-61`).
  Appelables sans agent : `registry.get(name).execute({...})`, démontré par
  `scripts/kling_official_animated_explainer_e2e.py` et `tests/qa/test_08_end_to_end.py`.
- **Rendu** : Remotion (`remotion-composer/`, imposé par documentary-montage),
  HyperFrames (`tools/video/hyperframes_compose.py`), FFmpeg ; plus Manim,
  Blender, Three.js, Mermaid.
- **Génération** : environ 100 outils, presque tous vers des fournisseurs payants
  à clé (fal, Kling, Atlas, HeyGen, Runway, Sora, Veo, ElevenLabs, Suno…).
- **Backlot** : tableau de bord FastAPI en lecture seule (routes GET/SSE,
  loopback, sans authentification).
- **Pas** de serveur MCP, d'API REST d'écriture ni de service cloud propre.

## 4. Matrice des fonctionnalités

Maturité : T = testé avec FFmpeg réel en CI ; M = tests mockés ou de contrat ;
N = non testé ; L = local ; P = fournisseur payant.

| Capacité | OpenMontage | Veyra | Doublon | Valeur pour Veyra |
|---|---|---|---|---|
| Orchestration | Agent LLM + prompts ; checkpoints JSON | Orchestrateur TS persisté, phases validées Zod, parallélisme, budget appliqué (D019) | Oui | Nulle ; conflit de maîtrise |
| Brief → storyboard | Étapes research/proposal/script/scene_plan par LLM | `generateStoryboard`, registre de composants versionné | Partiel | Faible (idées de structure éditoriale) |
| Rendu HyperFrames | `npx --yes` non figé, GSAP CDN, sans sandbox ; rendu réel seulement en QA optionnelle | 0.8.214 figé, bwrap sans réseau, rendus réels testés | Oui | Faible (idée : appeler `validate`/`inspect`) |
| Rendu Remotion | `remotion-composer`, non testé en CI ; L | Aucun | Non | Bloquée : licence Remotion et pile React |
| Composants animés | Squelette HTML « Phase 1 » | Registre de 5 composants + `visualTimeline` | Oui | Nulle |
| Génération vidéo/image IA | ~40 outils ; M ; P | Aucune | Non | Hors périmètre (coût, CGU) |
| Coupe / concaténation / sous-titres incrustés | `video_compose`, `video_stitch`, `video_trimmer` ; T partiel ; L | Partiel (`packages/video`) | Partiel | Moyenne, à réécrire en TS |
| Sonde et revue finale | `_run_final_review`, `visual_qa` (images noires, occultation des sous-titres) ; M/T ; L | Probe, contrôles déterministes, rapport QA | Oui | Faible (idées de contrôles) |
| Vérification des corrections avant/après | Absente | PSNR et volume mesurés, verdicts par commentaire | — | — |
| Mesuré / IA / non réalisé | Absente | `analysisMode`, `not-performed` | — | — |
| Heuristiques de plan | `slideshow_risk`, `variation_checker` ; M ; L | Absentes | Non | Moyenne (règles simples à porter) |
| Profils de format | `lib/media_profiles.py` | Schémas de format | Partiel | Moyenne (table de valeurs) |
| Mixage, fondus, boucle, mux | `audio_mixer` ; T ; L ; moins sûr | `packages/audio` (argv, whitelist, prlimit, timeouts) | Oui | Nulle |
| Ducking | Compresseur sidechain automatique | Fenêtres explicites | Partiel | Faible (option) |
| Normalisation de loudness | `loudnorm` une passe ; test de chaîne seulement | Limiteur true-peak, `targetLufs` en QA seulement | **Manque** | Moyenne : filtre FFmpeg natif |
| Ancrage audio sur événements visuels | Absent | `resolveAudioComposition` | — | — |
| Détection de beats | Script de skill librosa (non testé) ; BMTS-Lite AGPL-only externe | Absente (`detectOnsets` = fins de silence) | **Manque** | Élevée, via librosa directement |
| TTS local | `piper_tts` (expérimental, test de statut) | Absent (volontaire) | **Manque** | Élevée si optionnel |
| TTS payants | ~17 fournisseurs ; M ; P | Absents | Non | Exclus (pas de TTS payant obligatoire) |
| Transcription mot à mot | `tools/analysis/transcriber.py` (faster-whisper) ; M | Absente | **Manque** | Élevée (sous-titres, ancres sur mots, QA voix) |
| Sous-titres SRT/VTT | `tools/subtitle/subtitle_gen.py` ; tests purs | Absents | **Manque** | Moyenne ; logique triviale à réécrire |
| Musique générée / recherchée | Payants, ComfyUI local lourd ; scraping Pixabay | Import de fichiers | Non | Exclue (téléchargement non vérifié) |
| Banque SFX | 19 MP3 Pixabay sans provenance par fichier | Catégorie `sfx` sans banque | Manque | À ne pas reprendre |
| Doublage / lip-sync | Pipeline par prompts ; Wav2Lip (non commercial) | Absent | Non | Faible |
| Commentaires frame par frame → correction | Aucun ; constats en texte libre, re-rendu complet | Patchs structurés, révision enfant, image réutilisée | — | — |
| Mode assisté sans appel modèle | Incompatible : l'intelligence est l'agent interactif | `claude-subscribe` (D010) | — | — |

## 5. Cartographie des modules réutilisables

| Module OpenMontage | Rôle | Réutilisable ? | Forme recommandée |
|---|---|---|---|
| `tools/analysis/transcriber.py` | faster-whisper, horodatage par mot | Oui, par l'amont | Appeler faster-whisper (MIT) dans un processus isolé, poids locaux, hors ligne |
| `tools/audio/piper_tts.py` | TTS local | Oui, par l'amont | Binaire `piper` en argv ; vérifier la licence du code (fork GPL) et de chaque voix |
| `.agents/skills/music-to-video/scripts/analyze-beatgrid.py` | Grille de beats | Idée seulement (origine incertaine) | librosa (ISC) directement |
| `tools/audio/audio_mixer.py` (`loudnorm`) | Normalisation | Idée seulement | Filtre FFmpeg `loudnorm` deux passes dans `packages/audio` |
| `tools/subtitle/subtitle_gen.py` | SRT/VTT, karaoké | Idée seulement | Réécriture TS (quelques dizaines de lignes) |
| `tools/analysis/visual_qa.py` | Images noires, occultation des sous-titres | Idée seulement | Contrôles supplémentaires dans `packages/video` |
| `lib/slideshow_risk.py`, `lib/variation_checker.py` | Heuristiques de plan | Idée seulement | Règles portées dans la QA du storyboard |
| `lib/media_profiles.py` | Profils de format | Données factuelles | Table de formats dans `config/formats.yaml` |
| `lib/checkpoint.py`, `pipeline_defs/`, `skills/` | Orchestration | Non | — (doublon de D019, conflit de maîtrise) |
| `tools/video/hyperframes_compose.py`, `remotion-composer/` | Rendu | Non | — (doublon moins sûr ; Remotion sous licence propre) |
| Assets (SFX, avatars, logos, masques, démos) | Médias d'exemple | Non | Provenance absente ou licence restrictive |

« Idée seulement » : s'inspirer du comportement sans copier l'expression du code ;
garder une trace écrite de la conception (approche « clean-room »).

## 6. Analyse des risques de licence

Faits (fichiers) :

- `LICENSE` : texte standard GNU AGPL v3 du 19 novembre 2007 (661 lignes, §13 à
  la ligne 540). Ni « only » ni « or later » déclaré ; aucun en-tête SPDX ni
  ligne de copyright dans les sources ; pas de champ licence dans `setup.py`.
- CLA ajoutée le 2026-07-18, supprimée le 2026-07-19 (commit `8190911`) ; elle
  visait explicitement une licence commerciale ou double. `CONTRIBUTING.md` :
  ni CLA ni DCO. ~30 auteurs avant, 47 auteurs hors mainteneur après.
- Remotion 4.0.484 : champs de licence mélangés dans le lockfile (« SEE LICENSE
  IN LICENSE.md », « UNLICENSED », « Remotion License », MIT). Aucune mention de
  la licence Remotion dans la documentation d'OpenMontage.
- Contenus tiers : polices OFL-1.1 ; skills `manimgl-best-practices` en
  CC BY-NC-SA 4.0 (non commercial) ; 92 skills tiers dont la majorité sans
  licence visible ; SFX Pixabay ; avatars, logos de marques et masques sans
  provenance ; BMTS-Lite externe en AGPL-3.0-only.
- Veyra : pas de LICENSE, paquets `private: true` sans champ licence, donc
  propriétaire par défaut.

Interprétation par mode (à confirmer juridiquement) :

| Mode | Effet probable pour Veyra | Risque |
|---|---|---|
| a. Copier du code | Œuvre dérivée : Veyra entier sous AGPL ; §13 en SaaS (source offert aux utilisateurs distants) | **Bloquant** pour un produit propriétaire |
| b. Importer comme bibliothèque | Œuvre combinée selon la lecture FSF ; même effet que a | **Bloquant** |
| c. Processus séparé, OpenMontage non modifié | Agrégat probable (§5) si l'échange reste générique (CLI/JSON) ; distribuer OpenMontage (image Docker, auto-hébergement) impose source et mentions | Moyen ; dépend du couplage |
| d. OpenMontage modifié en service réseau | §13 : publier le source modifié à tous les utilisateurs distants | Élevé ; fragilise l'argument d'agrégat |
| e. Utiliser seulement les vidéos produites | En principe hors AGPL, sauf si la sortie contient du code ou des assets d'OpenMontage | Faible côté AGPL ; restent Remotion, modèles, CGU |

Contraintes hors AGPL (connaissance générale, **non vérifiées** dans le dépôt) :
licence Remotion payante pour les entreprises au-delà d'un seuil de salariés et
offre « automator » pour les services ; CodeFormer et Wav2Lip non commerciaux ;
HunyuanVideo exclut l'UE ; LTX-Video payant au-delà d'un seuil de chiffre
d'affaires (mention dans un SKILL.md seulement) ; CGU des fournisseurs (droits
sur les sorties, revente, consentement voix/avatar) ; Pixabay interdit la
redistribution des médias tels quels.

Questions pour le juriste :

1. Le mode c reste-t-il un agrégat si Veyra pilote OpenMontage outil par outil ?
   Un correctif local, même de configuration, fait-il basculer en mode d ?
2. Où passe la limite entre une idée, un schéma JSON, un prompt et une
   expression protégée (manifestes YAML, styles, skills) ?
3. Lecture FSF ou lecture plus étroite en droit français et européen pour le
   mode b ?
4. Une licence commerciale est-elle envisageable, compte tenu des contributeurs
   non signataires ?
5. Une composition HTML produite par `hyperframes_compose` et livrée au client
   est-elle une sortie ou une copie de code AGPL ?

## 7. Proposition d'adaptateur (si un outil OpenMontage devenait nécessaire)

À ne construire que si une capacité n'existe pas en amont sous licence
permissive. Mode c strict, avec les garde-fous de Veyra :

```
apps/studio (runner audio/engine)
  └─ OpenMontageToolAdapter (TS, packages/openmontage-adapter)
       ├─ liste blanche d'outils déterministes et locaux (ex. subtitle_gen)
       ├─ entrée : JSON validé par Zod (converti depuis tool.input_schema)
       ├─ bwrap : réseau coupé, dépôt OpenMontage en lecture seule à un commit figé,
       │          venv verrouillé, environnement vidé (pas de .env), répertoire
       │          de sortie dédié sous le projet, prlimit + timeout
       ├─ processus : python -I script_maison.py < input.json > result.json
       │              (instancie un seul BaseTool, sans tool_registry)
       └─ sortie : ToolResult validé par Zod → payload de phase (enveloppe D019)
```

Règles : OpenMontage jamais modifié ni distribué avec Veyra ; aucun outil à
fournisseur, `math_animate`, `render_existing` ou téléchargement ; pas de
checkpoints OpenMontage (l'état reste dans SQLite) ; mise à jour = nouveau commit
figé + revue de sécurité + tests de contrat.

Commentaires frame par frame : OpenMontage n'a ni patch structuré ni re-rendu
partiel. Veyra garderait toute la boucle (commentaire → plan → patch → révision
enfant) et ne déléguerait que l'exécution d'un outil sur la révision entière.

## 8. Scénarios comparés

Estimations en jours-développeur, à ±50 %, sur l'hypothèse d'un développeur
connaissant Veyra ; elles ne comptent ni l'avis juridique ni les achats de
licences.

| Critère | 1. Veyra seul | 2. Intégration sélective | 3. OpenMontage moteur principal |
|---|---|---|---|
| Contenu | Combler les manques avec les bibliothèques amont | Adaptateur OpenMontage (section 7) pour 1 à 3 outils | Agent LLM dans le dépôt OpenMontage ; Veyra comme interface |
| Effort initial | ~12–20 j : transcription mot à mot + SRT/VTT (4–6), TTS Piper optionnel (3–5), beats librosa et ancres « beat » (3–5), `loudnorm` deux passes (1–2), contrôles QA supplémentaires (1–2) | ~15–25 j pour l'adaptateur et sa sandbox, plus le travail du scénario 1 qu'il ne remplace pas (les outils utiles enveloppent les mêmes bibliothèques) | ~40–80 j : réécrire la boucle de revue, la QA et les révisions autour de checkpoints sans invalidation ; synchroniser deux états ; sandboxer un agent avec shell |
| Maintenance | Faible : dépendances amont figées | Moyenne : suivre un dépôt très actif sans API stable, revue de sécurité à chaque montée | Élevée : comportement défini par des prompts qui changent sans changer le code |
| Licence | Aucune contrainte AGPL | Mode c : risque moyen, avis juridique requis | Modes c/d et Remotion : risque élevé |
| Sécurité | Garanties Veyra conservées | Acceptable seulement avec la sandbox complète | Exécution de code LLM, rendu non isolé, `.env` global |
| claude-subscribe | Inchangé | Inchangé (outils déterministes seulement) | Cassé : l'intelligence est l'agent interactif |
| Différenciation | Conservée | Conservée | Perdue (revue frame par frame, QA mesurée, révisions) |
| Gain de temps réel | Base de référence | Négatif ou nul | Négatif |

## 9. Preuves et vérification indépendante

| # | Affirmation | Verdict | Preuve principale |
|---|---|---|---|
| C1 | Pas de CLI ni d'orchestrateur ; pilotage par agent | Confirmé (outils appelables sans agent) | `AGENT_GUIDE.md:80`, `setup.py`, `backlot/server.py:171-215` ; contre-preuve partielle : `scripts/kling_official_animated_explainer_e2e.py:300-420` |
| C2 | Pas d'invalidation aval des checkpoints | Confirmé | `lib/checkpoint.py:627-640` |
| C3 | HyperFrames non figé, GSAP CDN, sans sandbox | Confirmé | `tools/video/hyperframes_compose.py:1363, 1247` |
| C4 | Pas de rendu HyperFrames/Remotion en CI | Partiel : FFmpeg réellement testé en CI ; scripts `tests/qa/test_04..08` sans assertion, exécutés à la collecte | `.github/workflows/ci.yml`, `tests/qa/test_09_hyperframes_compose.py:106,151` |
| C5 | Graphe de filtres non validé, pas de whitelist | Partiel : `timeout` existe mais n'est pas utilisé | `tools/audio/audio_mixer.py:255-275`, `tools/base_tool.py:633-675` |
| C6 | Exécution de code Python produit par le LLM | Confirmé | `tools/graphics/math_animate.py:38, 42-71, 129, 283` |
| C7 | CLA supprimée, contributeurs non signataires | Confirmé (CLA d'un jour) | `git show 8190911`, `CONTRIBUTING.md:3` |
| C8 | AGPL v3 standard, pas de « or later » | Confirmé | `LICENSE`, `README.md:30,757` |
| C9 | Licences Remotion mélangées | Confirmé | `remotion-composer/package-lock.json` |
| C10 | `.env` chargé à l'import, import de tout `tools/` | Confirmé | `tools/base_tool.py:25-61`, `tools/tool_registry.py:118-131` |
| C11 | faster-whisper mot à mot ; Piper en argv ; Pixabay sans liste d'hôtes | Partiel (chemin corrigé ; téléchargement des poids = comportement de la bibliothèque, non vérifié) | `tools/analysis/transcriber.py:157-167`, `tools/audio/piper_tts.py:123`, `tools/audio/pixabay_music.py:322-355` |
| C12 | Veyra : pas de LICENSE ; limiteur sans `loudnorm` ; HyperFrames figé et isolé | Confirmé | `packages/audio/src/mixing.ts:73`, `packages/hyperframes-adapter/package.json:21`, `sandbox.ts:84` |
| C13 | Même format de composition HyperFrames | Confirmé (identifiant racine et GSAP local différents) | `packages/hyperframes-adapter/src/compose.ts:116-132`, `hyperframes_compose.py:1247-1260` |

Autres constats de la revue indépendante : historique de correctifs de sécurité
récents (CVE nanoid `cbf3962`, injection `os.system` dans des templates
`85a6347`, correctif fusionné depuis un fork privé `53e34e6` le 2026-10-28) et
pas de `SECURITY.md` ; dossiers d'instructions d'agents (`.claude/`, `.agents/`,
`.codex/`, `.cursor/`, `.windsurfrules`) chargés automatiquement par les outils
de code, à isoler en cas de copie.

## 10. Hypothèses et limites

- Rien n'a été exécuté : maturité déduite de la lecture et des tests présents.
- Licences de Remotion, des poids de modèles et des voix, CGU des fournisseurs :
  connaissance générale, non vérifiée ; empreinte du fichier LICENSE non
  comparée à la FSF ; branche `cla-signatures` non inspectée.
- Contournement effectif du filtre de `math_animate` non testé.
- Estimations de charge indicatives (section 8).
- Snapshot à un commit d'un projet très actif : à réévaluer si OpenMontage
  publie une API stable, une offre de licence ou une version figée.

## 11. Fichiers OpenMontage examinés

Racine : `LICENSE`, `README.md` (licence, statut), `AGENT_GUIDE.md`, `CLAUDE.md`,
`CONTRIBUTING.md`, `setup.py`, `requirements*.txt`, `Makefile`, `render_demo.py`,
`render-demo.sh`, `.gitattributes`, `.github/workflows/ci.yml`.
`lib/` : `pipeline_loader.py`, `checkpoint.py`, `events.py`, `paths.py`,
`env_loader.py`, `media_profiles.py`, `scoring.py`, `slideshow_risk.py`,
`variation_checker.py`, `verify_scene_pacing.py`, `hyperframes_style_bridge.py`.
`tools/` : `base_tool.py`, `tool_registry.py`, `google_credentials.py`,
`atlas_client.py`, `provider_jobs.py` ; `video/hyperframes_compose.py`,
`video/video_compose.py`, `video/bmts_lite.py`, `video/bmts_lite_runner.py`,
`video/pixabay_video.py`, `video/stock_sources/*` ; `audio/audio_mixer.py`,
`audio_enhance.py`, `piper_tts.py`, `music_library.py`, `pixabay_music.py`,
`freesound_music.py`, `comfyui_music.py`, `tts_selector.py`, `music_gen.py`,
`mai_tts.py`, `kling_tts.py`, `azure_tts.py` ; `analysis/transcriber.py`,
`audio_energy.py`, `audio_probe.py`, `visual_qa.py`, `composition_validator.py`,
`video_understand.py`, `video_downloader.py` ; `subtitle/subtitle_gen.py` ;
`graphics/math_animate.py`, `blender_world.py`, `threejs_asset_catalog.py`,
`local_diffusion.py`, `pixabay_image.py`, `openai_image.py` ;
`avatar/lip_sync.py` ; `enhancement/*` ; `_comfyui/client.py`.
`pipeline_defs/*.yaml` (13, dont `animated-explainer.yaml`,
`framework-smoke.yaml`, `localization-dub.yaml` en entier).
`schemas/checkpoints/checkpoint.schema.json`, `schemas/artifacts/__init__.py`
et les schémas `brief`, `script`, `scene_plan`, `edit_decisions`,
`asset_manifest`, `review`, `final_review`, `render_report`.
`skills/pipelines/explainer/executive-producer.md`,
`skills/meta/checkpoint-protocol.md`, `skills/core/hyperframes.md` (recherche),
`.agents/skills/*/SKILL.md` (champ licence), `.agents/skills/manim*/LICENSE.txt`,
`.agents/skills/hyperframes-media/assets/sfx/CREDITS.md`,
`.agents/skills/music-to-video/scripts/analyze-beatgrid.py` (en-tête).
`backlot/server.py`, `backlot/__main__.py` ; `remotion-composer/package.json`,
`package-lock.json`, `src/Root.tsx`, `src/fonts/*` ; `ink-theater/THIRD_PARTY_NOTICES.md`.
`docs/bgm-montage-lite.md`, `docs/PROVIDERS.md` (extraits).
`scripts/kling_official_animated_explainer_e2e.py`, `scripts/backlot_simulate_run.py`.
`tests/conftest.py`, `tests/test_network_guard.py`, `tests/qa/*`,
`tests/tools/test_hyperframes_compose.py`, `test_audio_mixer_*.py`,
`test_subtitle_timestamps.py`, `test_transcriber_device_selection.py`,
`test_music_library.py`, `tests/contracts/test_phase3_contracts.py`.
Commits : `195eab2` (examiné), `8190911` (suppression de la CLA), `53e34e6`,
`cbf3962`, `85a6347` (correctifs de sécurité), `git log` et `git shortlog`.

---

# Partie 2 — Prototype fonctionnel (2026-11-02)

Contexte : Veyra devient un outil personnel et local. Pour un usage privé sans
distribution ni service offert à des tiers, les obligations de l'AGPL (§4–6
distribution, §13 réseau) ne sont en principe pas déclenchées
(interprétation, pas un avis juridique). La question devient donc purement
technique : OpenMontage fait-il gagner du temps ?

Choix de l'utilisateur après le scénario A : **option 3**, le scénario B est
réduit à une évaluation de l'effort d'adaptation ; aucun adaptateur n'est
développé et le moteur Veyra n'est pas modifié.

## 12. Scénario A — production réelle avec OpenMontage

### Environnement

| Élément | Valeur (mesurée) |
|---|---|
| Laboratoire | `/home/user/project/openmontage-lab/` (hors du dépôt Veyra, conservé) |
| OpenMontage | Clone séparé, HEAD détaché `195eab24478dc9363326aec437aefc3701635ddf`, source non modifiée (`git status` : seuls des fichiers ignorés) |
| Python | venv créé par `uv` 0.12.3 (pas d'`ensurepip` sur l'hôte), Python 3.11.2 système |
| Dépendances Python | `uv pip install --only-binary :all: -r requirements.txt` : 46 paquets, roues uniquement, 1,4 s ; versions non verrouillées (`pip-freeze.txt`) |
| Node | `npm install --ignore-scripts --save-exact hyperframes@0.8.214 gsap@3.14.2` : 126 paquets, 3,2 s |
| Non installé | `remotion-composer` (npm), `piper-tts`, dernière version npx d'HyperFrames, `.env` |
| Isolation | `bin/sbx` : `bwrap --unshare-all` (réseau seulement pour pip/npm), `--clearenv`, HOME en tmpfs, `/usr` et `/etc` en lecture seule, seul le labo en écriture, cache Chrome d'HyperFrames en lecture seule, `timeout` + `prlimit --cpu=3600 --fsize=4G --nproc=4096` |
| Exécution | `bin/omtool <outil> <in.json> <out.json>` : `python -I runner/run_tool.py` dans `sbx`, réseau coupé, liste blanche de 12 outils locaux, refus si `.env` présent, import d'un seul module (pas de `tool_registry.discover()`) ; `bin/omcp` pilote `lib/checkpoint.py` |

### Déroulé (pipeline `animated-explainer`, mécanismes officiels uniquement)

| Étape | Mécanisme | Rédigé par l'agent | Outils exécutés | Résultat |
|---|---|---|---|---|
| research | `write_checkpoint` | research_brief (sources locales `file://`) | — | completed |
| proposal | porte d'approbation (`GATE VIOLATION` vérifiée) | proposal_packet, decision_log | `hyperframes_compose` doctor ; état `tts_selector` et `image_selector` : **indisponibles** | completed |
| script, scene_plan | portes d'approbation | script, scene_plan (4 scènes) | — | completed |
| assets | porte d'approbation | asset_manifest | `audio_probe`, `scene_detect`, `frame_sampler`, `video_trimmer`, `music_library`, `audio_mixer` | narration et images générées impossibles hors ligne et sans clé |
| edit | `write_checkpoint` | edit_decisions (HyperFrames, mode « atelier ») | — | completed |
| compose | `video_compose` → `hyperframes_compose render_existing` (`check` puis `render --strict`) + revue finale | `index.html` (2 corrections après `check`) | `hyperframes_compose` check ×4, `scaffold_workspace`, `video_compose` | final_review « pass » |
| publish | porte d'approbation | — | `export_bundle` | exporté |

Temps mesurés (`logs/timings.txt`) : outils 0,1–1,4 s chacun ; `check` 5,1 s ;
**rendu 50,7 s** (42,4 s côté HyperFrames) ; pipeline complet environ 6 min,
surtout de la rédaction. 9 outils OpenMontage exécutés, 2 seulement interrogés.

Résultat : `projects/om-lab-a/renders/final.mp4`, vérifié indépendamment par le
Lead : h264 1920×1080, 30/1 i/s, 600 images, 20,00 s ; aac 48 kHz stéréo
20,01 s ; 7,7 Mo. Frames examinées à 6,8 s (rail des 8 étapes) et 12 s (média
importé `demo-audio.mp4` 3 → 9 s dans un cadre, trois étiquettes) : rendu net.
Défaut visuel mineur : léger rectangle autour de l'étiquette « Média importé ».

### Limites constatées pendant l'exécution

- La génération HyperFrames standard (`scaffold_workspace`) écrit GSAP depuis un
  CDN : `check` réseau coupé échoue (`ERR_INTERNET_DISCONNECTED`). Contournement
  officiel : mode « atelier » avec un `gsap.min.js` local.
- Le blocage d'HyperFrames sur 0.8.214 tient seulement à la présence de
  `node_modules` dans un dossier parent ; le contrôle d'OpenMontage annonce
  0.8.229 (cache npm) alors que 0.8.214 s'exécute.
- `audio_mixer` échoue avec ffmpeg 5.1 (Debian 12) quand une entrée est un AAC
  dans un MP4 (`loudnorm` + `aresample` : « Cannot select channel layout ») :
  entrée convertie en WAV 48 kHz. `loudnorm` en une passe : −15,3 LUFS pour une
  cible de −16. L'opération `extract` force du 16 kHz mono.
- Le schéma `edit_decisions` interdit `type` et `text` dans les cuts que le
  générateur HyperFrames lit : un fichier valide affiche le champ `reason`.
- La revue finale déclare `narration_present: true` sans voix et conclut
  « pass » sans comparer la transcription au script.
- Les portes d'approbation sont un booléen écrit par l'agent lui-même.
- `doctor` renvoie `success: true` même quand Chrome ne démarre pas.
- Le README annonce recherche web, images générées, narration, musique trouvée
  et sous-titres : **rien de cela ne s'exécute hors ligne et sans clé**.

## 13. Contrôle audio du rendu du scénario A

Mesures FFmpeg (`ebur128`, `astats`, `silencedetect`, `volumedetect`) du
2026-11-02. **Aucune écoute humaine n'a été réalisée** ; ces mesures ne
remplacent pas une écoute.

| Mesure | Valeur | Lecture (seuils de `config/audio.yaml` de Veyra) |
|---|---|---|
| Loudness intégrée | −15,3 LUFS | Dans la cible −16 ± 3 |
| Plage de loudness (LRA) | 8,0 LU | Variation marquée entre sections |
| Crête vraie | −1,1 dBTP | Sous la limite d'écrêtage −0,1 ; 2 échantillons au maximum, facteur de plateau 0 : pas d'écrêtage |
| RMS global | −17,5 dB | — |
| Plancher de bruit | −52,2 dB | — |
| Décalage DC | −0,000026 | Négligeable |
| Silences (< −50 dB, ≥ 0,3 s) | Aucun | Pas de trou |
| Volume moyen 0–3 / 3–8 / 8–15 / 15–20 s | −17,9 / −17,5 / −15,6 / −22,0 dB | Section du média importé plus forte de ~2 dB ; clôture plus basse de ~4–6 dB |
| Début (0,2 s) / fin (dernière seconde) | −37,6 / −33,9 dB | Fondus d'entrée et de sortie présents |
| Différence gauche − droite | moyenne −54,8 dB, max −10,5 dB | Contenu quasi mono |
| Durées | vidéo 20,000 s, audio 20,010 s | Écart 10 ms, sous la tolérance 100 ms |

Anomalies techniques : aucune bloquante. À signaler : contenu quasi mono, chute
de niveau de la clôture, normalisation à une passe. Qualité perçue, équilibre
musique/média et intelligibilité : **non évalués** (pas d'écoute).

## 14. Scénario B — effort d'adaptation (non implémenté)

Constat de départ : OpenMontage **n'a aucun outil d'édition ciblée**. La
composition modifiable est le `index.html` rédigé par l'agent ; la « correction »
consiste à éditer ce fichier puis à **re-rendre toute la vidéo**
(`render_existing`). Les checkpoints n'invalident pas les étapes aval
(`lib/checkpoint.py:627-640`). Veyra fait déjà nativement commentaire → plan →
patch → révision enfant → re-rendu, avec vérification avant/après.

Changements nécessaires (estimations, ±50 %, jours-développeur) :

| # | Changement | Où | Estimation |
|---|---|---|---|
| 1 | Importer une vidéo externe comme révision : synthétiser un `Storyboard` depuis `scene_plan` (secondes → ms, identifiants `scn_`), copier le MP4 dans le stockage, sonder `media` | `packages/schemas` (origine « externe »), `studio.ts`, action et formulaire du Studio | 1–1,5 |
| 2 | Lier la révision au projet OpenMontage (identifiant, chemin du workspace, commit figé) | `resolvedConfig` de la révision | 0,5 |
| 3 | Traduire un plan de correction (patchs de scène : texte, durée, paramètres) en modifications de `index.html` : soit par une demande assistée `claude-subscribe` (Claude Code édite le HTML, Veyra valide), soit en générant le HTML depuis un modèle maîtrisé, ce qui revient à refaire le Motion Engine | nouvelle tâche assistée ou générateur | 2–3 |
| 4 | Lancer le re-rendu dans le bac à sable (`omtool video_compose`), archiver les checkpoints aval, gérer erreurs et délais | moteur de rendu « openmontage » derrière `RenderEngine` | 1–1,5 |
| 5 | Importer la nouvelle révision enfant ; QA déterministe et vérification PSNR des corrections (fonctionnent sur tout MP4 si les scènes sont alignées) | `jobs/runner.ts`, `studio.ts` | 1 |
| 6 | Tests (dont E2E réel), revue de sécurité de l'appel inter-processus | tests Studio, adaptateur | 1–1,5 |
| | **Total** | | **≈ 7–9 jours** |

Résultat attendu : la même boucle de correction que Veyra possède déjà, mais avec
un rendu complet via OpenMontage et une étape d'édition du HTML confiée à un
LLM. Le gain fonctionnel est nul pour ce scénario ; seule la provenance du
rendu change.

## 15. Capacités absentes de Veyra et utiles en usage personnel

| Priorité | Capacité | Constat dans OpenMontage | Intérêt |
|---|---|---|---|
| 1 | Normalisation de loudness | `loudnorm` une passe dans `audio_mixer` | Niveau homogène des exports ; Veyra n'a qu'un limiteur |
| 2 | Transcription avec horodatage par mot | `tools/analysis/transcriber.py` (faster-whisper) ; non exécuté ici | Sous-titres, ancres audio sur mots, QA de la voix |
| 3 | Sous-titres SRT/VTT et incrustation | `tools/subtitle/subtitle_gen.py` (logique simple) | Accessibilité, réseaux sociaux |
| 4 | TTS local optionnel | `piper_tts.py` (expérimental) ; non exécuté (voix non téléchargée) | Voix off sans service payant |
| 5 | Détection de beats et de tempo | script de skill librosa, non testé | Synchroniser coupes et animations sur la musique |
| 6 | Contrôles QA visuels supplémentaires | `visual_qa.py` : images noires, occultation des sous-titres | Compléter les contrôles déterministes |
| 7 | Ducking automatique sur la voix | compresseur sidechain dans `audio_mixer` | Option aux fenêtres explicites de Veyra |
| 8 | Profils de format | `lib/media_profiles.py` | Formats vertical, carré, 4K prêts |

Non retenus : génération d'images ou de vidéos et musique générée (fournisseurs
payants ou GPU lourd), banque SFX sans provenance, Remotion, lip-sync
(Wav2Lip non commercial).

## 16. Bibliothèques indépendantes à réutiliser directement

Licences et versions vérifiées le 2026-11-02 sur PyPI et Hugging Face ; capacités
FFmpeg vérifiées sur l'hôte (ffmpeg 5.1.9 Debian, `--enable-gpl`,
`--enable-libass`).

| Rôle | Bibliothèque (version) | Licence vérifiée | Contraintes techniques |
|---|---|---|---|
| Normalisation | FFmpeg `loudnorm` (hôte) | FFmpeg compilé GPL (outil système, appelé en processus) | Deux passes (mesure puis application) ; aucune dépendance nouvelle ; à ajouter dans `packages/audio` |
| Ducking automatique | FFmpeg `sidechaincompress` (hôte) | idem | Disponible ; paramétrage à calibrer |
| Sous-titres incrustés | FFmpeg `subtitles` via libass (hôte) | idem | Ou rendu HTML dans la composition HyperFrames ; SRT/VTT à générer soi-même |
| Transcription par mot | faster-whisper 1.2.1 (CTranslate2 4.8.4) | MIT / MIT | Python ≥ 3.9 ; modèles `Systran/faster-whisper-*` sous MIT (non gated) ; **téléchargement des poids à faire une fois, à la main, puis chemin local et mode hors ligne** ; CPU possible (lent sur large) |
| Synthèse vocale | piper-tts 1.8.0 | **GPL-3.0-or-later** (fork `OHF-voice/piper1-gpl`) ; dépôt des voix `rhasspy/piper-voices` MIT | Appel en processus séparé (binaire `piper`) ; licence propre à chaque voix : fr_FR-siwis **CC-BY 4.0**, fr_FR-upmc **CC-BY-SA 4.0**, fr_FR-tom **AGPLv3** ; voix à télécharger manuellement |
| Beats et tempo | librosa 0.11.0 | ISC | **librosa 1.0.0 exige Python ≥ 3.12** : rester en 0.11 avec Python 3.11 ; dépend de numba (BSD), soundfile (BSD-3), soxr (**LGPL-2.1+**), audioread (MIT) |
| Inférence ONNX (Piper) | onnxruntime 1.31.1 | MIT | Python ≥ 3.11 |

Règles d'intégration communes : processus séparé en argv, bac à sable sans
réseau à l'exécution, modèles et voix stockés localement avec empreinte,
versions figées, sorties validées par Zod côté Veyra. Aucune de ces briques
n'impose OpenMontage.

## 17. Comparaison finale

Légende : **M** = mesuré dans ce projet ; **E** = estimé ; **C** = constaté à la
lecture du code.

| Critère | OpenMontage (prototype) | Veyra (existant) |
|---|---|---|
| Temps d'intégration | Labo et rendu A : une session d'agent (~14 min d'agent, M) ; scénario B : 7–9 j (E) | 0 j : déjà en place (M) |
| Fonctions réutilisées | 9 outils exécutés, dont 1 de rendu et 1 de mixage ; 5 fonctions de checkpoint (M) | — |
| Rendu | HyperFrames 0.8.214 identique ; 20 s 1080p en 50,7 s (M) | HyperFrames 0.8.214 ; parcours E2E audiovisuel complet 37,6–41,7 s (M) |
| Qualité visuelle | Composition entièrement rédigée par l'agent ; correcte (M, frames) | Registre de composants et paramètres validés (M, E2E) |
| Audio | Mix −15,3 LUFS, quasi mono, `loudnorm` une passe ; bug AAC contourné (M) | Ancres sur événements visuels à ≤ 0,1 ms, duck mesuré −11,9 dB (M) ; pas de `loudnorm` (C) |
| Corrections ciblées | Aucune : édition manuelle du HTML + re-rendu complet (C) | Commentaire frame → plan → patch → révision enfant, image réutilisée si seul le son change (M) |
| Stabilité des corrections | Non mesurable sans adaptateur | Vérification avant/après PSNR et volume (M) |
| QA | Revue finale permissive (fausse « narration présente ») (M) | Mesuré / IA / non réalisé distingués (M) |
| Dépendances | 46 paquets Python non verrouillés + 126 npm ; SDK openai/google installés (M) | Monorepo pnpm verrouillé (C) |
| Sécurité | Sûr seulement dans le bac à sable du labo ; CDN, npx non figé, `.env` à l'import, code LLM (`math_animate`) (C) | bwrap sans réseau, argv, limites de ressources (C) |
| Maintenabilité | Comportement défini par des prompts ; dépôt très actif sans API stable (C) | Contrats Zod et tests (M) |
| Interventions manuelles | 12 étapes manuelles, 5 approbations auto-écrites (M) | Validation humaine uniquement (M) |
| Ce qui fonctionne hors ligne sans clé | ffmpeg/ffprobe, checkpoints, schémas, HyperFrames figé, export (M) | Tout le pipeline (fournisseur `fake` ou assisté) (M) |

## 18. Conclusion de la partie 2

**Décision proposée : C — utiliser certaines bibliothèques indépendamment ;
garder Veyra comme moteur principal ; ne pas intégrer OpenMontage maintenant.**

- A (moteur principal) est écarté : OpenMontage n'a ni édition ciblée ni QA
  fiable, et toute sa partie créative est rédigée par l'agent.
- B (moteur complémentaire) coûterait 7–9 jours (E) pour reproduire une boucle
  que Veyra possède déjà, avec un rendu par le même HyperFrames.
- D n'est pas nécessaire : l'expérience a identifié des briques utiles, que l'on
  peut prendre en amont d'OpenMontage.

Ce qui changerait la décision : une API d'édition ou de re-rendu partiel dans
OpenMontage, un besoin fort de génération d'images ou de vidéos par
fournisseurs, ou l'adoption de Remotion.

Fonctionnalités à récupérer, par priorité (sans l'architecture OpenMontage) :

1. Normalisation `loudnorm` deux passes dans `packages/audio` (FFmpeg seul).
2. Transcription par mot avec faster-whisper, en processus isolé, modèles locaux.
3. Sous-titres SRT/VTT générés depuis la transcription, incrustés dans la
   composition HyperFrames.
4. Voix off locale Piper optionnelle (voix CC-BY choisie, attribution).
5. Détection de beats librosa 0.11 et ancres audio « beat » / « mot ».
6. Contrôles QA visuels : images noires, occultation des sous-titres.
7. Ducking automatique `sidechaincompress` en option.
8. Profils de format supplémentaires.

## 19. Limites de la partie 2

- Aucune écoute humaine du rendu ; aucun test de Piper, faster-whisper,
  librosa ou Remotion (non installés).
- Le scénario B n'a pas été exécuté : son coût est une estimation.
- Les durées d'agent dépendent du modèle et ne sont pas des durées humaines.
- Le laboratoire n'est pas versionné ; il reste en place pour vérification.
