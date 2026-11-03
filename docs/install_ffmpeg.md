# Trace d'installation — FFmpeg 9.0.2

> Première installation le **2026-11-02 vers 19:20 UTC** (configuration par défaut),
> puis **recompilation le 2026-11-02 vers 23:20 UTC**. La première version manquait
> des bibliothèques nécessaires à Veyra (section 1).

## 1. Pourquoi une recompilation

La première compilation avait été faite avec `./configure` sans option, en licence LGPL. Il lui manquait :

- **libx264** : HyperFrames et `muxAudio` encodent ou copient du H.264 ;
- **l'encodeur PNG** (zlib absent) : `packages/video` extrait des images PNG pour la QA ;
- **les filtres `drawtext`, `subtitles`/`ass`, `boxblur`, `hqdn3d`, `cropdetect`, `vidstab*`**, utilisés par ffmpeg-skill.

Comme `/usr/local/bin` précède `/usr/bin` dans le `PATH`, Veyra utilisait ce binaire. Résultat :

| Commande | Résultat |
|---|---|
| `pnpm --filter @veyra/hyperframes-adapter test:slow` | 2 échecs (`hyperframes.mjs render exited 1`) |
| `pnpm --filter @veyra/audio test` | 3 échecs sur 19 |
| `pnpm --filter @veyra/video test` | Échec du fichier de test |
| `ffmpeg-skill doctor` | 17 outils sur 42 |

FFmpeg 5.1.9 de Debian (`/usr/bin`) ne convient pas non plus : ffmpeg-skill 3.x exige FFmpeg ≥ 6.1. Détails : [SKILLS-STRATEGY § 2](ai/SKILLS-STRATEGY.md#2-blocage-ffmpeg-constaté-à-traiter-en-premier).

## 2. Environnement

| Élément | Valeur |
|---|---|
| Système | Debian GNU/Linux 12 (bookworm), x86_64 |
| Cœurs | 4 |
| Compilateur | gcc 12.2.0 (Debian 12.2.0-14+deb12u1) |
| Make | GNU Make 4.3 |
| Assembleur | nasm 2.16.01 (installé par `apt` lors de la première compilation) |
| Sources et compilation | `/home/user/ffmpeg-9.0.2` (fichier `VERSION` : 9.0.2 ; 935 Mo une fois compilé) |

## 3. Dépendances de compilation (Debian, `apt`)

```bash
sudo apt-get install -y pkg-config zlib1g-dev libx264-dev libx265-dev \
  libfreetype-dev libfontconfig-dev libfribidi-dev libharfbuzz-dev libass-dev \
  libmp3lame-dev libopus-dev libvidstab-dev
```

`libvmaf-dev` n'existe pas dans bookworm : le filtre `libvmaf` est donc absent.

## 4. Étapes exécutées

```bash
cd /home/user/ffmpeg-9.0.2
make distclean
./configure --prefix=/usr/local --enable-gpl \
  --enable-libx264 --enable-libx265 \
  --enable-libfreetype --enable-libfontconfig --enable-libfribidi --enable-libharfbuzz --enable-libass \
  --enable-libmp3lame --enable-libopus --enable-libvidstab
make -j4                                   # 203 s
sudo make install                          # remplace /usr/local/bin/ffmpeg et ffprobe
```

Contrôlé dans `ffbuild/config.mak` après `configure` : `CONFIG_ZLIB`, `CONFIG_PNG_ENCODER`, `CONFIG_LIBX264`, `CONFIG_LIBASS`, `CONFIG_LIBFREETYPE`, `CONFIG_DRAWTEXT_FILTER`, `CONFIG_SUBTITLES_FILTER` et `CONFIG_VIDSTABDETECT_FILTER` valent `yes`.

### Incidents

1. **`sudo` exige un mot de passe**, impossible à saisir depuis la session Claude Code, même avec le préfixe `!` : il n'y a pas de terminal. L'utilisateur a lancé `apt-get install` et `make install` dans son propre terminal.
2. Une première compilation avec `--prefix=$HOME/.local` a été abandonnée au profit de `/usr/local`. Ce choix remplace directement le binaire défectueux et ne dépend pas de la place de `~/.local/bin` dans le `PATH`.

## 5. Licence

`--enable-gpl` (requis par libx264, libx265 et vidstab) rend le binaire **GPL version 2 ou ultérieure** : c'est ce qu'affiche `configure`. C'est sans conséquence pour un usage local. À documenter si Veyra distribue un jour FFmpeg avec ses binaires : Veyra appelle `ffmpeg` comme programme externe, sans édition de liens.

## 6. Résultat

| Composant | Emplacement |
|---|---|
| `ffmpeg` | `/usr/local/bin/ffmpeg` (24,7 Mo, root:root, 2026-11-02 23:22) |
| `ffprobe` | `/usr/local/bin/ffprobe` (24,5 Mo) |
| Bibliothèques statiques | `/usr/local/lib/libav*.a`, `libsw*.a` |
| Pages de manuel | `/usr/local/share/man/man1/` |

Contenu : 187 encodeurs, 521 décodeurs, 480 filtres, 414 formats. Les plus utiles pour Veyra :

- **Encodeurs** : `libx264`, `libx265`, `png`, `aac`, `libmp3lame`, `libopus`.
- **Filtres** : `drawtext`, `subtitles`, `ass`, `boxblur`, `hqdn3d`, `cropdetect`, `vidstabdetect`, `vidstabtransform`, `loudnorm`, `ebur128`.

Versions des bibliothèques : libavutil 61.1.102, libavcodec 63.1.102, libavformat 63.1.102, libavdevice 63.1.102, libavfilter 12.1.102, libswscale 10.1.102, libswresample 7.1.102.

## 7. Vérifications (2026-11-02, après `make install`)

| Commande | Résultat |
|---|---|
| `which ffmpeg ffprobe` | `/usr/local/bin/ffmpeg`, `/usr/local/bin/ffprobe` (9.0.2) |
| Encodage `testsrc → libx264` et écriture d'une image PNG | Réussis |
| `pnpm --filter @veyra/hyperframes-adapter test:slow` (rendu réel sous bwrap) | 2 réussis |
| `pnpm test` | Tous réussis (schemas 318, storage 10, motion 13, video 6, ai 41, adaptateur 18, audio 19, studio 69) |
| `pnpm check`, `pnpm lint` | 0 erreur, 0 avertissement ; Prettier conforme |
| `pnpm --filter studio test:e2e` | **6 réussis** (2,3 min), après correction du test ci-dessous |
| `python3 -B .agents/skills/ffmpeg-skill/scripts/_contract.py doctor --json` | `ok: true`, **42 outils sur 42** ; optionnels manquants : `libsvtav1`, `libvorbis`, `zscale`, whisper, parakeet |
| `ffmpeg-skill/scripts/look.py` (planche d'images) | Réussi (échouait sans encodeur PNG) |

**Test E2E corrigé** (`apps/studio/tests/v03-audiovisual.e2e.ts`). Avec le nouveau binaire, le test `audiovisual pipeline…` échouait systématiquement : un seul fichier audio importé sur deux. Il réussissait avec `/usr/bin` en tête du `PATH`.

La cause n'est pas FFmpeg : c'est une course dans le test.

1. `use:enhance` vide le formulaire après un import réussi.
2. Le test choisissait le second fichier avant la fin du premier import.
3. Le second envoi partait donc avec un champ fichier vide, bloqué par `required`.

L'import direct par l'action `?/importAudio` réussissait pour les deux fichiers. Le test attend désormais chaque import avant le suivant : réussi deux fois seul, puis dans la suite complète.

## 8. Maintenance

- **Recompiler** : relancer les commandes de la section 4 (après `make distclean`), puis les vérifications de la section 7.
- **Désinstaller** : `sudo make -C /home/user/ffmpeg-9.0.2 uninstall`. Le FFmpeg 5.1.9 de Debian (`/usr/bin`) redevient alors celui du `PATH`, et ffmpeg-skill ne fonctionne plus.
- Conserver `/home/user/ffmpeg-9.0.2` pour recompiler sans retélécharger les sources.
- Prérequis de Veyra : [RUNBOOK](RUNBOOK.md) (libx264 et encodeur PNG obligatoires).
