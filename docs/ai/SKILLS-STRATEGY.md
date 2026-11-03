# Stratégie des skills Claude Code dans Veyra

Audit réalisé le 2026-11-02 sur la branche `feat/qa-expert-v0.1`. Il couvre :

- les skills externes installés par l'utilisateur : `greensock/gsap-skills`, `CloudAI-X/threejs-skills`, `remotion-best-practices`, `playwright-cli` et `kajisho5/ffmpeg-skill` ;
- trois candidats non installés : `kajisho5/qc-skill`, `kajisho5/video-editing-skill` et `kajisho5/audio-production-skill`.

Un skill est une aide pour les sessions de développement Claude Code. Ce n'est pas une intégration applicative : aucun outil décrit ici n'est appelé par le pipeline de production Veyra.

Les invariants restent inchangés :

- HyperFrames reste le moteur de rendu principal ;
- les révisions restent immuables ;
- la QA reste indépendante ;
- les agents métier (Director, Motion, Audio, Review, QA) restent déterministes ou passent par `AiProvider`.

## 1. Résumé

| Sujet | Décision |
|---|---|
| GSAP | Référence pour toute animation 2D du Motion Engine : composants de `@veyra/motion` et `compose.ts`. À charger à la demande (`gsap-core`, `gsap-timeline`). Le POC valide une correction de T095 (§ 6.1). |
| Three.js | Réservé aux scènes nécessitant réellement de la 3D. Aucune dépendance runtime tant qu'un POC n'est pas approuvé (§ 6.4). |
| remotion-best-practices | Principes transposables uniquement. Jamais de code Remotion dans le pipeline HyperFrames. |
| playwright-cli | Tests et débogage de l'interface Studio uniquement. Les E2E versionnés restent dans `@playwright/test`. |
| ffmpeg-skill 3.1.1 | Outil d'inspection pour le développeur : `probe`, `check --platform`, `loudness --measure`, `silence --list`. Ne remplace ni l'Audio Engine ni le Video QA. |
| qc-skill 0.2.6 | **POC réalisé le 2026-11-03** sous bwrap, sans installation ([QC-SKILL-POC](../research/QC-SKILL-POC.md)). Photosensibilité : nouvelle et fiable sur les cas testés. Contraste sur l'image : complément utile, mais il faut une zone par texte. Luminance légale : faux positifs systématiques. Non intégré. |
| video-editing-skill 0.4.2 | Conservé pour une future itération consacrée aux rushes ; non installé. |
| audio-production-skill 0.4.8 | Non installé (décision du 2026-11-03) ; il double l'Audio Engine. |
| **Blocage** | FFmpeg 9.0.2 installé le 2026-11-02 dans `/usr/local/bin` casse le rendu réel et les tests (§ 2). |

## 2. Blocage FFmpeg constaté (à traiter en premier)

> **Résolu le 2026-11-02 (T100)** : FFmpeg 9.0.2 recompilé avec libx264, zlib, freetype, libass et vidstab, puis installé dans `/usr/local`. Résultats : `test:slow` 2/2, `pnpm test` réussi, E2E 6/6 et `ffmpeg-skill doctor` 42/42 ; détails dans [install_ffmpeg](../install_ffmpeg.md). La suite de cette section décrit l'état constaté avant la correction.

D'après [install_ffmpeg.md](../install_ffmpeg.md), document non versionné, FFmpeg 9.0.2 a été compilé avec `./configure` par défaut puis installé dans `/usr/local/bin`. Ce répertoire précède `/usr/bin` dans le `PATH`. Veyra appelle `ffmpeg` et `ffprobe` par le `PATH`, dans `packages/audio`, `packages/video` et le bac à sable HyperFrames.

Cette compilation n'a ni libx264, ni encodeur PNG (zlib absent), ni `drawtext`, `subtitles`/`ass`, `libvmaf`.

| Vérification (exécutée) | FFmpeg 9.0.2 (`/usr/local/bin`) | FFmpeg 5.1.9 Debian (`/usr/bin` en tête du `PATH`) |
|---|---|---|
| `pnpm --filter @veyra/hyperframes-adapter test:slow` | **2 échecs** (`hyperframes.mjs render exited 1`) | 2 réussis (24 s) |
| `pnpm --filter @veyra/audio test` | **3 échecs sur 19** (mux h264, validation MP3) | 19 réussis |
| `pnpm --filter @veyra/video test` | **Échec du fichier** (extraction PNG) | 6 réussis |
| `ffmpeg -c:v libx264` | `Unknown encoder 'libx264'` | disponible |
| `ffmpeg-skill doctor` | 17 outils sur 42 utilisables | refusé : « FFmpeg 5.1 is not supported since ffmpeg-skill 3.0.0 » |

Il y a donc un conflit :

- ffmpeg-skill 3.x exige FFmpeg ≥ 6.1 ;
- Veyra et HyperFrames exigent libx264 et PNG, absents de la compilation 9.0.2.

**Recommandation** : recompiler FFmpeg 9.0.2 avec au minimum `--enable-gpl --enable-libx264 --enable-zlib --enable-libfreetype --enable-libass`. Il faut d'abord installer `pkg-config`, `zlib1g-dev`, `libx264-dev`, `libfreetype-dev` et `libass-dev`.

Le binaire devient alors GPL. C'est sans conséquence pour un usage local, à documenter si Veyra est un jour redistribué.

Avant toute recompilation, vérifier :

- `test:slow` ;
- `pnpm --filter @veyra/audio test` ;
- `pnpm --filter @veyra/video test` ;
- `doctor`.

En attendant, on peut retirer l'installation (`sudo make uninstall` depuis `/home/user/ffmpeg-9.0.2`) ou placer `/usr/bin` en tête du `PATH` du Studio. Cette décision revient à l'utilisateur : l'audit n'a rien modifié.

Les prérequis de [RUNBOOK](../RUNBOOK.md) (FFmpeg 5.1.9) ne sont plus exacts sur cette machine.

## 3. Inventaire réel

### 3.1 Emplacements et découverte

- `.claude/skills` pointe vers `.agents/skills/` (lien du dépôt). Claude Code charge les skills du projet depuis ce dossier, et ceux de l'utilisateur depuis `~/.claude/skills`. Ce dernier contient des liens vers `~/.agents/skills`.
- **Découverte vérifiée** : les 23 nouveaux skills (8 `gsap-*`, 13 `threejs-*`, `playwright-cli`, `remotion-best-practices`) et `ffmpeg-skill` apparaissent dans la liste des skills de la session Claude Code du 2026-11-02, avec leur description. `playwright-cli` et `ffmpeg-skill` ont été chargés et utilisés (§ 6).
- **Doublons de portée** : il existe deux copies de chacun de ces skills.
  - `playwright-cli` : copie du projet identique à `~/.agents/skills/playwright-cli`, de septembre 2026 (`diff -r` vide).
  - `remotion-best-practices` : la copie du projet est la version 4.0.539 (14 sous-dossiers, 144 fichiers), la copie utilisateur une version de février 2026 (dossier `skillFolderHash` 198f0f4).
  - La liste de session ne montre qu'une entrée par nom. Quelle copie Claude Code charge en priorité n'a pas été vérifié : supprimer la copie utilisateur obsolète si la version du projet doit faire foi.
- Les skills HyperFrames existent eux aussi deux fois : en copies locales ignorées par Git et par le plugin `hyperframes@hyperframes` (référence `v0.8.214` dans `.claude/settings.json`).

### 3.2 Provenance, versions et installation

`skills-lock.json` (ignoré par Git) contient le chemin et le hachage de contenu, mais aucune référence ni commit. Il ne permet donc pas de réinstaller une version exacte.

| Skill(s) | Emplacement | Source | Version ou référence vérifiable | Méthode d'installation | Licence |
|---|---|---|---|---|---|
| `gsap-core`, `-timeline`, `-performance`, `-plugins`, `-utils`, `-react`, `-frameworks`, `-scrolltrigger` | `.agents/skills/gsap-*` | `greensock/gsap-skills` | Hachages de contenu dans `skills-lock.json` ; aucun commit | `npx skills add` (entrées dans `skills-lock.json`) | MIT (déclaré en en-tête) |
| 13 `threejs-*` (fundamentals, animation, geometry, materials, lighting, textures, loaders, shaders, postprocessing, interaction, performance, asset-pipeline, react-three-fiber) | `.agents/skills/threejs-*` | `cloudai-x/threejs-skills` | Hachages de contenu ; aucun commit ; vise three.js r181–r186 | `npx skills add` | Non déclarée dans les fichiers installés : **à vérifier sur le dépôt** |
| `remotion-best-practices` | `.agents/skills/` (et copie utilisateur) | `remotion-dev/skills` | `version: 4.0.539` (en-tête) | `npx skills add` | Non déclarée dans les fichiers installés |
| `playwright-cli` | `.agents/skills/` (et copie utilisateur) | Skill fourni par `playwright-cli` 0.1.21 (playwright-core 1.64.0-alpha), installé globalement par pnpm | 0.1.21 | Copie depuis le paquet global | Apache-2.0 pour Playwright ; non vérifiée pour le skill |
| `ffmpeg-skill` | `.agents/skills/ffmpeg-skill` | `kajisho5/ffmpeg-skill` | **3.1.1** : les 76 fichiers sont identiques au tag `v3.1.1` (comparaison octet par octet après clonage) | `npx ffmpeg-skill` (pas d'entrée dans `skills-lock.json`, absent du verrou utilisateur) | MIT (`package.json`) ; le fichier `LICENSE` n'est pas copié par l'installateur |

Pour figer une version, noter le commit de chaque dépôt au moment de l'installation :

- dépôts clonés en lecture seule dans `/home/user/project/kajisho5-lab/`, hors dépôt Veyra ;
- `ffmpeg-skill` : tag `v3.1.1`, `main` à `1ce2c18` ;
- `qc-skill` : `v0.2.6` (`a53c30d`) ;
- `video-editing-skill` : `v0.4.2` (`f3e4ac4`) ;
- `audio-production-skill` : `v0.4.8` (`b16666f`).

### 3.3 Dépendances, scripts, permissions

| Skill(s) | Contenu | Exécutable | Dépendances | Permissions et risques |
|---|---|---|---|---|
| `gsap-*` | 1 `SKILL.md` chacun (4 à 22 Ko) | Aucun | GSAP 3.14.2 déjà présent (`packages/hyperframes-adapter`) | Aucun |
| `threejs-*` | 1 `SKILL.md` chacun (18 à 30 Ko) | Aucun | `three` absent du dépôt (dernière version npm : 0.187.0) | Aucun ; tenté d'ajouter des dépendances : refuser sans POC |
| `remotion-best-practices` | Routeur de 4 Ko et 144 fichiers de référence (1,8 Mo) | Aucun script exécuté par le skill | Remotion (non installé, non voulu) | Aucun |
| `playwright-cli` | 1 `SKILL.md` et 10 références | Binaire `playwright-cli` global | Navigateur Playwright | `allowed-tools: Bash(playwright-cli:*) Bash(npx:*) Bash(npm:*)` : le skill autorise `npx`/`npm`, soit plus large que nécessaire. Écrit `.playwright-cli/` (instantanés, journaux) dans le répertoire courant, déjà ignoré par Git. |
| `ffmpeg-skill` | 42 scripts Python, bibliothèque standard uniquement, et `mcp/server.py` | `python3 scripts/<outil>.py` | Python ≥ 3.10 (3.11.2 présent), FFmpeg ≥ 6.1 | Arguments passés en liste, sans `shell=True`, `eval` ni accès réseau dans `scripts/` et `mcp/` (recherche statique). La transcription optionnelle (`faster-whisper`, `openai-whisper`) télécharge un modèle au premier usage : ne pas l'activer. `python3` écrit `__pycache__` dans le dossier du skill (effacé après l'audit) : lancer avec `python3 -B`. |

## 4. Chevauchements

| Besoin | Veyra (référence) | HyperFrames | Skills externes | Règle |
|---|---|---|---|---|
| Animation 2D | `@veyra/motion` (5 composants, tweens validés par Zod) et `compose.ts` (instructions `fromTo` fixes) | `hyperframes`, `references/runtimes.md` (« GSAP facts that bite ») | `gsap-core`, `gsap-timeline`, `gsap-utils`, `gsap-plugins` | Contrat HyperFrames d'abord (timeline en pause, temps absolus, ni hasard ni minuteur), puis API GSAP. Le LLM n'écrit toujours pas de JS. |
| 3D | Aucune | Three.js piloté par `hf-seek` (`runtimes.md`) ; blocs 3D du registre (non utilisés, D017) | `threejs-*` | POC isolé seulement (§ 6.4) |
| Portage depuis une autre technologie | Aucune | `remotion-to-hyperframes` | `remotion-best-practices` | Principes uniquement (§ 5) |
| Navigateur, interface | E2E `@playwright/test` (`apps/studio/tests`) | `hyperframes-cli` (aperçu) | `playwright-cli` | Débogage interactif ; les tests restent versionnés |
| Mesures média | `packages/video` (`probe`, `deterministicChecks`, PNG, PSNR) et `packages/audio` (`probeAudio`, `analyzeAudio` ebur128/astats/silencedetect, `detectOnsets`) | `media-use` (mixage, sons) | `ffmpeg-skill`, `qc-skill` | Veyra reste la source mesurée de la QA ; les outils externes servent de contre-mesure manuelle |
| Mixage, multiplexage | `buildMixArgs`, `mixToWav`, `muxAudio` | `media-use` | `ffmpeg-skill/audio.py`, `audio-production-skill` | Doublon : ne pas utiliser en production |
| Édition de rushes | Hors périmètre (pas de rushes) | — | `ffmpeg-skill` (cut/join/fit…), `video-editing-skill` | Non applicable |

Des skills sont sans objet pour Veyra : `gsap-react` et `threejs-react-three-fiber` (le Studio est en Svelte, les compositions en HTML pur), `gsap-scrolltrigger` (pas de défilement dans un rendu), `gsap-frameworks` (utile seulement pour une animation de l'interface Svelte).

## 5. Règles d'usage par skill

- **GSAP (2D, choix par défaut)** : charger `gsap-core` et `gsap-timeline` avant de modifier `packages/motion/src/components.ts` ou `packages/hyperframes-adapter/src/compose.ts`. Les règles HyperFrames priment :
  - une timeline en pause, enregistrée en dernier ;
  - des positions en secondes absolues ;
  - pas de `repeat: -1` ;
  - un hasard seulement s'il est initialisé ;
  - les éléments `.clip` ne sont pas animés.

  `gsap-plugins` (SplitText, DrawSVG…) n'est utilisable qu'avec une copie locale du plugin, versionnée comme `gsap.min.js`, et après une décision.
- **Three.js (3D seulement)** : uniquement si la scène l'exige (objet ou produit en 3D, caméra en 3D). Il faut d'abord un POC isolé, approuvé et rendu sous bwrap. Pas d'ajout de `three` aux `package.json` avant cela.
- **remotion-best-practices** : lire pour les principes transposables (découpage en séquences, durées en images, polices et médias chargés avant le rendu, sous-titres). Ne jamais générer de composant React ou Remotion, ni d'appel `@remotion/*`.
- **playwright-cli** : sessions nommées (`-s=veyra`) sur un Studio local lancé avec `VEYRA_AI_PROVIDER=fake`, une base et un dossier de projets temporaires. Usages : reproduire un bug d'interface, inspecter la console, préparer un futur test E2E. Il ne remplace pas les E2E et ne doit pas servir sur un service externe. Lancer depuis un dossier temporaire, à cause des fichiers `.playwright-cli/`.
- **ffmpeg-skill** : inspection manuelle d'un rendu (`probe.py`, `check.py --platform`, `loudness.py --measure`, `silence.py --list`, `scenes.py`), avec `python3 -B -E -s`, sur des copies ou en lecture seule. Ne jamais l'appeler depuis le code Veyra.

## 6. Validations réalisées

### 6.1 GSAP compatible avec HyperFrames (rendu réel)

POC hors dépôt (`scratchpad/gsap-poc`) :

- HTML de 640×360, 2 s, GSAP 3.14.2 local ;
- `hyperframes lint` sans erreur (0 erreur, 0 avertissement), puis `render` sous `bwrap --unshare-net`, avec `/usr/bin` en tête du `PATH` (§ 2) ;
- deux titres « mot par mot » identiques, à 0,3 s :
  - A suit le motif actuel de `compose.ts` : `fromTo` avec stagger et `immediateRender:false` ;
  - B suit la règle de `gsap-core` : `immediateRender` par défaut (`true`) pour `fromTo`.

Mesure de luminance moyenne de chaque moitié, images 0 à 24 (16 = fond noir) :

| Image | 0 à 9 | 10 à 12 | 13 à 24 |
|---|---|---|---|
| A (motif Veyra) | **44** (titre entier visible) | 39 → 41 (mots masqués un à un) | 31 → 40 (révélation) |
| B (motif gsap-core) | 16 (rien) | 17 → 18 | 20 → 40 (révélation progressive) |

La planche d'images confirme le résultat :

- A affiche le titre complet, puis chaque mot disparaît au début de son tween et revient. C'est le « flash » de T095 ;
- B reste vide jusqu'à 0,3 s.

Cause de T095 : avec `immediateRender:false`, l'état « from » n'est appliqué qu'au début de chaque tween décalé. Avant ce moment, le mot conserve son style CSS (visible).

**Corrigé le 2026-11-03** : `immediateRender: true` sur les entrées des composants (`compose.ts`), règle dans [MOTION-ENGINE](../video/MOTION-ENGINE.md). Pixels de texte (Y > 230) mesurés sur des rendus réels de 960×540 :

| Composant | Ancien : frame 0 → frame 15 | Corrigé : frames 0 à 6 → frame 15 → stable | Après un saut fin → 0,1 s → 0 s |
|---|---|---|---|
| `animated-title` | 13 493 → 6 701 (flash puis retrait) | 0 → 262 → 14 341 | ancien : 14 453 / 14 453 ; corrigé : 0 / 0 |
| `feature-cards` | 1 767 → 4 200 (double entrée) | 0 → 3 222 → 5 123 | ancien : 2 462 / 2 494 ; corrigé : 0 / 0 |
| `call-to-action` | 8 293 (bouton avant le titre) → 6 703 | 0 à 19 → 6 552 → 14 745 | ancien : 8 432 / 8 432 ; corrigé : 0 / 0 |

Les sauts sont faits avec `hyperframes snapshot --at <fin>,0.1,1,0`. La même cause expliquait la double entrée des cartes et le bouton affiché avant le titre de T096 (planches vérifiées). Test de non-régression : `entry-state.slow.test.ts`.

Si `immediateRender` est réactivé, vérifier le cas que `gsap-core` signale : plusieurs `fromTo` sur la même propriété d'un même élément. C'est le cas pour la sortie, mais elle vise `.stage`, une autre cible.

### 6.2 Outils FFmpeg utiles

`ffmpeg-skill doctor` avec FFmpeg 9.0.2 :

- **utilisables** (17) : `audio`, `batch`, `check`, `color`, `cut`, `export`, `join`, `look`, `loudness`, `metadata`, `probe`, `render`, `report`, `scenes`, `silence`, `sync`, `verify` ;
- **non utilisables** (25) : libx264, `drawtext`, `subtitles` ou `boxblur` manquent ;
- `look.py` est déclaré utilisable mais **échoue** : « Default encoder for format image2 (codec png) is probably disabled ». Le diagnostic du doctor est faux sur ce point.

Comparaison sur la même vidéo (V1 du banc A/B, `veyra-skills-lab/review/V1/V1.mp4`) :

| Mesure | Veyra / FFmpeg direct | ffmpeg-skill 3.1.1 | Commentaire |
|---|---|---|---|
| Durée, format | 20,000 s, h264 1920×1080, 30/1, AAC 48 kHz (QA Veyra) | identique (`probe.py`, 0,04 s) ; ajoute profil, `bt709`, VFR = non | Doublon ; plus de détail de couleur |
| Sonie intégrée | −31,3 LUFS, pic −7,6 dBTP (ebur128, banc A/B) | −31,65 LUFS, −7,65 dBTP, LRA 14,2 (`loudnorm`, 0,34 s) | Écart de 0,35 LU entre deux filtres (`ebur128` et `loudnorm`), et non une erreur |
| Conformité de diffusion | Contrôle « Niveau sonore » en échec mineur | `check.py --platform youtube` : 11 réussis, 1 échec (loudness −14 ± 2), 1 avertissement (pas de sous-titres), 0,35 s | **Nouveau** : profils YouTube, Reels, TikTok… |
| Silences | `silencedetect` (QA audio) | `silence.py --list` : 9 « silences » sur 20 s (7,9 s) | Calibré pour la parole : creux de musique comptés comme silences ; peu utile |
| Coupes | — | `scenes.py` : 1 scène sur 20 s | Les transitions Veyra sont des fondus ; `scdet` (seuil 8) ne voit aucune coupe dans V1 et V2 |

### 6.3 Playwright CLI sur le Studio

Studio `vite preview` sur le port 4310, `VEYRA_AI_PROVIDER=fake`, base et projets dans le dossier temporaire. Résultats avec `playwright-cli` 0.1.21 :

- `open http://localhost:4310/` : page « Veyra Studio », instantané d'accessibilité (champ « Nom du projet », bouton « Nouveau projet ») ;
- `fill` et `click` créent un projet et redirigent vers `/projects/prj_…` ;
- `goto /components`, `screenshot` ;
- `console` : 0 erreur, 0 avertissement ;
- `close`. Serveur arrêté ensuite.

### 6.4 Three.js : prérequis, sans dépendance ajoutée

- `three` n'est pas une dépendance du dépôt. Les skills visent r181 à r186 (`three@0.186.0`) ; npm propose 0.187.0.
- Selon `hyperframes/references/runtimes.md`, HyperFrames pilote Three.js depuis un écouteur `hf-seek` (`e.detail.time`). Les préparations lourdes s'annoncent par `window.__hf.buildReady[...]`.
- Prérequis d'un POC :
  - copie locale épinglée de `three.module.js`, comme `gsap.min.js` (pas d'accès réseau sous bwrap) ;
  - rendu WebGL dans le Chrome headless HyperFrames sous bwrap, **non vérifié** ;
  - composant du registre avec paramètres validés par Zod, sans code écrit par le LLM ;
  - mesure du temps de rendu.
- Aucun POC lancé : il attend une approbation.

## 7. ffmpeg-skill face à l'Audio Engine et au Video QA

À reprendre sous forme de mesures dans Veyra, réécrites en TypeScript et non par appel au skill :

1. **Profils de diffusion** (`check.py --platform` et `templates/*.json`) : cibles de sonie, durée, rapport d'aspect, codec et pic vrai par plateforme. Option v0.4 : un contrôle « Diffusion » consultatif dans le Video QA, avec cibles en configuration.
2. **Balises de couleur et VFR** (`probe.py`) : vérifier `bt709` et `color_range`, signalés par `check.py`.
3. **Normalisation de sonie** (`loudness.py`, `loudnorm` en deux passes) : elle correspondrait au contrôle « Niveau sonore » en échec sur les six vidéos du banc A/B (−26 à −31 LUFS). Elle relève de l'Audio Engine (`mixToWav`), avec cible en `config/audio.yaml`. `loudnorm` est déjà identifié comme bibliothèque réutilisable (OPENMONTAGE-EVALUATION).

Non retenus :

- `silence.py` : parole ;
- `scenes.py` : coupes franches ;
- l'édition de rushes ;
- les sous-titres, à reconsidérer si une voix off est ajoutée ;
- le serveur MCP, qui expose 42 outils d'écriture.

## 8. Candidats kajisho5 : qc-skill, video-editing-skill, audio-production-skill

Dépôts clonés sans exécution dans `/home/user/project/kajisho5-lab/` (`git checkout` sans hooks). Les trois sont sous licence MIT (© 2026 kajisho5), en Python ≥ 3.9 sans dépendance déclarée (`dependencies = []`). Tous sont mis à jour le 2026-10-31.

### 8.1 Fiche par dépôt

| | qc-skill | video-editing-skill | audio-production-skill |
|---|---|---|---|
| Version / commit | v0.2.6 / `a53c30d` | v0.4.2 / `f3e4ac4` | v0.4.8 / `b16666f` |
| Taille | 6 650 lignes (`src/`), 31 fichiers de test | 4 032 lignes, 11 fichiers de test | 3 031 lignes, 8 fichiers de test |
| Interface | CLI `qc contract|doctor|run <request.json>` ; requêtes JSON typées | CLI `video-editing`, requêtes d'édition typées | CLI `audio-production`, requêtes typées |
| Lien avec ffmpeg-skill | **Indépendant** : appelle `ffprobe` et `ffmpeg` lui-même ; reprend seulement l'heuristique VFR | **Dépendant** : appelle les scripts `cut`, `join`, `fit`… ; version minimale 0.10.0, comportements selon la version | **Dépendant** : `probe`, `audio`, `cut`, `loudness`, `join` ; contrats 1.0 et 2.0 acceptés ; journal : « accept ffmpeg-skill 3.0.0 (contract_version 2.0) » |
| Compatibilité avec ffmpeg-skill 3.1.1 installé | Sans objet | Version acceptée (≥ 0.10.0). **Inopérant ici** : ses opérations vidéo exigent libx264 (« h264 (libx264…) fixed_by_engine »), absent de FFmpeg 9.0.2, et ffmpeg-skill refuse FFmpeg 5.1 | Contrat 2.0 accepté (3.1.1 déclare `CONTRACT_VERSION = "2.0"`). Encodeur requis `pcm_s16le`, disponible |
| Recherche de ffmpeg-skill | — | Variable d'environnement, puis `~/.claude/skills/ffmpeg-skill`, `./vendor`, `../ffmpeg-skill`. **Ne trouve pas** `.agents/skills/ffmpeg-skill` sans variable. | Variables `AUDIO_PRODUCTION_FFMPEG_SKILL_DIR` ou `VIDEO_AGENT_FFMPEG_SKILL_DIR` |
| Sécurité (lecture du code) | Arguments en liste, `-protocol_whitelist file`, groupe de processus tué au délai, chemins confinés (`PathPolicy`, `--allowed-input-root`), requêtes refusant `command`, `argv`, `shell`, `filter`… | Arguments en liste vers les scripts ffmpeg-skill, validation des extensions et chemins (`paths.py`) | `security.py` : chemins confinés ; exécution déléguée à ffmpeg-skill |
| Réseau | Aucun appel trouvé | Aucun | Aucun |

### 8.2 Capacités réellement implémentées (lecture du code)

**qc-skill**

- `inspect`, `check` et `validate` sur cinq types : `video`, `audio`, `subtitle`, `delivery`, `delivery_package`.
- 47 codes de constat, lus dans `rules.py`. Mesures FFmpeg :
  - `blackdetect`, `freezedetect`, `signalstats` (YMIN/YMAX) ;
  - `scdet` ;
  - `ebur128` et `astats` ;
  - `silencedetect` ;
  - `ssim` et `psnr` ; `libvmaf` si disponible.
- Lisibilité de texte (`text_legibility.py`) : sur des zones fournies par l'appelant, une image est décodée en `rawvideo` RGB24. Le seuil d'Otsu sépare l'encre du fond, puis le script calcule le contraste WCAG 2.x et la hauteur d'encre ramenée à 1080 p, sans OCR.
- Photosensibilité : flashs généraux selon ITU-R BT.1702 ; flash rouge rendu `UNKNOWN`.

**video-editing-skill**

- Opérations : TRIM, CUT, CONCAT (avec transitions), SPEED, FIT, FILL, RESIZE, OVERLAY (images fixes seulement), ROTATE, FREEZE, REVERSE, IMAGE_INSERT, CROP.
- Non pris en charge : POSITION (placement libre d'un calque vidéo), REORDER, TRANSITION séparée.

**audio-production-skill**

- Opérations : GAIN, TRIM, CUT, SILENCE_REMOVE, FADE_IN, FADE_OUT, NORMALIZE, MIX (avec atténuation automatique optionnelle de la musique sous la voix), MONO, STEREO, DOWNMIX, NOISE_REDUCTION, DYNAMICS, VOICE_CLEANUP, FILLER_REMOVE, CONCAT.
- Non pris en charge : CHANNEL_MAP, RESAMPLE.

### 8.3 Matrice des capacités et doublons

| Capacité | Veyra | ffmpeg-skill 3.1.1 | qc-skill | audio-prod. | video-edit. | Bilan |
|---|---|---|---|---|---|---|
| Durée, codec, résolution, fps, CFR | ✔ `deterministicChecks`, `frames.ts` | ✔ | ✔ | — | — | **Doublon exact** |
| Écrans noirs | ✔ `black-frames` | — | ✔ | — | — | Doublon |
| Images figées | — | — | ✔ `freezedetect` | — | — | Nouveau, mais inadapté en l'état (voir mesure) |
| Plage de luminance légale | — | — | ✔ `signalstats` | — | — | **Nouveau** ; V1 à V6 vont de Y 0 à 254–255 : utile pour la diffusion TV, secondaire pour le web |
| Photosensibilité (BT.1702) | — | — | ✔ | — | — | **Nouveau, gain réel** : risque d'accessibilité pour du motion design |
| Contraste et taille du texte (zones) | `check` HyperFrames (contraste AA, ≥ 28 px) sur le DOM, avant rendu | — | ✔ sur l'image rendue | — | — | **Complément** : mesure après rendu, sur dégradé et animation |
| Coupes attendues | — | `scenes.py` | ✔ `expected_cuts` | — | — | Inadapté : fondus, 0 coupe détectée |
| SSIM / PSNR / VMAF | PSNR (`compareFrames`, par image) | — | ✔ (VMAF absent de FFmpeg 9.0.2) | — | — | SSIM nouveau ; doublon partiel |
| Sonie, pic vrai, écrêtage, silences | ✔ `analyzeAudio` | ✔ | ✔ | ✔ (normalisation) | — | **Doublon** |
| Synchronisation audio sur événements visuels | ✔ `detectOnsets` et ancres | `sync.py` (micro externe) | — | — | — | Veyra seul couvre le besoin |
| Mixage, fondus, multiplexage | ✔ `mixToWav`, `muxAudio` | ✔ | — | ✔ | — | **Doublon** ; Audio Engine conservé |
| Normalisation de sonie | Non (contrôle seul) | ✔ | — | ✔ | — | Manque Veyra, à implémenter dans l'Audio Engine (§ 7) |
| Débruitage, dynamique, nettoyage de voix | — | ✔ (libx264 non requis pour l'audio) | — | ✔ | — | Nouveau, utile seulement avec une voix off enregistrée |
| Profils de diffusion | — | ✔ | ✔ (`delivery`) | — | — | Nouveau (§ 7) |
| Édition de rushes | Hors périmètre | ✔ | — | — | ✔ | Non applicable |

### 8.4 Mesures complémentaires sur les mêmes médias

Les six vidéos du banc A/B (V1 à V6) ont été mesurées par moi avec les filtres FFmpeg qu'utilise qc-skill. Ce ne sont **pas** des sorties de qc-skill :

- `freezedetect` (bruit 0,001, durée 1 s) : 4 à 5 « gels » par vidéo, 7 à 9 s sur 20 s. Ce sont les maintiens voulus du motion design. Un seuil `VIDEO_FREEZE_EXCEEDED` utile demanderait une tolérance par scène, issue du storyboard.
- `signalstats` : Y min 0, Y max 254–255 sur les six vidéos (balise `tv`, donc des valeurs hors de 16–235).
- `scdet` (seuil 8) : aucune coupe dans V1 et V2.

### 8.5 Installation et test réel

> **Mise à jour du 2026-11-03** : POC qc-skill réalisé à la demande de l'utilisateur, sans `pip install`, depuis le clone figé, sous bwrap (`--unshare-all`, système en lecture seule, environnement vidé). Résultats et proposition d'intégration : [QC-SKILL-POC](../research/QC-SKILL-POC.md). video-editing-skill et audio-production-skill n'ont été ni installés ni exécutés. Ce qui suit décrit la situation du 2026-11-02.

L'installation des trois paquets dans des venv isolés hors dépôt (`pip install --no-deps` depuis les clones) a été **refusée par le classifieur de permissions** de Claude Code (« Code from External »). Aucun de leurs codes n'a été exécuté. Il n'y a donc **ni installation, ni version figée en place, ni test de fonctionnement réel** : les sections 8.1 à 8.3 reposent sur la lecture du code.

Pour poursuivre (qc-skill d'abord), il faut l'accord explicite de l'utilisateur, puis :

1. `python3 -m venv /home/user/project/kajisho5-lab/venv-qc` et `pip install --no-deps /home/user/project/kajisho5-lab/qc-skill`, au commit `a53c30d` ;
2. lancer `qc doctor --json`, puis `qc run` sous `bwrap --unshare-net`, avec `--allowed-input-root` sur une copie des vidéos du banc ;
3. faire une requête `check` vidéo avec `check_photosensitivity`, `max_*_luminance_excursion_sec`, des `text_regions` (accroche, appel à l'action) relevées sur les storyboards, et une requête audio avec une cible de sonie ;
4. comparer avec les mesures Veyra ci-dessus et avec le `check` HyperFrames (contraste du DOM).

### 8.6 Recommandation par dépôt

| Dépôt | Usage proposé | Coût d'un adaptateur |
|---|---|---|
| **qc-skill** (POC prioritaire) | D'abord un **outil CLI de développement**, hors pipeline : contre-expertise manuelle d'un rendu (photosensibilité, contraste sur zones). Si le gain est démontré, **réécrire en TypeScript** les deux mesures utiles (BT.1702, contraste WCAG d'une zone) dans `packages/video`, comme contrôles mesurés de la QA. Pas d'appel Python depuis le Studio. | Adaptateur Python→TS (sous-processus, schéma JSON, chemins confinés, bwrap) : environ 300 à 500 lignes et tests. Suivre les 47 codes d'une version 0.x mise à jour plusieurs fois par semaine. **Élevé.** La réécriture ciblée (photosensibilité et contraste) coûte moins cher à maintenir. |
| **video-editing-skill** | Aucun pour l'instant. Possible plus tard comme **skill Claude Code** si Veyra accepte des rushes importés. | Dépendant de ffmpeg-skill et de libx264, double contrainte FFmpeg (§ 2). **Élevé**, sans besoin actuel. |
| **audio-production-skill** | Non retenu. À réévaluer comme **skill Claude Code** si une voix off enregistrée par l'utilisateur doit être nettoyée (NOISE_REDUCTION, VOICE_CLEANUP, FILLER_REMOVE). L'Audio Engine reste la référence. | Dépendant de ffmpeg-skill ; doublon du mixage. **Moyen**, pour un gain faible aujourd'hui. |

Aucun de ces outils n'est intégré au pipeline de production. Une installation comme skill Claude Code ne vaudrait pas intégration applicative.

## 9. Matrice agent → skills → contexte

Les agents métier Veyra sont des fonctions déterministes ou des appels `AiProvider` : ils ne chargent pas de skills. La matrice concerne la session Claude Code qui travaille sur le domaine de chaque agent.

| Agent / domaine | Skill Veyra (toujours en premier) | Skills externes à la demande | Contexte de chargement |
|---|---|---|---|
| Director, orchestration | `prompt-to-video` | — | — |
| Motion Agent, composants | `prompt-to-video`, `video-rendering`, MOTION-ENGINE | `gsap-core`, `gsap-timeline` ; `gsap-utils` (interpolation, `snap`) ; `gsap-performance` en cas de lenteur de rendu | Modification de `packages/motion` ou `compose.ts`, correction de T095 à T097 |
| Motion Agent, 3D | idem | `threejs-fundamentals` puis le skill ciblé (`-materials`, `-lighting`…) | POC 3D approuvé uniquement |
| Rendu | `video-rendering` | `hyperframes`, `hyperframes-cli` | Panne de rendu, `lint`/`check` |
| Audio Agent, Audio Engine | `audio-production`, `audio-mixing` | `ffmpeg-skill` (`loudness.py --measure`, `probe.py`) | Contre-mesure manuelle, préparation de la normalisation |
| Review Agent | `video-review` | — | — |
| Video QA Expert | `video-quality-assurance`, `audio-mixing` | `ffmpeg-skill` (`check.py --platform`, `probe.py`) ; qc-skill après POC | Contre-expertise d'un rendu, jamais dans le QA automatique |
| Studio (interface) | — | `playwright-cli` | Débogage d'un parcours, préparation d'un E2E |
| Traitement assisté | `veyra-assisted-task` | Aucun : n'écrire que `result.json` (D010) | — |
| Revue de portage | — | `remotion-best-practices`, `remotion-to-hyperframes` | Lecture de principes seulement |

## 10. Chargement à la demande

Coût permanent mesuré : chaque skill découvert ajoute sa description au contexte de chaque session.

| Groupe | Skills | Description (caractères) |
|---|---|---|
| `threejs-*` | 13 | 3 713 |
| `gsap-*` | 8 | 2 595 |
| HyperFrames (copies locales) | 7 | 2 021 |
| Veyra | 7 | 1 417 |
| `ffmpeg-skill` | 1 | 926 |
| `playwright-cli`, `remotion-best-practices` | 2 | 107 |

Le corps d'un skill (4 à 30 Ko) n'est lu que lorsqu'il est invoqué.

**Vérifié le 2026-11-03** sur le journal de la session de l'audit (`~/.claude/projects/…/e95b4e58-….jsonl`), qui couvre l'audit, la recompilation de FFmpeg, T095 et le POC :

- appels à l'outil Skill : `route` ×2 et `claude-api` ×1 ;
- corps de skill chargés : `route`, `claude-api` et `ui-ux-pro-max` (plugin) ;
- **aucun** corps de skill `gsap-*`, `threejs-*`, `ffmpeg-skill`, `playwright-cli` ou `remotion-best-practices` n'a été chargé. Seules leurs descriptions figurent dans la liste de session. Leurs fichiers ont été lus ponctuellement (`grep`, `head`) pour l'audit.

Règles :

1. Charger le skill Veyra du domaine, puis **un seul** skill externe ciblé : `gsap-core` ou `gsap-timeline`, jamais les huit. Ouvrir une référence secondaire (`ffmpeg-skill/references/*`, `remotion-best-practices/*/REFERENCE.md`) seulement pour une question précise.
2. Ne jamais charger un skill externe dans `veyra-assisted-task`.
3. Pour `ffmpeg-skill`, `--help` du script avant `references/scripts.md`.
4. Réduire le coût permanent, au choix de l'utilisateur, sans réécrire les skills :
   - désinstaller les skills sans objet (`gsap-react`, `gsap-scrolltrigger`, `gsap-frameworks`, `threejs-react-three-fiber`) ;
   - ou déplacer `threejs-*` au niveau utilisateur, hors projet, jusqu'à un POC 3D.

   Environ 4 600 caractères économisés pour les 13 `threejs-*` et 3 GSAP.
5. Supprimer la copie utilisateur obsolète de `remotion-best-practices` (§ 3.1).

## 11. Recommandations v0.4

Par ordre de priorité :

1. **FFmpeg** : recompiler FFmpeg 9.0.2 avec libx264, zlib, freetype et libass, ou revenir à la version Debian. Ensuite :
   - mettre à jour les prérequis de RUNBOOK ;
   - revérifier `test:slow`, les tests audio et vidéo, et `doctor`.
2. **T095** : fait le 2026-11-03 (§ 6.1).
3. **Normalisation de sonie** dans l'Audio Engine (`loudnorm` en deux passes, cible configurable), et contrôle « Diffusion » consultatif (profils inspirés de `check.py`).
4. **Contrôles issus du POC qc-skill** (T104) : photosensibilité et contraste mesuré sur l'image, réécrits en TypeScript dans `packages/video` ([QC-SKILL-POC § 6](../research/QC-SKILL-POC.md#6-proposition-dintégration-au-video-qa-expert)).
5. **Three.js** : optionnel ; POC seulement sur un besoin créatif concret.
6. Faire le ménage dans les skills sans objet (§ 10).

## 12. Fichiers et versionnement

- Les dossiers des skills externes sont ignorés par Git (`.gitignore`) : `gsap-*`, `threejs-*`, `playwright-cli`, `remotion-best-practices`, `ffmpeg-skill`, comme les copies HyperFrames. Seuls les skills Veyra sont versionnés.
- Les dépôts kajisho5 sont dans `/home/user/project/kajisho5-lab/`, hors dépôt, conservés pour le POC.
- Aucun skill externe n'a été réécrit. Ni le moteur vidéo ni les migrations n'ont été modifiés.
