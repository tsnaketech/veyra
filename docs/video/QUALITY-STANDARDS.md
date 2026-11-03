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

## Contrôles audio

Avec une bande son, le MP4 final reçoit des contrôles mesurés (flux, durée,
silences, écrêtage, niveau, synchronisation des effets isolés) et une
« Écoute qualitative » toujours `not-performed`. Seuils et détail :
[AUDIO-PIPELINE](AUDIO-PIPELINE.md#audio-qa). Aucun ne déclenche de nouveau rendu.

L'interface classe chaque contrôle en trois catégories :

| Catégorie | `analysisMode` | Règle |
|---|---|---|
| Mesuré | `deterministic` | Valeurs mesurées en preuve. |
| Jugement IA | `multimodal`, `text-only`, `simulated` | Appréciation d'un modèle ou du simulateur. |
| Non réalisé | `not-performed` | Rien n'a été mesuré ni écouté ; ne peut pas être réussi (refusé par le schéma), n'est pas compté comme un échec. |

## Photosensibilité (flashs, mesure technique)

Module `packages/video/src/photosensitivity.ts` : `detectFlashes` (pur, images
en niveaux de gris) et `analyzeFlashes` (décodage FFmpeg en flux), check
« Photosensibilité (flashs, mesure technique) » via `photosensitivityCheck`.
Méthode indépendante, **inspirée** des lignes directrices sur les flashs
(ITU-R BT.1702) : ce n'est **pas** une validation de conformité. Exécuté par le
runner après chaque nouveau rendu ; une erreur de décodage donne un check
`not-performed` (`minor`) avec le message, sans faire échouer le rendu.

- **Décodage** : `ffprobe` puis `ffmpeg -nostdin -protocol_whitelist file`,
  `scale=W:H:flags=area,format=gray`, `-f rawvideo` vers un tube ; ≈ 14 400 pixels
  (160×90 en 16:9, proportions conservées), une image en mémoire à la fois, délai
  (120 s) et plafond d'images (108 000) qui font échouer l'analyse.
- **Fréquence d'images** : `r_frame_rate` doit égaler `avg_frame_rate` (même
  critère que `probe`). Sinon résultat « non mesuré » : `analysisMode`
  `not-performed`, `passed: false`, `minor`.
- **Luminance (hypothèse)** : code Y normalisé (16–235 en plage limitée, 0–255 en
  pleine), EOTF gamma 2,2, affichage supposé de 200 cd/m². `format=gray` fait
  convertir par FFmpeg la plage limitée (ou non étiquetée) en plage pleine :
  `analyzeFlashes` passe donc `colorRange: "full"` au détecteur et rapporte la
  plage d'origine (`sourceColorRange`).
- **Transition par pixel** : suivi de l'extremum courant ; transition quand
  l'écart atteint ≥ 20 cd/m² et que le côté sombre est < 160 cd/m², puis sens
  inversé et extremum réinitialisé. Avant la première transition, minimum et
  maximum sont suivis.
- **Événement global** : part de l'écran ayant transité dans le même sens sur
  0,1 s (3 images à 30 i/s, pour les fondus non uniformes) ≥ 25 % ; seuls les
  événements de sens alterné sont retenus. Une seconde série au seuil de 10 %
  sert aux petites zones.
- **Flash** = paire de transitions opposées : flashs/s = transitions dans une
  fenêtre glissante d'1 s (écart < 1 000 ms) / 2.
- **Gravité** : > 3 flashs/s sur ≥ 25 % → `major` ; > 2 et ≤ 3 flashs/s sur
  ≥ 25 %, ou > 3 flashs/s sur ≥ 10 % → `minor` (« à vérifier par un humain ») ;
  sinon `info`, réussi. Un fondu, une coupe ou un flash isolé (≤ 2 flashs/s)
  passe.
- **Preuve** : JSON en français (fps, images analysées, max flashs/s aux deux
  seuils, surface max, pire fenêtre avec frame et début/fin en ms, 20 premières
  transitions horodatées avec leur index de frame) ; `timestamp` = début de la
  pire fenêtre.
- **Aucune correction automatique** : le nom n'est pas dans `RETRYABLE`.

Limites et faux positifs possibles : stroboscope voulu par l'auteur, scintillement
de compression ou de bruit sur de grandes zones sombres, petites zones très
contrastées proches de 10 % ; motifs à rayures (réguliers) et flashs rouges
saturés **non évalués** ; luminance d'affichage, gamma et surface de l'écran
supposés (pas d'angle de vue) ; résolution réduite qui peut gommer des détails
fins ; vidéos à fréquence variable non mesurées.

## Contraste mesuré sur l'image rendue

Module `packages/video/src/text-contrast.ts` : `contrastFromPixels` (pur),
`measureTextContrast` (FFmpeg) et le check « Contraste mesuré sur l'image
rendue » (`textContrastCheck`), exécuté par le runner avec la photosensibilité
(`renderedPictureChecks`) après chaque nouveau rendu (pas pour une image
réutilisée).

- **Source des zones** : uniquement les constats `contrast_aa_failure` de
  `hyperframes check --json` (boîte DOM `bbox` en px CSS de la composition,
  `time`, `text`, `fg`, `ratio`, `requiredRatio`, `large`, `severity`). Aucune
  zone n'est déduite des pixels. La boîte est remesurée à `time` (premier échec)
  et à chaque instant de `times` (dédupliqués par image, 5 au plus). La boîte DOM
  est celle relevée à `time`, supposée fixe aux autres instants : les garde-fous
  rejettent les rognages incohérents (élément déplacé). Aucun autre instant n'est
  mesuré.
- **Extraction** : une image par instant (`-ss` un demi-intervalle avant l'image
  visée, car FFmpeg écarte les images antérieures à la cible), recadrage de la
  boîte arrondie vers l'extérieur, bornée à l'image et mise à l'échelle si la
  vidéo n'a pas la taille de la composition, `rawvideo rgb24` ; 20 zones au plus.
- **Mesure** : luminance relative WCAG 2.x par pixel ; seuil d'Otsu (histogramme
  de 4 096 classes) ; la classe « encre » est celle dont la médiane est la plus
  proche de la luminance de `fg` (classe minoritaire seulement si `fg` manque) ;
  ratio = (L1 + 0,05) / (L2 + 0,05) sur les médianes des deux classes.
- **Garde-fous** (zone « non mesurable », raison donnée) : boîte hors image ;
  hauteur < 6 px ou surface < 40 px² ; boîte uniforme ; part d'encre hors
  [2 %, 70 %] ; séparation (variance inter-classes / variance totale) < 0,5. Fond
  dont le rapport p90/p10 de luminance (formule WCAG) dépasse 1,5 : mesure gardée,
  marquée « fond hétérogène, confiance faible ». Constat HyperFrames `warning`
  (texte animé, transitoire) : mesuré et étiqueté « transitoire ».
- **Ratio retenu par zone** : le meilleur ratio parmi ses mesures fiables
  (statut mesuré, confiance normale) : un texte n'échoue que s'il reste sous le
  seuil même à son instant le plus lisible (un fondu n'est pas jugé sur sa
  première image). Ratios fiables écartés de plus de 20 % : note « variable
  (animation probable) ». Toutes les mesures (frame, ratio, statut) restent en
  preuve.
- **Verdict** : seules les zones à mesure fiable comptent ; réussi si toutes
  atteignent `requiredRatio` (3 en grand texte, 4,5 sinon) ; échec `minor`,
  `timestamp` = instant retenu de la pire zone. Une mesure à confiance faible
  reste visible en preuve (« hors verdict ») mais ne compte ni dans le verdict ni
  dans le pire ratio. Aucune zone exposée : `not-performed` (`info`). Contrôle
  HyperFrames absent, aucune mesure fiable ou erreur d'extraction :
  `not-performed` (`minor`), avec la raison.
- **Relation avec HyperFrames** : « Lisibilité (contraste WCAG AA) » reste le
  contrôle principal (`major`). Ce contrôle-ci confirme ou nuance ses échecs
  sur les pixels réellement encodés. La preuve donne, par zone, le texte, la
  frame, le ratio mesuré, le ratio HF, le ratio requis et le statut, ainsi que la
  couverture : « X zones remesurées ; HyperFrames a fait N vérifications
  élément × instant (M réussies) ; les textes qui réussissent ne sont pas
  exposés et ne sont pas remesurés ». `checked`/`passed` de HyperFrames comptent
  des couples élément × échantillon, pas des textes.
- **Non mesuré** : les textes validés par HyperFrames (il n'exporte pas leurs
  boîtes) et les instants hors de `time`/`times` de chaque boîte.
- **Limites** : les bords anticrénelés et le sous-échantillonnage 4:2:0
  rapprochent les médianes (ratio un peu sous-estimé) ; tolérance d'intégration
  0,4 sur un texte blanc sur #2563EB (5,17:1 théorique) ; une boîte mal placée
  (élément animé) est en général rejetée par la part d'encre, sans garantie ;
  mesuré sur rendu HyperFrames réel : un texte en fondu donne 1,47 au premier
  échec puis 2,36 à son meilleur instant (HF : 2,42).
- **Aucune correction automatique** : ni ce contrôle ni la photosensibilité ne
  figurent dans `RETRYABLE` (`studio.ts`).

## Revue qualitative

Une image par scène (au milieu de la scène) est extraite avec ffmpeg et envoyée
au fournisseur IA, qui évalue lisibilité, cohérence graphique, respect du
storyboard et des consignes de marque (`config/style-guide.md`).

| Mode | Signification |
|---|---|
| `deterministic` | Mesure ffprobe/ffmpeg ; preuve = valeurs mesurées. |
| `not-performed` | Contrôle non réalisé (voir « Contrôles audio »). |
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
Non couverts au MVP : écoute qualitative du son (voir « Contrôles audio »), transitions
entre scènes et continuité au-delà de l'image médiane de chaque scène.

## Corrections automatiques et validation

Seuls les contrôles **déterministes** `major`/`critical` en échec déclenchent un
nouveau rendu automatique, au plus deux fois (révision enfant à storyboard
identique). Aucune correction créative n'est automatique : elle passe par un plan
relu et appliqué par l'utilisateur ([REVIEW-SYSTEM](../system/REVIEW-SYSTEM.md)).
Un rapport, même entièrement réussi, ne vaut jamais validation humaine.
