# Standards qualité

Les seuils viennent de `config/quality.yaml` : tolérance de durée 100 ms,
résolution minimale 1080 × 1080, deux tentatives de correction automatique au plus,
seuil de différence visuelle `correctionCheck.psnrThresholdDb` (40 dB).

## Contrôles déterministes

`packages/video` vérifie durée, dimensions exactes et minimum, fps (tolérance
0,01 fps), codec h264, fichier non vide et absence de segments noirs. blackdetect
utilise d=0.05, pix_th=0.10, pic_th=0.98 ; les temps des segments figurent dans
l'evidence JSON du contrôle. Ces seuils détectent des noirs techniques et ne
jugent pas la qualité esthétique ni la pertinence d'un fondu intentionnel.

## Contrôles de composition (HyperFrames `check`, D017)

Avant chaque rendu, `hyperframes check --json --at-transitions` s'exécute dans le bac à
sable. Ses sections deviennent des contrôles `deterministic` :

| Contrôle | Sections | En échec si | Sévérité |
|---|---|---|---|
| Mise en page (marges, débordements) | layout | une erreur de débordement | major |
| Lisibilité (contraste WCAG AA) | contrast | un texte sous AA | major |
| Exécution de la composition | lint, runtime | erreur de lint ou JS | major |
| Animations et transitions (conseils) | motion, craft | une erreur ; les avertissements (rythme, première image, son) restent en preuve | minor |
| Performance de rendu | — | rendu > 80 % du délai maximal | minor |

Si `check` ne peut pas tourner, un contrôle « non exécuté » le dit. Ces échecs ne
déclenchent pas de nouveau rendu automatique : un nouveau rendu n'y changerait rien ;
il faut une correction. Seuils de texte des composants : ≥ 2,6 % de la hauteur.

## Revue qualitative

Une image par scène (au milieu de la scène) est extraite avec ffmpeg et envoyée
au fournisseur IA, qui évalue lisibilité, cohérence graphique, respect du
storyboard et des consignes de marque (`config/style-guide.md`).

| Mode | Signification |
|---|---|
| `deterministic` | Mesure ffprobe/ffmpeg ; preuve = valeurs mesurées. |
| `multimodal` | Le modèle a reçu des images. |
| `text-only` | Le modèle n'a reçu que du texte ; aucune conclusion visuelle. |
| `simulated` | Simulateur de test ; aucune analyse. Affiché « Simulé — aucun modèle ». |

Chaque constat porte son mode ; le rapport expose l'union dans `analysisModes`.
En mode assisté (`claude-subscribe`), aucune revue qualitative automatique n'a lieu.

## QA comparatif après un lot de corrections (D013)

Pour une révision issue d'un plan, `Studio.verifyCorrections` reçoit le rendu
précédent, le nouveau, le plan, les commentaires (frames, timestamps, captures) et
les deux storyboards. Pour chaque commentaire :

1. **Source** : chaque champ du patch est comparé à la scène de la nouvelle révision.
2. **Rendu** : frames extraites aux mêmes décalages dans la scène (moitié et fin des
   deux durées d'animation, milieu de scène) dans les deux rendus ; PSNR ffmpeg.

| Verdict | Condition |
|---|---|
| `applied` | Tous les champs conformes et différence visible (PSNR < seuil). |
| `partially_applied` | Une partie des champs, ou source conforme sans différence mesurée. |
| `not_applied` | Aucun patch exprimable (dont conflit) ou aucun champ conforme. |
| `unverifiable` | Comparaison impossible (rendu précédent absent, extraction en échec). |

Les scènes non ciblées sont comparées en leur milieu ; une différence produit
« Régression possible » (`minor`). Verdicts et preuves : `correction_batches.verification`
et le rapport QA (`deterministic`). Ils ne déclenchent pas de correction automatique.
Limite : un changement visible n'est pas jugé sur son intention par les mesures ;
c'est le rôle de l'expertise ci-dessous.

## Expertise QA des corrections (D015)

Après le rendu d'une révision issue d'un plan, `Studio.requestEvaluation` constitue
un dossier de preuves (`revisions/<rev>/qa-expert/<qev>/`) et le soumet au
`QualityEvaluator` du fournisseur actif :

| Image | Rôle |
|---|---|
| `<fdb>-before-capture.png` | Frame exacte annotée par l'utilisateur |
| `<fdb>-after-aligned.png` | Même instant de la scène dans la nouvelle révision (décalages pris en compte) |
| `<fdb>-{before,after}-seq-<k>.png` | 5 frames de 0 à 1,5 × la durée d'animation, mêmes décalages ; pour toute scène commentée, même si le plan ne touche pas au timing |
| `<scn>-{before,after}-scene.png` | Milieu des scènes non ciblées (régressions) |

Contexte joint : brief (prompt d'origine), consignes et palette de marque,
storyboards avant/après, plan, conflits, mesures déterministes (étiquetées).

Sortie : par commentaire, verdict (`applied`, `partially_applied`, `not_applied`,
`contradicts_request`, `unverifiable`), catégorie (`technical` = défaut de rendu,
`content` = demande non respectée, `aesthetic` = appréciation), confiance 0–1,
justification, preuves citant les images ; constats `regression`, `defect`,
`observation`. Les ids, scènes et images inconnus sont filtrés ; un commentaire
non traité devient `unverifiable` (confiance 0).

| Évaluateur | `analysisMode` | Ce qui est réellement vu |
|---|---|---|
| `fake` | `simulated` | Les storyboards seulement ; aucune image |
| `anthropic-api` | `multimodal` (images envoyées) / `text-only` | Images envoyées (non vérifié, pas de clé) |
| `claude-subscribe` | `multimodal` si des images du dossier sont déclarées examinées, sinon `text-only` | Déclaration de Claude Code, non prouvable par Veyra |
| aucun / indisponible | — (`unavailable`) | Rien ; aucune simulation de remplacement |

### Présentation du rapport (D016)

Langue des textes : `quality.reportLanguage` (`fr` par défaut). Le panneau
« Expertise QA » sépare :

1. **Conformité aux corrections demandées** : verdict, catégorie, confiance, mesure
   et désaccord éventuel, justification, **preuves citées** (images et observations),
   **preuves fournies non examinées** (images du dossier absentes de `imagesExamined`).
   Un verdict sans image citée est signalé.
2. **Qualité technique et artistique globale** : résumé des contrôles déterministes,
   défauts (`defect`) et observations (`observation`) de l'expert.
3. **Régressions potentielles** : mesures (« Régression possible ») et régressions
   signalées par l'expert, séparément.

La confiance est une estimation de l'évaluateur, pas une probabilité garantie ; celle
du simulateur est fixe et affichée comme telle.

### Jeu de référence et comparaison

`qa/reference/v1/cases.json` (`veyra-qa-reference/v1`) : 10 cas (9 synthétiques sur
storyboards, 1 enregistré sur rendu réel avec images) et verdicts attendus
(verdict + catégorie, régressions). Statut : **proposé**, à valider par un humain
(`reviewedBy`). Résultats au format `veyra-qa-results/v1` ; un résultat réel est versionné
dans `results/`. Commande et lecture des métriques : [TESTING](../TESTING.md).

L'expertise est consultative : elle ne change ni les révisions ni leur état, ne
déclenche aucune correction automatique, et l'interface affiche les désaccords
avec les mesures. La validation humaine reste obligatoire.
Non couverts au MVP : qualité audio (aucune piste audio générée), transitions
entre scènes et continuité au-delà de l'image médiane de chaque scène.

## Corrections automatiques et validation

Seuls les contrôles **déterministes** `major`/`critical` en échec déclenchent un
nouveau rendu automatique, au plus deux fois (révision enfant à storyboard
identique). Aucune correction créative n'est automatique : elle passe par un plan
relu et appliqué par l'utilisateur ([REVIEW-SYSTEM](../system/REVIEW-SYSTEM.md)).
Un rapport, même entièrement réussi, ne vaut jamais validation humaine.
