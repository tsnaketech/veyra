# POC qc-skill : photosensibilité, contraste, luminance

POC isolé réalisé le 2026-11-03 sur `kajisho5/qc-skill` v0.2.6 (commit `a53c30d`). Il n'est **ni installé comme skill, ni intégré au pipeline** Veyra. Contexte et autres candidats : [SKILLS-STRATEGY](../ai/SKILLS-STRATEGY.md), section 8.

## 1. Examen avant exécution

Lecture du code de `src/qc_skill` (6 650 lignes) avant tout lancement :

- **Dépendances** : bibliothèque standard Python uniquement (`argparse`, `json`, `subprocess`, `hashlib`…). Aucun paquet tiers, aucun import dynamique hors `importlib.metadata`.
- **Réseau** : aucun appel.
- **Sous-processus** : `ffprobe` et `ffmpeg`, trouvés par `shutil.which`. Arguments passés en liste, avec `-nostdin -protocol_whitelist file`. Environnement filtré (`_clean_env`), groupe de processus tué au délai.
- **Écritures** : uniquement le cache de rapports dans `--workspace` (`.qc-cache`), désactivé ici par `--no-cache`.
- **Entrées** : chemins confinés par `--allowed-input-root`. Les requêtes contenant `command`, `argv`, `shell`, `filter`… sont refusées.

## 2. Isolation utilisée

Aucun `pip install` : on évite ainsi le backend de construction setuptools et toute écriture dans un environnement Python. Le code est lancé depuis le clone figé (`/home/user/project/kajisho5-lab/qc-skill`) :

```bash
bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind $WS $WS \
  --unshare-all --die-with-parent --clearenv \
  --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv LANG C.UTF-8 --chdir $WS \
  python3 -B -I -c "import sys; sys.path.insert(0, '<clone>/src'); from qc_skill.cli import main; sys.exit(main(sys.argv[1:]))" \
  run <requête.json> --json --workspace $WS --allowed-input-root <media> --no-cache
```

- Tout le système est en lecture seule, sauf un dossier de travail vide.
- `--unshare-all` coupe le réseau, les PID et l'IPC.
- L'environnement est vidé.

Un premier essai d'installation dans un venv avait été refusé par le classifieur de permissions le 2026-11-02 (section 8.5 de SKILLS-STRATEGY). Celui-ci a été accepté après la demande explicite de l'utilisateur. Fichiers du POC, hors dépôt : `/home/user/project/kajisho5-lab/qc-poc/` (`media/`, `req/`, `out/`).

Résultat de `qc doctor` : FFmpeg et ffprobe 9.0.2 (`/usr/local/bin`) disponibles, comme les filtres `blackdetect`, `freezedetect`, `ebur128`, `astats`, `silencedetect`, `ssim` et `psnr`. `libvmaf` est absent.

Temps d'une requête vidéo complète (photosensibilité, luminance, zones de texte, mesures de base) : environ **0,5 s** pour un cas synthétique de 2 à 3 s en 720p, et **6,1 à 6,8 s** pour une vidéo Veyra de 20 s en 1080p (4 cœurs).

## 3. Médias

**Cas synthétiques** générés avec FFmpeg, au résultat attendu connu :

- `flash-5hz` : plein écran, alternance noir et blanc (Y 16/235) à 5 flashs/s ;
- `flash-2hz` : même alternance, à 2 flashs/s ;
- `flash-5hz-small` : même flash à 5 Hz, sur 9 % de l'écran ;
- `text-low` : texte `#9a9a9a` sur `#808080` ;
- `text-ok` : texte blanc sur `#1e1b4b` ;
- `range-legal-lossless` et `range-legal-lossy` : `testsrc2`, encodé respectivement sans et avec pertes ;
- `range-full-tagged-tv` : pleine plage balisée `tv`.

**Vidéos réelles** : V1 à V6 du banc A/B (`veyra-skills-lab/review`), 20 s en 1080p, rendues avant la correction de T095.

**Zones de texte** : calculées par moi. C'est la boîte englobant les pixels de luminance > 200, à un instant où le texte est stable, élargie de 16 px. La même boîte sert aux instants que le `check` HyperFrames de Veyra avait signalés.

## 4. Résultats mesurés

### 4.1 Photosensibilité (ITU-R BT.1702)

| Média | Attendu | qc-skill | Fenêtre la plus défavorable |
|---|---|---|---|
| `flash-5hz` | Échec | **FAIL** | 5,5 flashs/s, 100 % de l'écran |
| `flash-2hz` | Réussite | PASS | 2,0 flashs/s, 100 % de l'écran |
| `flash-5hz-small` | Réussite (< 25 % de l'écran) | PASS | 0 changement retenu |
| V1 à V6 | Réussite (fondus) | PASS (6/6) | 0 flash |

Les trois cas synthétiques donnent le résultat attendu, et les six vidéos Veyra ne produisent aucun faux positif. Le flash rouge saturé est rendu `UNKNOWN` : la norme ne le définit pas.

Veyra n'a aucun contrôle équivalent. **C'est une mesure réellement nouvelle.** Le risque est faible avec les composants actuels (fondus, translations), mais réel pour du motion design à venir : flashs, stroboscopes, transitions rapides.

### 4.2 Contraste du texte

| Média, zone, instant | Contraste qc-skill | `check` HyperFrames (Veyra) |
|---|---|---|
| `text-low` | **1,39:1, FAIL** | — |
| `text-ok` | 16,1:1, PASS | — |
| V1 à V6, accroche (1,25 à 1,75 s) | 5,28 à 5,33:1 | aucun constat |
| V1 à V6, appel à l'action (18,25 à 18,75 s) | 5,36 à 5,45:1 | aucun constat |
| V1, grande zone des cartes, 3,3 s | 10,44:1, PASS | **2,25 à 2,42:1 (3 constats)** |
| V3, grande zone, 5,556 s | 8,15:1, PASS | 2,81:1 |
| V4, grande zone, 3,92 s | 7,18:1, PASS | 1,37 à 2,36:1 |
| **V1, zones serrées sur les numéros « 01 / 02 / 03 »**, 3,3 s | **2,05 à 2,22:1** ; hauteur 21 px à 1080p | 2,25 à 2,42:1 |
| Mêmes zones, **5,75 s** (texte stable) | **2,05 à 2,24:1** | non mesuré |
| V1, zone serrée sur une description de carte, 3,3 s | 9,8:1 ; hauteur 28 px | — |

Ce qu'il faut retenir :

- **Concordance** : sur des zones serrées, la mesure sur l'image rendue (2,05 à 2,24:1) recoupe celle du DOM (2,25 à 2,42:1). L'écart vient de la compression et de la mesure sur pixels.
- **Mesure nouvelle** : l'image rendue montre que le défaut des numéros de cartes est **permanent** (encore présent à 5,75 s), et non une transition. Le `check` HyperFrames ne l'a vu qu'à un instant d'échantillonnage. Veyra le classe en avertissement d'information (`passed: true`, seuil 3:1). La hauteur mesurée (21 px) est aussi sous le plancher de 28 px de MOTION-ENGINE.
- **Faux négatifs selon la zone** : sur une grande zone contenant plusieurs textes, le seuillage d'Otsu ne retient que le texte dominant. Il renvoie 7 à 10:1 et **masque** le défaut. Ce contrôle n'est fiable qu'avec une zone par élément de texte. qc-skill ne trouve pas le texte lui-même : c'est à Veyra de fournir les boîtes.

### 4.3 Luminance dans la plage légale (16 à 235)

| Média | Y min–max mesuré | qc-skill (tolérance 0,5 s) |
|---|---|---|
| `range-legal-lossless` | légal | PASS |
| `range-legal-lossy` (même source, x264 par défaut) | 0 à 227 après encodage | **FAIL** (1,97 s sur 2 s) |
| `range-full-tagged-tv` | hors plage | FAIL (attendu) |
| `text-ok` | 33 à 250 | **FAIL** |
| V1 à V6 | 0 à 254–255 | **FAIL** : 18,8 à 19,1 s hors plage sur 20 s |

La cause est vérifiée séparément. Une source `testsrc2` légale (Y 30–210 avant encodage et en encodage sans perte) sort en **Y 0–227** après encodage x264 avec pertes : les bords nets créent des dépassements de compression. Le contrôle repose sur le Y minimum et maximum par image : un seul pixel suffit à le faire échouer.

**Ce sont des faux positifs systématiques** pour toute vidéo H.264 contenant du texte net, donc pour toute vidéo Veyra. Le contrôle ne convient qu'à une livraison broadcast, avec un critère de proportion de pixels plutôt qu'un extremum.

### 4.4 Autres observations

- `freezedetect` (mesures du 2026-11-02, FFmpeg direct) : 7 à 9 s de « gel » sur 20 s dans V1 à V6. Ce sont les maintiens voulus du motion design. Faux positif si on l'active sans tolérance par scène.
- `expected_cuts` (scdet) : 0 coupe dans V1 et V2, car les transitions Veyra sont des fondus. Inutilisable en l'état.

## 5. Mesures réellement nouvelles et faux positifs

| Contrôle | Veyra aujourd'hui | Apport de qc-skill | Faux positifs ou négatifs constatés |
|---|---|---|---|
| Photosensibilité | Aucun | **Nouveau, fiable** sur les cas testés | Aucun sur 9 médias |
| Contraste mesuré sur l'image | `check` HyperFrames sur le DOM, à quelques instants, seuil 3:1, information seulement | **Nouveau en complément** : mesure sur pixels à n'importe quel instant, hauteur d'encre | Faux négatifs sur les grandes zones ; exige une zone par texte |
| Luminance légale | Aucun | Mesure disponible | **Faux positifs systématiques** (dépassements x264) : à ne pas reprendre en l'état |

## 6. Proposition d'intégration au Video QA Expert

Aucune de ces propositions n'est implémentée. L'architecture du QA ne change pas :

- contrôles déterministes de `packages/video` et `check` HyperFrames ;
- QA audio ;
- revue IA consultative ;
- validation humaine obligatoire ;
- QA indépendante des agents de création.

1. **Photosensibilité** : un nouveau contrôle déterministe dans `packages/video`, **réécrit en TypeScript** et non par appel à Python.
   - Algorithme : décoder une version réduite en `rawvideo` gris (par exemple 160×90) avec le `runProcess` existant, convertir Y en luminance relative, compter les paires de transitions opposées de plus de 20 cd/m² (côté sombre sous 160 cd/m², surface au-delà de 25 %) par fenêtre glissante de 1 s.
   - Sévérité `major` au-delà de 3 flashs/s, sans correction automatique : aucune règle de correction n'existe, le cas est remonté à l'humain.
   - Oracle de test : les trois médias synthétiques ci-dessus, avec les valeurs de qc-skill comme référence croisée.
2. **Contraste et hauteur de texte mesurés sur le rendu**, en complément du `check` HyperFrames, sans le remplacer.
   - Veyra fournit les zones, un élément de texte à la fois. Les boîtes peuvent venir de la mise en page rendue par HyperFrames (`hyperframes inspect`, dont le format JSON **reste à vérifier**), à l'instant où chaque scène est stable (début + entrée + 0,2 s).
   - Mesure : seuillage d'Otsu dans la zone, luminance relative sRGB, contraste WCAG 2.x (4,5:1 pour le texte normal, 3:1 pour le grand texte), hauteur d'encre ramenée à 1080 p (plancher de 28 px).
   - Sévérité `minor` : un avertissement visible dans le rapport, jamais une validation automatique.
3. **Luminance légale** : non retenue pour le web. Si une livraison broadcast apparaît, contrôle d'information fondé sur la **part** de pixels hors plage avec une tolérance, et non sur un extremum par image.
4. **qc-skill** reste un outil de contre-expertise manuelle, épinglé au commit `a53c30d`, lancé comme décrit à la section 2. Ce n'est pas une dépendance de Veyra.

## 7. Limites

- Contrastes mesurés à des instants choisis à la main : mes zones sont des boîtes de pixels clairs, pas les boîtes du DOM.
- Une seule résolution réelle (1080p) et des vidéos d'un seul style (dégradé violet, bleu et cyan).
- Photosensibilité testée sur des signaux synthétiques simples. La conformité réelle à BT.1702 de l'implémentation n'est pas auditée, et les flashs rouges ne sont pas évalués.
- Les vidéos V1 à V6 précèdent la correction de T095 : leurs entrées montrent encore le flash. Aucune n'a été recontrôlée après la correction.
- Le code de qc-skill a été lu, pas audité de façon exhaustive. Sa suite de tests (31 fichiers) n'a pas été lancée.
