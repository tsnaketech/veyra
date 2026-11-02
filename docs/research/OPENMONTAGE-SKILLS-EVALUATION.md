# Évaluation des skills créatifs d'OpenMontage pour Veyra

Statut : recherche et expérimentation, 2026-11-02. Aucun skill Veyra modifié,
aucun moteur, composant ni migration touchés. Les documents OpenMontage ont été
analysés comme des données non fiables (AGPL-3.0) ; aucune de leurs instructions
n'a été suivie et aucun extrait n'est recopié ici (principes reformulés).

## 1. Résultat en bref

**Décision recommandée : B — enrichir certains skills existants**, de façon
ciblée : quelques règles de récit dans `prompt-to-video` et les consignes du
storyboard, avec une règle explicite contre les textes provisoires à l'écran.
Ne pas créer de nouveaux skills créatifs maintenant, ne pas reprendre les
documents OpenMontage.

Résultats exploratoires de l'A/B (3 essais par variante, un seul relecteur, sur
images fixes, sans écoute) :

- Les principes OpenMontage ont **changé la structure** de façon nette et
  reproductible (3/3) : accroche par une question-problème, enchaînement
  « problème → réponse », appel à l'action qui reprend l'accroche.
- Note subjective moyenne : **A 3,22 contre B 2,75** sur 5. B gagne sur le récit
  (3,67 contre 3,33) mais perd sur la cohérence (3,00 contre 4,00), la lisibilité
  (3,00 contre 4,00) et le respect du brief (1,67 contre 3,67).
- Les pertes viennent de deux règles du bloc B : « alterner align » (mises en page
  déséquilibrées, grands vides) et « exemples signalés à remplacer » (mentions
  « (exemple à remplacer) » **affichées à l'écran** dans 3 vidéos B sur 3).
- L'originalité est notée 2/5 partout : elle est limitée par le moteur (fond en
  dégradé fixe, registre de 5 composants), pas par les consignes.
- La revue a révélé des **défauts moteur communs aux deux variantes** (section
  8), dont un « flash » du titre vérifié image par image.

## 2. Vérification préalable

| Point | Constat |
|---|---|
| Consignes lues | `AGENTS.md`, `CLAUDE.md`, `docs/DECISIONS.md`, `docs/TASKS.md` |
| Skills Veyra | `.agents/skills/` : prompt-to-video, video-rendering, video-review, video-quality-assurance, veyra-assisted-task, audio-production, audio-mixing (+ skills HyperFrames vendorisés : hyperframes, hyperframes-cli, hyperframes-registry, media-use, figma, slideshow, remotion-to-hyperframes) |
| Director Agent | Règles déterministes `planProduction` / `planRevisionPhases` (`packages/ai/src/agents.ts`) : il ne génère aucun contenu créatif |
| Motion Agent | Consigne `instructions.storyboard` (`packages/ai/src/index.ts:533-538`) + catalogue des composants + corps de `config/style-guide.md` ; sortie limitée à `StoryboardDraft` (`index.ts:32-47`) |
| Audio Agent | Règles `proposeAudio` (`agents.ts`) : aucun choix sonore par le LLM |
| OpenMontage | Laboratoire `/home/user/project/openmontage-lab/OpenMontage`, HEAD `195eab2` |
| Version amont | `main` récupérée dans la copie d'audit : **0 commit depuis `195eab2`** ; les 11 documents vérifiés sont identiques |

Documents demandés, tous présents au chemin indiqué (aucun déplacé ni renommé) :

| Chemin | Lignes | Dernier changement |
|---|---|---|
| `skills/meta/taste-direction.md` | 126 | `fd086a3` 2026-07-03 |
| `skills/meta/bespoke-composition.md` | 278 | `2702362` 2026-08-13 |
| `skills/creative/storytelling.md` | 189 | `fdd6457` 2026-04-28 |
| `skills/creative/sound-design.md` | 141 | `a3e735c` 2026-03-29 |
| `skills/creative/video-editing.md` | 61 | `a3e735c` 2026-03-29 |
| `skills/creative/video-gen-prompting.md` | 325 | `7c5dfdd` 2026-07-07 |
| `skills/meta/reviewer.md` | 354 | `fd086a3` 2026-07-03 |
| `skills/INDEX.md` | 329 | `26a03b8` 2026-08-18 |

Autres documents jugés pertinents par les agents : `skills/creative/typography.md`,
`short-form.md`, `music-gen-usage.md`, `cinematic.md`, `animation-pipeline.md`,
`skills/meta/creative-intake.md`, `voice-performance-director.md` (cité par les
pipelines mais **absent de `INDEX.md`**), et le skill d'agent
`.agents/skills/hyperframes-creative/references/house-style.md`.

`skills/` contre `.agents/skills/` : `skills/` contient les guides internes du
pipeline OpenMontage (directeurs d'étape, références créatives) lus par l'agent
qui pilote OpenMontage ; `.agents/skills/` contient 92 skills d'agent au format
`SKILL.md`, en grande partie tiers (HyperFrames, GSAP, Remotion…), chargés
automatiquement par les outils de code.

## 3. Cartographie des compétences

| Document | Rôle | Principes clés (reformulés) | Dépendances supposées | Déjà dans Veyra | Contradiction | Valeur |
|---|---|---|---|---|---|---|
| taste-direction | Profil de goût avant la proposition | Une phrase d'intention ; trois curseurs (variété, mouvement, densité) ; liste d'anti-défauts (dégradé violet « IA », même transition partout, slides de texte seul) | Playbooks, génération d'images, relecteur | Lisibilité, sobriété, densité bornée par les schémas | La marque Veyra impose le dégradé violet→cyan que le document classe comme défaut | Moyenne : idées de règles de choix |
| bespoke-composition | Composition écrite à la main (HTML/GSAP ou React) | Direction propre au sujet ; scènes consécutives distinctes ; dispositif signature rare | Remotion, HyperFrames CLI, GSAP, scripts | Registre de composants | **Frontale** : Veyra interdit au LLM d'écrire du HTML/JS | Faible dans Veyra ; seules « scènes distinctes » et « signature rare » se transposent |
| storytelling | Arc narratif d'explicatifs longs | Accroche typée ; lien « mais/donc » ; idée reçue avant la solution ; une idée par scène ; clôture qui reprend l'accroche | Narration, scene_plan | Une idée par scène (contrat) | Pensé pour 1–5 min et la voix | **Bonne** une fois compressé à 20 s |
| short-form (associé) | Formats courts | Accroche en 1–2 s ; blocs de texte très courts ; mise en place courte, révélation longue | Sous-titres, musique générée | CTA, durée 20 s | Vertical 9:16, CTA social | Bonne pour l'accroche et le rythme |
| video-editing | Montage de rushes | Couper tics et blancs ; coupes J/L | Transcription, rushes | — | Veyra n'a pas de rushes | Quasi nulle |
| video-gen-prompting | Prompts de modèles vidéo | Cinq aspects d'un plan | Fournisseurs payants | — | Veyra ne génère pas de pixels | Nulle |
| sound-design | Référence de mixage | Hiérarchie des niveaux, ducking, un type d'effet par type d'événement, effet légèrement en avance, LUFS de livraison | ElevenLabs (payant), FFmpeg | Ducking, effets ancrés aux événements, QA mesurée | Génération et TTS exclues | Moyenne, mais **pour l'Audio Agent** (règles), pas pour le LLM |
| reviewer | Revue par l'agent | Contrôle de « distinctness » obligatoire | Agent | QA déterministe et expertise | Autovalidation par l'agent | Faible (idée de contrôle) |

## 4. Protocole A/B

| Élément | A — Veyra actuel | B — Veyra + principes OpenMontage |
|---|---|---|
| Brief | Identique (fichier `brief.txt`) | Identique |
| Moteur | Studio Veyra `ddc5aff` (build unique), HyperFrames 0.8.214 | Identique |
| Fournisseur | `claude-subscribe`, workflow assisté officiel : export `request.json`, traitement par une session Claude Code neuve suivant le skill `veyra-assisted-task`, import par l'action « Importer le résultat » | Identique, même consigne au sous-agent |
| Médias | `music.wav` (8 s) et `pop.wav` (0,12 s) générés par FFmpeg, mêmes empreintes | Identiques |
| Configuration | `config/` du dépôt | Identique sauf `style-guide.md` : + 2 blocs de principes (direction créative 899 car., récit 892 car.) distillés par les agents Creative Direction et Storytelling |
| Consigne envoyée | 5 337 caractères (empreinte `60ddd535`) | 7 132 caractères (`4be9ab51`), +34 % ; entrée identique (`e0253927`) |
| Essais | 3 | 3 |
| Corrections manuelles | Aucune | Aucune |

Les principes de son n'ont pas été injectés : dans Veyra, le LLM ne décide rien
du son (Audio Agent à règles). Le son varie seulement avec les composants choisis
(nombre d'effets), ce qui est une conséquence du visuel.

Banc d'essai : `/home/user/project/veyra-skills-lab/` (hors dépôt) — `trial.sh`,
`configA/`, `configB/`, `media/`, bases et projets par variante, `metrics.json`,
`review/` (dossier anonymisé), `.mapping.json` (correspondance, cachée au relecteur).

## 5. Productions

| Essai | Code aveugle | Titre | Structure | Vidéo |
|---|---|---|---|---|
| A1 | V1 | Vos projets, enfin simples | titre > cartes > maquette > texte > CTA | `A/projects/prj_ce99…/revisions/rev_ffa3…/renders/rnd_1a5a….mp4` |
| A2 | V4 | Orbit — vos projets, enfin limpides | titre > cartes > maquette > métriques > CTA | `A/projects/prj_167a…/…/rnd_b3ad….mp4` |
| A3 | V5 | Kairo — vos projets, simplement | titre > cartes > maquette > métriques > CTA | `A/projects/prj_8059…/…/rnd_76e3….mp4` |
| B1 | V3 | Vos projets, enfin sous contrôle | texte-question > titre > cartes > maquette > métriques > CTA | `B/projects/prj_a53f…/…/rnd_72a1….mp4` |
| B2 | V6 | Vos projets, enfin au même endroit | idem | `B/projects/prj_7012…/…/rnd_d901….mp4` |
| B3 | V2 | Reprenez le contrôle de vos projets | idem | `B/projects/prj_4d7c…/…/rnd_f89b….mp4` |

Chemins complets dans `metrics.json`. Pour chaque essai sont conservés : brief
résolu et consigne (`request.json`), storyboard du modèle (`result.json`),
storyboard résolu et composition (révision en base), configuration (`configA/B`),
MP4, rapport QA (base), journal du Studio (messages).

Différences de storyboard mesurées (A → B, sur 3 essais chacun) : ouverture par
une question-problème 0/3 → 3/3 ; alignement à gauche utilisé 0/3 → 3/3 ; entrées
de 600–800 ms → 400–500 ms (1 000 ms sur la maquette) ; CTA qui reprend
l'accroche 0/3 → 2/3 (B3, B1 ; B2 en partie) ; métriques 2/3 → 3/3 ; scène de texte seul 1/3 → 3/3.

## 6. Mesures objectives

| Mesure | A1 | A2 | A3 | B1 | B2 | B3 |
|---|---|---|---|---|---|---|
| Durée (ffprobe) | 20,000 s | 20,000 s | 20,000 s | 20,000 s | 20,000 s | 20,000 s |
| Flux | h264 1920×1080 30/1 + aac 48 kHz | idem | idem | idem | idem | idem |
| Génération du storyboard (durée du sous-agent) | 40,0 s | 38,4 s | 38,3 s | 36,6 s | 48,1 s | 40,7 s |
| Rendu (job Veyra) | 19,3 s | 16,1 s | 18,0 s | 17,4 s | 18,1 s | 20,6 s |
| Contrôles QA en échec (sur 20) | 1 mineur | 1 | 1 | 1 | 1 | 1 |
| Pistes audio proposées | 6 | 8 | 9 | 7 | 7 | 7 |
| Loudness intégrée | −31,3 LUFS | −27,1 | −25,7 | −30,1 | −30,1 | −30,0 |
| Imports refusés / corrections | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Défauts relevés par le relecteur | 4 | 3 | 4 | 6 | 6 | 4 |

Le seul échec QA est « Niveau sonore » (mineur), identique partout : le mix n'est
pas normalisé. Incident : A2 a été importée avant la reprise de session par
l'action officielle du Studio, hors du script ; son temps de rendu vient de la base
(16,1 s) ; le contenu importé est le `result.json` du générateur.

## 7. Revue créative indépendante (à l'aveugle)

Relecteur : sous-agent au contexte neuf, accès limité au dossier `review/`
(MP4, planches à 1 image/s, planche 4 images/s sur l'accroche, 5 images pleines,
mesures audio), sans étiquettes ni consignes. **Notes subjectives** d'un seul
relecteur.

| Critère (poids) | A moyenne | B moyenne |
|---|---|---|
| Cohérence artistique (20 %) | 4,00 | 3,00 |
| Storytelling (20 %) | 3,33 | **3,67** |
| Originalité (20 %) | 2,00 | 2,00 |
| Motion design (15 %) | 3,00 | 3,00 |
| Lisibilité (10 %) | 4,00 | 3,00 |
| Respect du brief (10 %) | **3,67** | 1,67 |
| Cohérence audiovisuelle (5 %) | 2,67 | 2,00 |
| **Note pondérée** | **3,22** (3,15 / 3,40 / 3,10) | **2,75** (2,55 / 2,85 / 2,85) |

Classement : A2 (3,40), A1 (3,15), A3 (3,10), B2 et B3 (2,85), B1 (2,55).
Sans connaître l'origine, le relecteur a formé deux groupes qui correspondent
exactement aux variantes : la différence est donc visible.

Observations vérifiables qui expliquent l'écart :

- B : mentions « (exemple à remplacer) », « (exemple) », « votreappremplacer.app »
  à l'écran (3/3) ; A : un « kairo.example » (1/3). Cause : la règle « chiffres
  fournis uniquement, sinon exemples signalés à remplacer » a été appliquée **dans
  le texte affiché**.
- B : alignements mêlés gauche/centre sans logique, moitié droite vide sur la
  maquette ou les métriques alignées à gauche, chiffre désaligné. Cause : la règle
  « alterner align » ; les composants ne sont pas conçus pour un alignement à
  gauche équilibré.
- B : meilleure accroche (« Vos tâches dispersées dans dix outils ? ») et
  enchaînement « problème → réponse » : effet attendu des principes de récit.
- Mots orphelins en fin de ligne plus fréquents en B (textes plus courts sur deux
  lignes).

## 8. Défauts moteur révélés (communs aux deux variantes)

| Défaut | Constat | Vérification |
|---|---|---|
| « Flash » du titre en révélation mot par mot | Le titre complet est visible ~8 images, disparaît, puis se révèle mot à mot | Vérifié image par image par le Lead (V1, images 0–23) et par le relecteur (V1, V2) |
| Double entrée des cartes | Cartes affichées puis estompées à tour de rôle | Relecteur, image par image sur V1 |
| Ordre du CTA | Bouton et mention avant le titre (A1 à 16,5 s) | Relecteur |
| Mots orphelins | Dernier mot seul en deuxième ligne | Relecteur |
| `align: left` déséquilibré | Grands vides à droite (maquette, métriques) | Relecteur |
| Loudness faible | −25,7 à −31,3 LUFS pour une cible −16 | Mesure FFmpeg |

Ces défauts pèsent davantage sur la qualité perçue que les consignes créatives.

## 9. Analyse

1. **Qualité créative** : B améliore le récit, A reste plus cohérent et plus fini.
2. **Originalité** : aucune différence ; le plafond est le moteur (fond unique,
   5 composants, easing fixe, `enter` ignoré par les composants).
3. **Respect du brief** : B se dégrade à cause d'une règle mal formulée
   (provisoires à l'écran), pas à cause du principe de récit.
4. **Complexité** : B ajoute une scène (6 au lieu de 5) et des alignements variés.
5. **Corrections nécessaires** : aucune exécutée ; B demanderait davantage de
   corrections (provisoires, alignements).
6. **Efficacité** : génération et rendu équivalents (écarts de quelques secondes,
   non significatifs sur 3 essais).
7. **Coût** : +34 % de consigne (≈ 1 800 caractères) ; durée des sous-agents
   comparable.
8. **Stabilité** : très forte dans les deux variantes ; B est même plus uniforme
   (structure identique 3/3), ce qui réduit la variété.

Ce qui vient réellement des principes OpenMontage : l'accroche problème, le lien
« donc », la reprise de l'accroche en clôture (effet positif) ; les alignements
alternés et les provisoires affichés (effet négatif). Les défauts de la section 8
viennent du moteur et ne dépendent pas des variantes.

## 10. Limites méthodologiques

- 3 essais par variante, un seul modèle, un seul relecteur : résultats
  **exploratoires**, non concluants statistiquement.
- Revue sur images fixes : fluidité, easing et rythme réel non évalués.
- **Aucune écoute** : la cohérence audiovisuelle repose sur des mesures.
- Les deux blocs B ont été injectés ensemble : leurs effets sont confondus ; une
  ablation (récit seul, direction seule) serait nécessaire.
- Le générateur est un sous-agent Claude dans le rôle de la session de
  l'utilisateur, pas une session humaine.
- **Une relecture humaine des six vidéos reste nécessaire** avant toute décision
  définitive.

## 11. Recommandations

| Candidat | Décision | Objectif | Utilisé par | Déclencheur | Contrat de sortie | Justification |
|---|---|---|---|---|---|---|
| Enrichir `prompt-to-video` et `instructions.storyboard` (récit) | **Priorité 1** | Accroche dès la 1re seconde par un bénéfice ou un problème, progression problème → solution → preuve → CTA, CTA qui reprend l'accroche, textes courts sans adjectif creux | Motion Agent (storyboard) | Génération d'un storyboard | `StoryboardDraft` inchangé | Effet observé 3/3, storytelling +0,33 |
| Règle anti-provisoires | **Priorité 1** | Ne jamais afficher « exemple », « à remplacer », un domaine `.example` ; omettre une métrique non fournie ou la remplacer par un bénéfice qualitatif | Motion Agent | Idem | Idem | Défaut à l'écran 3/3 en B, 1/3 en A |
| `creative-direction` (nouveau) | Reporter | Variété et intention visuelle | Motion Agent | — | — | Originalité inchangée (2/5) ; règle « alterner align » nuisible ; utile seulement après des moyens visuels supplémentaires dans le moteur |
| `storytelling` (nouveau) | Écarter | — | — | — | — | Couvert par l'enrichissement de `prompt-to-video` ; évite un doublon |
| `bespoke-motion-design` | Écarter | — | — | — | — | Contraire à l'invariant « jamais de HTML/JS par le LLM » |
| `sound-design` | Reporter, sous forme de règles de l'Audio Agent | Une seule musique, effets plus bas et légèrement en avance, effets sur les transitions | Audio Agent (règles) | Proposition de bande son | `AudioComposition` | Aucun effet possible via le storyboard ; à valider à l'écoute |
| `video-editing` | Écarter | — | — | — | — | Suppose des rushes |
| Reprise directe de documents OpenMontage | Écarter | — | — | — | — | Apport tenant en quelques règles reformulées ; AGPL et contradictions de pipeline |

Licence : aucun contenu OpenMontage n'est repris ; les principes retenus sont
reformulés. Aucune notice n'est donc requise.

## 12. Roadmap proposée

1. Corriger les défauts moteur de la section 8 (flash du titre, double entrée des
   cartes, ordre du CTA, mots orphelins, `align: left`) avec des tests de rendu.
2. Enrichir `prompt-to-video` et `instructions.storyboard` : règles de récit et
   anti-provisoires (sans « alterner align »).
3. Refaire l'A/B : variante A contre variante « récit + anti-provisoires », au
   moins 3 essais, puis ablation, et relecture humaine.
4. Seulement ensuite : moyens visuels supplémentaires (fond, composants, easing),
   puis réévaluer un skill `creative-direction`.
5. Règles sonores de l'Audio Agent, validées à l'écoute humaine.

## 13. Fichiers examinés

OpenMontage (`195eab2`) : les 8 documents du tableau de la section 2,
`skills/creative/typography.md`, `short-form.md`, `music-gen-usage.md`,
`cinematic.md`, `animation-pipeline.md`, `skills/meta/creative-intake.md`,
`voice-performance-director.md`, `skills/pipelines/explainer/edit-director.md`,
`script-director.md`, `.agents/skills/hyperframes-creative/references/house-style.md`.
Veyra : `packages/ai/src/index.ts`, `packages/ai/src/agents.ts`,
`packages/motion/src/components.ts`, `registry.ts`,
`packages/hyperframes-adapter/src/compose.ts`, `config/style-guide.md`,
`.agents/skills/*`, `docs/video/MOTION-ENGINE.md`, `docs/video/AUDIO-PIPELINE.md`.
