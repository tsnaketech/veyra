# Pipeline audio — v0.3 Phase B

`@veyra/audio` est un moteur déterministe. Il consomme des fichiers existants et
les contrats de `@veyra/schemas`. Aucun agent ne lance de commande libre ; aucune
intégration DB ou UI n'est ajoutée ici. FFmpeg/ffprobe et prlimit sont requis.

## Validation et configuration

`probeAudio(path, limits)` refuse les chemins absents, répertoires et liens
symboliques, vérifie la taille, lit les métadonnées avec ffprobe/Zod puis décode
entièrement le premier flux audio avec FFmpeg. Une sortie d'erreur de décodage,
même avec un code de retour zéro, rend le fichier invalide.

`config/audio.yaml` et `configSchemas.audio` définissent les formats autorisés
(WAV, MP3, FLAC, Ogg, famille MOV/MP4/M4A, AIFF), 100 Mio par source, 600 secondes,
60 secondes CPU et 120 secondes de temps réel par processus. Le format est celui
annoncé par ffprobe, pas l'extension ; ses alias MOV/MP4 sont reconnus. Le moteur
utilise `maxDurationMs` : convertir `maxDurationSeconds` à l'appel.

| Code `AudioMediaError` | Signification |
|---|---|
| `missing` | Fichier absent, non régulier ou lien symbolique |
| `too-large` | Taille supérieure à la limite |
| `unsupported-format` | Conteneur hors liste autorisée |
| `no-audio-stream` | Aucun flux audio |
| `too-long` | Durée supérieure à la limite |
| `decode-failed` | Métadonnées illisibles ou décodage en erreur ; `stderrTail` conservé et borné |

## Résolution et mixage

`resolveAudioComposition` est pur : composition, événements, assets validés et
durée vidéo donnent des pistes résolues et des problèmes de synchronisation.
Les [règles d'ancrage](../ai/MULTI-AGENT-ARCHITECTURE.md) restent la référence.
La durée vidéo explicite fournit la borne, même sans scène visuelle. Une piste
inrésolue est omise avec son problème ; un asset absent donne `asset-missing`,
un point d'entrée hors source `source-exhausted`, un départ à la fin ou après la
vidéo `after-end`. Les erreurs doivent être présentées avant de valider un rendu.

Sans durée explicite, la piste lit la source restante ; la durée planifiée est
bornée à la fin vidéo. Une durée explicite ne prolonge pas le contenu de la source.
La musique bouclée remplit la vidéo depuis son ancrage. Les fades sont bornés à la
durée jouée ; les segments de ducking sont en millisecondes absolues de composition.

`buildMixArgs(tracks, outputWav, {...settings, videoDurationMs})` produit uniquement
des arguments. `mixToWav(tracks, out, settings, videoDurationMs)` les exécute :

```text
source → atrim(sourceIn, playMs) → asetpts → aformat(48 kHz/stéréo)
       → gain → fades → ducking → adelay(ancrage)
pistes → amix(normalize=0) → silence de fin / coupe durée vidéo
       → suréchantillonnage 192 kHz → limiteur → 48 kHz → WAV PCM 16 bits
```

Les fenêtres de ducking sont converties en temps relatif à la piste ; les gains
se cumulent si leurs fenêtres se chevauchent. Les labels de graphe sont internes,
les nombres sont validés puis formatés en décimales fixes. Aucun label utilisateur
ni chemin n'entre dans le graphe. Une composition vide produit du silence.
Le limiteur n'applique pas de gain automatique et compense sa latence. La crête
vraie du résultat reste une mesure QA, pas une garantie de mastering.

`muxAudio` mesure la durée vidéo, copie `0:v:0` sans réencodage et encode `1:a:0`
en AAC 48 kHz stéréo (192 kbit/s par défaut). Le son est complété par du silence
ou tronqué à la durée vidéo. Mixage et mux écrivent un temporaire voisin, puis
renomment après succès ; en cas d'échec, l'ancienne sortie reste intacte.

## Mesures

- `analyzeAudio` : codec, fréquence, canaux, durée, LUFS intégré et true peak
  (`ebur128`), crête et estimation des échantillons écrêtés (`astats`), silences.
- `clippedSamples` utilise le compteur explicite quand disponible ; sinon la
  somme des `Peak count` des canaux dont la crête atteint 0 dBFS. Cette estimation
  ne retrouve pas un écrêtage antérieur suivi d'une réduction de gain.
- `detectOnsets` : fins de silences, plus zéro lorsque le début est sonore ;
  seuil et durée minimale configurables. Ce sont des reprises après silence,
  pas un détecteur de transitoires musicaux.
- `meanVolumeDb` : `volumedetect` sur une plage `atrim` validée.

Un champ de mesure illisible déclenche une erreur, jamais une valeur inventée.
Une crête de silence peut être `-Infinity` : la convertir explicitement si une
future API JSON doit la transporter. Les verdicts QA sont produits par l'appelant
(voir « Audio QA »).

## Sécurité et exclusions

Les médias sont non fiables : validation complète avant placement, liste de
protocoles limitée à `file`, lancement par argv sans shell via `runProcess` de
`@veyra/video`, enveloppe prlimit CPU/taille, timeout et logs bornés. Les sorties
sont limitées par défaut à 256 Mio ; les logs à 2 Mio par processus. Les sources
restent intactes ; une sortie identique à une entrée, y compris alias par lien
physique ou parent symbolique, est refusée. Les fichiers temporaires sont privés
et nettoyés en cas d'échec. Le composant appelant doit conserver les assets dans
un espace local protégé contre les remplacements concurrents : prlimit et la
liste de protocoles ne constituent pas un bac à sable du système de fichiers.

Aucune génération audio, aucun TTS, aucune recherche réseau, aucun mastering
au-delà du limiteur. `targetLufs` est une cible QA, sans normalisation automatique.

## Intégration au rendu

- HyperFrames écrit toujours une vidéo **muette** `renders/<rnd>.video.mp4`, conservée
  dans `video_revisions.silent_video_path`. Sans piste audio, elle est copiée telle
  quelle vers `renders/<rnd>.mp4` (comportement inchangé).
- Avec une composition audio, le runner calcule `visualTimeline` (fréquence mesurée du
  rendu), résout les pistes (`resolveAudioComposition`), mixe en WAV puis multiplexe
  dans `renders/<rnd>.mp4`. Le WAV intermédiaire est supprimé.
- **Réutilisation de l'image** : si le storyboard est identique à celui de la révision
  parente, que sa vidéo muette existe (sous la racine des projets) et que la révision
  n'est pas un nouveau rendu automatique, la composition, `check` et HyperFrames ne sont
  pas relancés ; la vidéo muette est copiée (jamais référencée). Étape `reuse-video`,
  `videoReusedFrom` dans la configuration du job, contrôle « Vidéo réutilisée ».
- La résolution (pistes placées, écarts) est persistée dans la configuration du job
  (`audio`). Contrôles : « Pistes audio attendues » (`major` si une piste n'est pas
  placée, par exemple fichier absent : le rendu se termine) et « Synchronisation audio »
  (`minor` si un ancrage ne se résout pas). Aucun des deux ne déclenche de nouveau rendu
  automatique.
- Studio : `importAudio` (original exclusif, validation, refus expliqué et conservé),
  `reviseAudio` (révision enfant à storyboard identique ; la source passe
  `changes_requested`). Les corrections de mouvement et les nouveaux rendus automatiques
  conservent la bande son ; un nouveau prompt repart sans son.

## Audio QA

`audioQualityChecks` (`apps/studio/src/lib/server/jobs/audio-qa.ts`) mesure le MP4
final après mux, avec les limites `cpuSeconds`/`timeoutMs` de `config/audio.yaml`.
Seuils : section `qa` du même fichier. Aucun contrôle sans piste dans la composition.

| Contrôle | Mesure | En échec si | Sévérité |
|---|---|---|---|
| Flux audio | ffprobe | codec ≠ AAC, fréquence ou canaux ≠ `mix` | major |
| Durée audio | ffprobe | écart audio/vidéo > `durationToleranceMs` (100 ms) | major |
| Silences inattendus | `silencedetect` (`silenceNoiseDb` -50 dB, `silenceMinMs` 500 ms) | silence ≥ 500 ms à l'intérieur des plages où une piste joue | minor |
| Écrêtage | true peak `ebur128` et crête `astats` | max des deux > `clippingPeakDb` (-0,1 dBFS) | major |
| Niveau sonore | LUFS intégré `ebur128` | écart à `master.targetLufs` > `loudnessToleranceLu` (3 LU) | minor |
| Synchronisation audio — onsets | reprises après silence (`detectOnsets`) | effet `sfx` ancré sur un événement, isolé, à plus de `syncToleranceMs` (40 ms) | minor |

Ces contrôles sont `deterministic` (« Mesuré ») et ne déclenchent pas de nouveau
rendu automatique. Ne sont pas mesurés, en `not-performed` (« Non réalisé ») :

- « Écoute qualitative », toujours : aucune écoute réelle n'a lieu ; une mesure
  n'est pas une écoute et la validation humaine reste obligatoire ;
- « Synchronisation audio — onsets masqués » : effet superposé à une autre piste
  dans ±`syncToleranceMs`, aucun départ n'est déduit du mélange ;
- tous les contrôles mesurés lorsque le média est illisible (« Flux audio » en
  échec `major` porte alors la raison).

Limites : un silence volontaire de la source dans une plage jouée est signalé ;
ne pas utiliser `ebur128=framelog=quiet` (FFmpeg 5.1 y rapporte `I: 0.0 LUFS`).
Règles générales des modes : [QUALITY-STANDARDS](QUALITY-STANDARDS.md).
